// lib/subscription.js
// Stripeサブスクリプションの有効性チェックと、契約中プランの上限値の解決。
//   - api/login.js         : ログイン時のライブチェック(checkActiveSubscriptionLive)
//   - api/_auth.js の requireAuth() : 発行済みセッションの定期再チェック
//     (hasActiveSubscriptionCached、Redisキャッシュ経由)
//
// セッショントークン自体は発行時に固定された有効期限(30日)を署名検証するだけで
// Stripeには問い合わせない仕組みだったため、解約後も最大30日間アプリを使い続け
// られてしまう問題があった。requireAuth()経由でリクエストごとに再チェックする。
//
// プラン上限は Stripe の Price の metadata に持たせる（コード側にプラン表を
// 持たない）。Stripe ダッシュボードで価格を作るときに以下を設定する:
//
//   plan           ... プラン識別子の文字列（例: light / standard / pro）
//   search_limit   ... 月あたりの検索回数上限
//   case_limit     ... 同時に持てる案件数の上限
//   retention_days ... 完了/失注案件を保持する日数
//
// 数値3つはいずれも -1 で「無制限」を表す。上限に達した場合はその月は停止する
// （超過課金は行わない）。
//
// 【重要】プランごとの具体的な数値をこのファイル（およびコード全般）に書かないこと。
// 数値はStripeのPrice metadataだけを唯一の出所とする。プラン設定の変更を
// Stripeダッシュボードだけで完結させ、デプロイを不要にするための方針。

import Stripe from 'stripe';
import { redis } from './redis';
import { isAdminEmail } from './adminEmails';

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// セッション再チェックでのキャッシュ有効期間。「解約してから実際にアクセスできなく
// なるまでの最大遅延」に相当する。短くするほどStripeへの問い合わせが増え、長くする
// ほど解約後の猶予が伸びる。利用者が数名規模の運用であることを踏まえ1時間とする。
const SUBSCRIPTION_CACHE_TTL_SECONDS = 60 * 60;

// キャッシュのキー名にスキーマ版を含める。以前は同じ `subcheck:{email}` に
// boolean を素で入れていたため、デプロイ直後は旧形式(true/false)と新形式
// (オブジェクト)が最大1時間混在する。キーを分ければ新デプロイは旧データを
// 一切読まず、旧キーはTTLで自然に消える（明示的な削除処理は不要）。
// 保存する値の形を変えるときは、ここの v2 を上げること。
const CACHE_SCHEMA_VERSION = 'v2';
const subscriptionCacheKey = (email) => `subcheck:${CACHE_SCHEMA_VERSION}:${email}`;

/** 上限値の「無制限」を表す番兵。Stripeのmetadataにもこの値を書く。 */
export const UNLIMITED = -1;

/** 上限値が無制限かどうか。呼び出し側で `x === -1` を散らかさないための判定。 */
export function isUnlimited(limit) {
  return limit === UNLIMITED;
}

// metadataが1つも設定されていないPriceに当たったときの既定値。
//
// 「最下位プラン相当に絞る」ではなく「無制限」を既定にしている。理由は、既存の
// 契約(テスター3名)のPriceにはまだmetadataが無く、ここを絞り側に倒すと metadata を
// 入れ忘れたPriceの契約者がある日いきなり現場で使えなくなるため。metadataを設定
// するまでは今まで通り動き、設定した時点で上限が効き始める、という移行にする。
// 取りこぼしが黙って起きないよう、既定値を使ったときは必ずwarnログを出す。
export const DEFAULT_PLAN_LIMITS = Object.freeze({
  plan: 'unknown',
  searchLimit: UNLIMITED,
  caseLimit: UNLIMITED,
  retentionDays: UNLIMITED,
});

