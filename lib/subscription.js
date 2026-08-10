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
//
// 契約中サブスクリプションの請求期間(period)も併せて返す。検索回数カウンタを
// 「請求サイクル単位」で持つため、カウンタキーの一部(periodStart)とTTL(periodEnd
// までの残り時間)の算出に使う。暦月ではなく請求サイクルに合わせるのは、月の途中で
// 契約した利用者の枠が初月だけ短くなる/二重に使えるのを避けるため。

import Stripe from 'stripe';
import { redis, redisKey } from './redis';
import { isAdminEmail } from './adminEmails';

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// セッション再チェックでのキャッシュ有効期間。「解約してから実際にアクセスできなく
// なるまでの最大遅延」に相当する。短くするほどStripeへの問い合わせが増え、長くする
// ほど解約後の猶予が伸びる。利用者が数名規模の運用であることを踏まえ1時間とする。
const SUBSCRIPTION_CACHE_TTL_SECONDS = 60 * 60;

// キャッシュのキー名にスキーマ版を含める。最初は同じ `subcheck:{email}` に
// boolean を素で入れていたため、デプロイ直後は旧形式と新形式が最大1時間混在する。
// キーを分ければ新デプロイは旧データを一切読まず、旧キーはTTLで自然に消える
// （明示的な削除処理は不要）。保存する値の形を変えるときは、ここの版を上げること。
//   v1(接尾辞なし) ... boolean を素で保存
//   v2             ... { active, limits }
//   v3             ... { active, limits, period } ← 現行
const CACHE_SCHEMA_VERSION = 'v3';
const subscriptionCacheKey = (email) => redisKey('subcheck', CACHE_SCHEMA_VERSION, email);

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
 * 契約中サブスクリプションの請求期間を取り出す。取得できなければ null。
 *
 * 【フィールドの位置について】インストール済みSDK(stripe 17.7.0)で確認した事実:
 *   - SDKが固定しているAPIバージョンは '2025-02-24.acacia'
 *     (node_modules/stripe/cjs/apiVersion.js)。stripe.core.js が全リクエストに
 *     このバージョンを付けて送るため、Stripeダッシュボード側のアカウント
 *     APIバージョン設定はレスポンスの形に影響しない。
 *   - このバージョンでは current_period_start / current_period_end は
 *     サブスクリプション本体にある (types/Subscriptions.d.ts:90,95、いずれも
 *     nullable ではない number)。
 *   - SubscriptionItem 側にはこの2つは存在しない
 *     (types/SubscriptionItems.d.ts のフィールドは id / object /
 *      billing_thresholds / created / deleted / discounts / metadata / plan /
 *      price / quantity / subscription / tax_rates のみ)。
 *
 * 【SDKを上げるときの地雷】APIバージョン '2025-03-31.basil' で、この2つは
 * サブスクリプション本体から items.data[] の各アイテム側へ移動した。stripe を
 * basil 以降のSDKへ上げると、ここは黙って undefined を返すようになり
 * (=期間なし扱いに落ちる)、カウンタが請求サイクルで区切られなくなる。
 * SDK更新時は必ず types/Subscriptions.d.ts と types/SubscriptionItems.d.ts の
 * current_period_* の位置を確認し、必要ならこの関数を直すこと。
 *
 * 戻り値はミリ秒エポック。Stripeは秒で返すが、このリポジトリの時刻はすべて
 * Date.now() のミリ秒(lib/cases.js の score、company の updatedAt など)なので、
 * 単位の取り違えを防ぐためここで一度だけ変換して以降はミリ秒に統一する。
 */