// 管理者(ADMIN_EMAILS)向け。管理者はStripe顧客を持たないため、そもそも契約Priceが
// 存在せず上限を引ける先が無い。login.js / _auth.js のバイパスと同じ扱いで全部無制限。
export const ADMIN_PLAN_LIMITS = Object.freeze({
  plan: 'admin',
  searchLimit: UNLIMITED,
  caseLimit: UNLIMITED,
  retentionDays: UNLIMITED,
});

/**
 * metadataの値(Stripeでは常に文字列)を上限値の数値に変換する。
 * 空・非数値・-1未満などの不正値はフォールバック値を返し、設定ミスとしてwarnを出す。
 */
function parseLimit(rawValue, key, fallback, context) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < UNLIMITED) {
    console.warn(
      `[subscription] Price ${context} の metadata.${key} が不正です（値: ${JSON.stringify(rawValue)}）。` +
        `既定値 ${fallback} を使います。0以上の整数か、無制限を表す -1 を設定してください。`
    );
    return fallback;
  }

  return value;
}

/**
 * Priceのmetadataからプランの上限値を組み立てる。
 * metadataが空のPrice（＝プラン設定前の既存Price）は DEFAULT_PLAN_LIMITS になる。
 */
function planLimitsFromPrice(price) {
  const metadata = price?.metadata || {};
  const priceId = price?.id || '(unknown price)';

  const plan = typeof metadata.plan === 'string' && metadata.plan.trim() !== ''
    ? metadata.plan.trim()
    : DEFAULT_PLAN_LIMITS.plan;

  if (plan === DEFAULT_PLAN_LIMITS.plan) {
    console.warn(
      `[subscription] Price ${priceId} に metadata.plan が設定されていません。` +
        'このアカウントは上限なしとして扱われます。Stripeダッシュボードで ' +
        'plan / search_limit / case_limit / retention_days を設定してください。'
    );
  }

  return {
    plan,
    searchLimit: parseLimit(metadata.search_limit, 'search_limit', DEFAULT_PLAN_LIMITS.searchLimit, priceId),
    caseLimit: parseLimit(metadata.case_limit, 'case_limit', DEFAULT_PLAN_LIMITS.caseLimit, priceId),
    retentionDays: parseLimit(metadata.retention_days, 'retention_days', DEFAULT_PLAN_LIMITS.retentionDays, priceId),
  };
}

/**
 * 有効なサブスクリプションから、上限値の根拠にするPriceを1つ選ぶ。
 * このアプリは1契約1アイテム前提だが、将来アドオンのアイテムが増えても
 * プラン本体を取り違えないよう、metadata.planを持つアイテムを優先する。
 */
function selectPlanPrice(subscription) {
  const items = subscription?.items?.data || [];
  const planItem = items.find((item) => item?.price?.metadata?.plan);
  return (planItem || items[0])?.price || null;
}

/**
 * メールアドレスからStripe顧客IDを解決する。見つからなければnull。
 * ログイン可否判定(checkActiveSubscriptionLive)と解約ポータル発行
 * (api/checkout.js)の両方から使う顧客解決ロジックの共通部分。
 */
export async function getStripeCustomerIdByEmail(email) {
  const customers = await stripe.customers.list({ email, limit: 1 });
  return customers.data.length > 0 ? customers.data[0].id : null;
}

/**
 * Stripeに直接問い合わせて、顧客の有無・有効なサブスク(active/trialing)の有無・
 * 契約中プランの上限値を判定する。api/login.js はcustomerFound/activeを見て別々の
 * エラーメッセージを出し分けており、requireAuth()の再チェック
 * (hasActiveSubscriptionCached)は activeだけを見る。
 *
 * 戻り値の limits は、有効なサブスクが無いときも DEFAULT_PLAN_LIMITS が入る
 * （呼び出し側で null チェックを強いないため）。activeがfalseのときは
 * そもそも上限以前にアクセスさせない前提なので、値に意味は無い。
 *
 * Stripeへの往復は customers.list と subscriptions.list の2回のまま増やさない。
 * subscriptions.list のレスポンスには items[].price がPriceオブジェクトとして
 * 最初から入っている（IDだけではない）ので、metadataを読むのに
 * prices.retrieve() の追加呼び出しも expand 指定も要らない。
 */