function billingPeriodFromSubscription(subscription) {
  const startSec = subscription?.current_period_start;
  const endSec = subscription?.current_period_end;

  const valid =
    Number.isFinite(startSec) &&
    Number.isFinite(endSec) &&
    startSec > 0 &&
    endSec > startSec;

  if (!valid) {
    console.warn(
      `[subscription] サブスクリプション ${subscription?.id || '(unknown)'} から請求期間を` +
        `取得できませんでした（current_period_start: ${JSON.stringify(startSec)}, ` +
        `current_period_end: ${JSON.stringify(endSec)}）。検索回数カウンタは` +
        'この請求サイクルでは動作しません。StripeのSDK/APIバージョンを更新した場合は、' +
        'current_period_* がサブスクリプション本体から items.data[] 側へ移動していないか確認してください。'
    );
    return null;
  }

  return { start: startSec * 1000, end: endSec * 1000 };
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
 * period は請求期間 { start, end }（ミリ秒エポック）。取得できない場合は null で、
 * これが起きるのは次の4つ:
 *   1. 管理者          ... Stripe顧客を持たない。上限が無制限でカウント自体が不要
 *   2. 有効なサブスクなし ... そもそもアクセスさせないので期間に意味がない
 *   3. Stripe障害のフェイルオープン ... limitsも既定値(無制限)なのでカウント不要
 *   4. 請求期間フィールドの異常     ... 想定外(SDKの型上はnullableでない)
 * 呼び出し側は period が null なら「カウントしない・ブロックしない」で扱うこと
 * (フェイルオープン)。1〜3は上限が無制限なので実害がなく、4は現場を止めるより
 * warnログで気付ける方を選ぶ。ただし4だけは上限が有限なのに数えられない状態に
 * なりうるため、billingPeriodFromSubscription() が必ずwarnを出す。
 *
 * Stripeへの往復は customers.list と subscriptions.list の2回のまま増やさない。
 * subscriptions.list のレスポンスには items[].price がPriceオブジェクトとして
 * 最初から入っている（IDだけではない）ので、metadataを読むのに
 * prices.retrieve() の追加呼び出しも expand 指定も要らない。請求期間も同じ
 * レスポンスに含まれるため、追加の呼び出しは発生しない。
 */
export async function checkActiveSubscriptionLive(email) {
  // 管理者はStripe顧客が無いので請求期間も存在しない。上限が全部無制限で
  // カウント自体が不要なため period: null で問題ない。
  if (isAdminEmail(email)) {
    return { customerFound: true, active: true, limits: { ...ADMIN_PLAN_LIMITS }, period: null };
  }

  const customerId = await getStripeCustomerIdByEmail(email);
  if (!customerId) {
    return { customerFound: false, active: false, limits: { ...DEFAULT_PLAN_LIMITS }, period: null };
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
    return { customerFound: true, active: false, limits: { ...DEFAULT_PLAN_LIMITS }, period: null };
  }

  const price = selectPlanPrice(activeSubscription);
  const limits = price
    ? planLimitsFromPrice(price)
    : { ...DEFAULT_PLAN_LIMITS };

  return {
    customerFound: true,
    active: true,
    limits,
    period: billingPeriodFromSubscription(activeSubscription),
  };
}

/** 請求期間として妥当な形か（null は「期間なし」として妥当）。 */
function isValidCachedPeriod(period) {
  if (period === null) return true;
  return (
    typeof period === 'object' &&
    Number.isFinite(period.start) &&
    Number.isFinite(period.end) &&
    period.end > period.start
  );
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
    Number.isInteger(value.limits.retentionDays) &&
    // period はキーが無いだけでも不正とみなす（v2の値がv3キーに紛れた場合の保険）
    'period' in value &&
    isValidCachedPeriod(value.period)
  );
}

/**
 * セッション再検証用。サブスクの有効性とプラン上限をRedisに短いTTLでキャッシュし、
 * キャッシュが無ければStripeに再照会する。
 *
 * Stripe/Redis自体が障害・タイムアウトした場合は「有効・上限は既定値(無制限)・
 * 期間なし」とみなして通す(フェイルオープン)。このアプリは電気工事士が現場作業中に
 * 使うツールのため、インフラ側の一時的な不調でログイン済みユーザーを締め出す実害の
 * 方が大きいと判断。障害時の結果はキャッシュしない＝Stripeが復旧すれば次の
 * リクエストで正しい値に切り替わる。
 *
 * period が null のときの扱いは checkActiveSubscriptionLive() のコメントを参照。
 *
 * なお請求期間はキャッシュTTL(1時間)より遥かに長い(通常1ヶ月)ため、期間の切り替わり
 * 直後に最大1時間だけ古い期間が返りうる。検索回数カウンタのキーが1時間だけ前の
 * サイクルのままになるが、その間に消費した分は次のサイクルに繰り越されず、
 * 利用者に不利にはならないので許容する。
 *
 * @returns {Promise<{active: boolean, limits: {plan: string, searchLimit: number, caseLimit: number, retentionDays: number}, period: {start: number, end: number} | null}>}
 */
export async function getSubscriptionStateCached(email) {
  // 管理者はStripe顧客が無いので照会もキャッシュもせず即返す
  // (login.js / _auth.js のバイパスと同じ扱い)。
  if (isAdminEmail(email)) {
    return { active: true, limits: { ...ADMIN_PLAN_LIMITS }, period: null };
  }

  const key = subscriptionCacheKey(email);

  try {
    const cached = await redis.get(key);
    if (isValidCachedState(cached)) {
      return {
        active: cached.active,
        limits: { ...cached.limits },
        period: cached.period ? { ...cached.period } : null,
      };
    }
  } catch (err) {
    console.error('[subscription] キャッシュ読み込みに失敗しました。Stripeへ直接照会します:', err);
  }

  let state;
  try {
    const { active, limits, period } = await checkActiveSubscriptionLive(email);
    state = { active, limits, period };
  } catch (err) {
    console.error('[subscription] Stripeへの照会に失敗しました。一時的に有効とみなします:', err);
    return { active: true, limits: { ...DEFAULT_PLAN_LIMITS }, period: null };
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