export async function checkActiveSubscriptionLive(email) {
  if (isAdminEmail(email)) {
    return { customerFound: true, active: true, limits: { ...ADMIN_PLAN_LIMITS } };
  }

  const customerId = await getStripeCustomerIdByEmail(email);
  if (!customerId) {
    return { customerFound: false, active: false, limits: { ...DEFAULT_PLAN_LIMITS } };
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 10,
  });

  const activeSubscription = subscriptions.data.find((sub) =>
    ['active', 'trialing'].includes(sub.status)
  );

  if (!activeSubscription) {
    return { customerFound: true, active: false, limits: { ...DEFAULT_PLAN_LIMITS } };
  }

  const price = selectPlanPrice(activeSubscription);
  const limits = price
    ? planLimitsFromPrice(price)
    : { ...DEFAULT_PLAN_LIMITS };

  return { customerFound: true, active: true, limits };
}

/** キャッシュから読んだ値が現行スキーマの形をしているか確認する。 */
function isValidCachedState(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.active === 'boolean' &&
    value.limits !== null &&
    typeof value.limits === 'object' &&
    typeof value.limits.plan === 'string' &&
    Number.isInteger(value.limits.searchLimit) &&
    Number.isInteger(value.limits.caseLimit) &&
    Number.isInteger(value.limits.retentionDays)
  );
}

/**
 * セッション再検証用。サブスクの有効性とプラン上限をRedisに短いTTLでキャッシュし、
 * キャッシュが無ければStripeに再照会する。
 *
 * Stripe/Redis自体が障害・タイムアウトした場合は「有効・上限は既定値(無制限)」と
 * みなして通す(フェイルオープン)。このアプリは電気工事士が現場作業中に使うツール
 * のため、インフラ側の一時的な不調でログイン済みユーザーを締め出す実害の方が
 * 大きいと判断。障害時の結果はキャッシュしない＝Stripeが復旧すれば次のリクエストで
 * 正しい値に切り替わる。
 *
 * @returns {Promise<{active: boolean, limits: {plan: string, searchLimit: number, caseLimit: number, retentionDays: number}}>}
 */
export async function getSubscriptionStateCached(email) {
  // 管理者はStripe顧客が無いので照会もキャッシュもせず即返す
  // (login.js / _auth.js のバイパスと同じ扱い)。
  if (isAdminEmail(email)) {
    return { active: true, limits: { ...ADMIN_PLAN_LIMITS } };
  }

  const key = subscriptionCacheKey(email);

  try {
    const cached = await redis.get(key);
    if (isValidCachedState(cached)) {
      return { active: cached.active, limits: { ...cached.limits } };
    }
  } catch (err) {
    console.error('[subscription] キャッシュ読み込みに失敗しました。Stripeへ直接照会します:', err);
  }

  let state;
  try {
    const { active, limits } = await checkActiveSubscriptionLive(email);
    state = { active, limits };
  } catch (err) {
    console.error('[subscription] Stripeへの照会に失敗しました。一時的に有効とみなします:', err);
    return { active: true, limits: { ...DEFAULT_PLAN_LIMITS } };
  }

  try {
    await redis.set(key, state, { ex: SUBSCRIPTION_CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('[subscription] キャッシュ書き込みに失敗しました:', err);
  }

  return state;
}

/**
 * サブスクが有効かどうかだけを見る従来のインターフェース。
 * api/_auth.js の requireAuth() が使う。上限値も必要な呼び出し側は
 * getSubscriptionStateCached() を直接使うこと。
 */
export async function hasActiveSubscriptionCached(email) {
  const { active } = await getSubscriptionStateCached(email);
  return active;
}
