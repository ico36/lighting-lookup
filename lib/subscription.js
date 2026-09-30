// lib/subscription.js
// Stripeサブスクリプションの有効性チェックと、契約中プランの上限値の解決。
//   - api/login.js         : ログイン時のライブチェック(checkActiveSubscriptionLive)
//   - api/_auth.js の authenticate() : 発行済みセッションの定期再チェックと、
//     プラン上限・請求期間の取得(getSubscriptionStateCached、Redisキャッシュ経由)
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

// lib/legalConsent.js が同じインスタンスを再利用する(Stripeクライアントの
// 生成箇所・timeout/リトライ設定を1箇所に保つため)。export以外の変更は無い。
export const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
//   v3             ... { active, limits, period }
//   v4             ... { active, limits, period, status, lastPlanLimits }
//   v5             ... { active, limits, period, status, lastPlanLimits, endedAt } ← 現行
//                      (endedAt は解約済み所有者の契約終了時刻(ms epoch)。
//                      lib/ownerDeletion.js の削除予定日計算(起点)に使う。
//                      status が CANCELED 以外、または最後に終了した契約が
//                      見つからない場合は null)
const CACHE_SCHEMA_VERSION = 'v5';
const subscriptionCacheKey = (email) => redisKey('subcheck', CACHE_SCHEMA_VERSION, email);

/**
 * サブスク状態のキャッシュを捨てる。プラン変更(api/checkout.js の update-plan)の直後に
 * 呼び、次のリクエストが新しいプランの上限を見るようにする。
 *
 * キーの組み立てをこの関数に閉じるのは、CACHE_SCHEMA_VERSION('v3')を呼び出し側に
 * 複製しないため。版を上げたときに削除側だけ古い版のキーを消し続ける事故を防ぐ。
 */
export async function invalidateSubscriptionCache(email) {
  await redis.del(subscriptionCacheKey(email));
}

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

// 所有者のStripe契約状態の分類。checkActiveSubscriptionLive()/
// getSubscriptionStateCached()が返す。api/cron/process-cases.js の自動失注が
// 「解約済み/顧客なし」と「契約継続中(支払い遅延含む)」を区別して
// retentionDaysの焼き込み方を変えるために追加した(元々は active だけで
// 判定しており、解約済み・顧客なし・Stripe障害がすべて同じ既定値(-1)に
// 潰れて区別できなかった)。
//
//   ADMIN       ... 管理者(ADMIN_EMAILS)。Stripe顧客を持たない
//   ACTIVE      ... 有効なサブスク(active/trialing)あり
//   PAST_DUE    ... 支払い遅延中(Stripe状態: past_due または unpaid)。
//                   契約自体はまだ終了していない。将来の「解約から6か月で
//                   削除」機能が、支払い遅延中の人を解約済みと誤認して
//                   削除の起算点にしてしまわないよう、CANCELEDとは別に分ける
//   CANCELED    ... 顧客は存在するが、有効/支払い遅延中のサブスクが無い
//                   (解約済み、または一度も有効化されなかった incomplete_expired
//                   のみが残っている状態)
//   NO_CUSTOMER ... Stripe顧客自体が見つからない
//   UNKNOWN     ... Stripe障害等で判定できなかった(degraded:trueのときだけ)
export const OWNER_STATUS = Object.freeze({
  ADMIN: 'admin',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  NO_CUSTOMER: 'no_customer',
  UNKNOWN: 'unknown',
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
 *
 * api/checkout.js の get-upgrade-options も、移行先プランの上限をフロントに見せるために
 * これを使う（数値をフロントにハードコードしないため）。同じ変換を2箇所に書くと
 * metadataのキー名を変えたときに片方だけ直す事故になるのでexportしている。
 */
export function planLimitsFromPrice(price) {
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
 * 有効なサブスクリプションから、プラン本体のアイテムを1つ選ぶ。
 * このアプリは1契約1アイテム前提だが、将来アドオンのアイテムが増えても
 * プラン本体を取り違えないよう、metadata.planを持つアイテムを優先する。
 *
 * 【SDKを上げるときの地雷】アイテムの取り方(items.data)も current_period_* と同じく
 * APIバージョン依存。プラン変更(api/checkout.js の update-plan)は、ここで選んだ
 * アイテムのidを subscriptions.update の items[].id に渡して差し替えるため、
 * ここが壊れると「別のアイテムを差し替える」という事故になる。
 */
function selectPlanItem(subscription) {
  const items = subscription?.items?.data || [];
  const planItem = items.find((item) => item?.price?.metadata?.plan);
  return planItem || items[0] || null;
}

/** 上限値の根拠にするPrice。プラン本体のアイテムのPriceを返す。 */
function selectPlanPrice(subscription) {
  return selectPlanItem(subscription)?.price || null;
}

// サブスクリプションのStripeステータス分類。OWNER_STATUSと1対1ではない
// (OWNER_STATUSは「所有者」単位、こちらは「個々のサブスク」単位)。
const LIVE_STATUSES = ['active', 'trialing'];
const PAST_DUE_STATUSES = ['past_due', 'unpaid'];
// 一度も有効化されなかった契約。実際に使われた実績が無いため「最後に契約して
// いたプラン」の候補から外す(=このサブスクしか無い所有者はCANCELEDだが
// lastPlanLimitsはnullになり、cronはライトプランの予備値にフォールバックする)。
const NEVER_ACTIVATED_STATUSES = ['incomplete', 'incomplete_expired'];

/**
 * サブスクリプションが「終了した」とみなす時刻(秒エポック)。
 *
 * 優先順は ended_at → canceled_at → created。
 * 【なぜcanceled_atを最優先にしないか】canceled_at は「解約を申し込んだ日時」で、
 * 期間末解約(cancel_at_period_end)の場合はそこから実際に契約が終わる日までの
 * 間、サブスクはまだcanceled状態になっていない(=このリストにも出てこない)。
 * 一方、即時解約や支払い失敗による強制終了では、契約が実際に終わった時点で
 * canceled_atとended_atがほぼ同時に立つ。ended_atは「実際に終了した日時」を
 * 表すフィールドとして常に優先し、それが無い(古いAPIバージョンやWebhook経由で
 * 未設定など)場合だけcanceled_atで代用する。
 */
function endedAtOf(sub) {
  return sub?.ended_at || sub?.canceled_at || sub?.created || 0;
}

/**
 * 有効/支払い遅延中のいずれでもないサブスクリプションのうち、最後に終了した
 * ものを1つ選ぶ。一度も有効化されなかった(incomplete/incomplete_expired)
 * サブスクは候補から除く。該当が無ければnull。
 */
function selectMostRecentlyEndedSubscription(subscriptions) {
  const candidates = subscriptions.filter((sub) =>
    !LIVE_STATUSES.includes(sub.status) &&
    !PAST_DUE_STATUSES.includes(sub.status) &&
    !NEVER_ACTIVATED_STATUSES.includes(sub.status)
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, sub) => (endedAtOf(sub) > endedAtOf(latest) ? sub : latest));
}

// 照明サーチのPriceを特定するための環境変数(api/checkout.jsのPRICE_ID_ENVと同じ3つ)。
// 同じStripeアカウントに他製品(例: KYノート)のサブスク商品を追加した場合に、
// その製品だけを契約した顧客が同じメールアドレスで照明サーチにログインできて
// しまう問題への対応。旧STRIPE_PRICE_ID(3プラン体系導入以前の単一Price)は
// 2026-09時点で本番0件・テスト0件(現ログイン3アカウントはADMIN_EMAILS経由)を
// 確認済みのため、ホワイトリストには含めない。
const LIGHTING_SEARCH_PRICE_ID_ENV_VARS = [
  'STRIPE_PRICE_ID_LIGHT',
  'STRIPE_PRICE_ID_STANDARD',
  'STRIPE_PRICE_ID_PRO',
];

/**
 * 照明サーチのPrice IDの集合を環境変数から組み立てる。
 *
 * 【3つのうち1つでも欠けていたら例外を投げる(fail-closed)】
 * 「絞り込み無し(=全Priceを許可)」に倒すと、この関数を追加した目的(他製品の
 * サブスクだけを持つ顧客のログインを防ぐ)そのものが環境変数の消失で消える。
 * 逆に「絞り込みの結果を空集合にして全部拒否」に倒すと、照明サーチの契約者まで
 * 締め出す事故が本番の設定ミス1つで起こり得る。どちらの静かな劣化も避けるため、
 * 例外を投げて呼び出し元に処理を止めさせる。
 *
 *   - api/login.js / api/checkout.js の handleCreateCheckout は個別のtry/catchで
 *     受け止めて500を返す(新規ログイン・新規申し込みは即座に全面停止)。
 *   - api/_auth.js 経由(lib/subscription.js の getSubscriptionStateCached)は
 *     既存の「Stripe照会失敗時はフェイルオープン」のcatchに乗り、
 *     console.error を出した上でログイン済みセッションは通す。
 *     (lib/cron/process-cases.js の retentionDays:-1 焼き込み事故と同じ
 *     「envが消えると守りも静かに消える」形を避けるため、この関数自体は
 *     絶対に「全部許可」を意味する値を返さない)
 */
function getLightingSearchPriceIds() {
  const missing = LIGHTING_SEARCH_PRICE_ID_ENV_VARS.filter(
    (name) => !process.env[name] || String(process.env[name]).trim() === ''
  );
  if (missing.length > 0) {
    throw new Error(
      `[subscription] 照明サーチのPrice ID環境変数が不足しています(${missing.join(', ')})。` +
        '認証の安全のため処理を停止します。'
    );
  }
  return new Set(LIGHTING_SEARCH_PRICE_ID_ENV_VARS.map((name) => process.env[name]));
}

/**
 * 有効な(active/trialing)サブスクリプションと、そのプラン本体のアイテムを返す。
 *
 * checkActiveSubscriptionLive()（ログイン可否と上限の判定）と、
 * api/checkout.js の update-plan（プラン変更）の両方から使う。プラン変更側で
 * items.data[0] を独自に取ると、上のselectPlanItem()の規則（metadata.planを持つ
 * アイテムを優先）と食い違うため、取得経路をここに1本化する。
 *
 * Stripeへの往復は customers.list と subscriptions.list の2回。
 *
 * 【他製品のサブスクを除外する】同じStripeアカウントに他製品(例: KYノート)の
 * サブスク商品を追加した場合、customers.list はメールアドレスだけで顧客を
 * 解決するため、他製品しか契約していない顧客のCustomerも同じように見つかって
 * しまう。subscriptions.list もPrice/Productでは絞り込めないため、取得後に
 * 照明サーチのPrice ID(getLightingSearchPriceIds())を持つアイテムがあるものだけに
 * ここで絞り込む。以降のLIVE_STATUSES判定・PAST_DUE判定・終了済み選定の
 * 3箇所すべてがこの絞り込み後のリストを見るため、個別に直す必要はない。
 *
 * 【limitを100にしている理由】絞り込みが取得後(Stripe API自体にはPrice/Productで
 * 絞るクエリが無い)のため、他製品の解約・再契約を繰り返した顧客だと、
 * 照明サーチの契約が10件より後ろに来て取得漏れする恐れがある。100件を超える
 * 単一顧客のサブスク履歴は現状の運用では想定しない。
 *
 * pastDueSubscription・lastEndedSubscription は checkActiveSubscriptionLive()の
 * OWNER_STATUS判定(PAST_DUE/CANCELED)のために追加した。既存の呼び出し元
 * (api/checkout.js)は{ subscription, item }や{ customerId, subscription }
 * しか分割代入していないため、フィールド追加のみで挙動に影響しない。
 * subscriptions.list は既にstatus:'all'で全件取っているので、この2つを
 * 追加で選び出すのにStripeへの追加往復は発生しない。
 *
 * @returns {Promise<{customerId: string|null, subscription: object|null, item: object|null, pastDueSubscription: object|null, lastEndedSubscription: object|null}>}
 *   customerId が null   ... Stripe顧客が見つからない
 *   subscription が null ... 有効なサブスクが無い
 *   pastDueSubscription  ... subscriptionがnullのときだけ探す。支払い遅延中の契約
 *   lastEndedSubscription... subscription/pastDueSubscriptionが両方nullのときだけ探す
 */
export async function getActiveSubscriptionWithItem(email) {
  // Stripe顧客が見つからないメールでは絞り込みが素通りしてしまい、Price ID
  // 環境変数の設定ミスに気づく機会を失う。そのため顧客解決より前に必ず呼ぶ
  // (管理者はこの関数自体を呼び出し元(isAdminEmail())で迂回済みなので影響しない)。
  const allowedPriceIds = getLightingSearchPriceIds();

  const customerId = await getStripeCustomerIdByEmail(email);
  if (!customerId) {
    return { customerId: null, subscription: null, item: null, pastDueSubscription: null, lastEndedSubscription: null };
  }

  const allSubscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });

  const subscriptions = {
    data: allSubscriptions.data.filter((sub) =>
      (sub.items?.data || []).some((item) => allowedPriceIds.has(item.price?.id))
    ),
  };

  const subscription = subscriptions.data.find((sub) =>
    LIVE_STATUSES.includes(sub.status)
  ) || null;

  const pastDueSubscription = subscription
    ? null
    : subscriptions.data.find((sub) => PAST_DUE_STATUSES.includes(sub.status)) || null;

  const lastEndedSubscription = (subscription || pastDueSubscription)
    ? null
    : selectMostRecentlyEndedSubscription(subscriptions.data);

  return {
    customerId,
    subscription,
    item: subscription ? selectPlanItem(subscription) : null,
    pastDueSubscription,
    lastEndedSubscription,
  };
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
 * メールアドレスに紐づく**全て**のStripe顧客IDを返す(先頭1件だけの
 * getStripeCustomerIdByEmail() と違い、同一メールで複数のCustomerが存在する
 * ケースを取りこぼさない)。lib/ownerDeletion.js の削除直前の最終確認
 * (resolveOwnerDeletionRecheck())専用。ログイン可否判定・解約ポータル発行は
 * 従来どおり先頭1件のgetStripeCustomerIdByEmail()を使い続ける(挙動を変えない)。
 *
 * 100件を超える顧客が同一メールに紐づくことは現状の運用では想定していない。
 * 超えている場合はwarnを出すだけに留め(ページングは実装しない)、
 * 取得できた分だけで判定を続行する。
 */
export async function listStripeCustomerIdsByEmail(email) {
  const customers = await stripe.customers.list({ email, limit: 100 });
  if (customers.has_more) {
    console.warn(
      `[subscription] ${email} のStripe顧客が100件を超えている可能性があります(has_more: true)。` +
        '削除前の全顧客確認が不完全な場合があります。'
    );
  }
  return customers.data.map((c) => c.id);
}

/**
 * lib/ownerDeletion.js の削除直前の最終確認専用。対象メールに紐づく**全て**の
 * Stripe顧客(listStripeCustomerIdsByEmail())の、**全て**のサブスクリプションを見て、
 *   - 有効(active/trialing)または支払い遅延中(past_due/unpaid)のものが1つでもあれば
 *     hasLiveOrPastDue: true (契約が生きている＝削除してはいけない)
 *   - 無ければ、終了済みサブスクのうち最も新しいものの終了時刻(ms epoch)を
 *     latestEndedAt に返す(無ければnull)
 *
 * 【キャッシュを経由しない理由】決定E(要確認①合意事項)により、削除直前は
 * getSubscriptionStateCached()の1時間キャッシュを通さず必ずStripeへ直接照会する。
 * 【単一顧客前提のcheckActiveSubscriptionLive()と分けた理由】ログイン可否判定は
 * 「先頭1件のCustomer」という既存の挙動を変えたくない一方、削除は取り返しが
 * つかないため全Customerを見る必要があり、要件が異なる。
 *
 * 呼び出し側(lib/ownerDeletion.js)は、latestEndedAtから削除予定日を計算し直し、
 * まだ未来なら削除を先送りする(「再契約→再解約」で契約終了日が更新された
 * ケースに対応するため)。
 *
 * @returns {Promise<{hasLiveOrPastDue: boolean, latestEndedAt: number|null}>}
 */
export async function resolveOwnerDeletionRecheck(email) {
  const customerIds = await listStripeCustomerIdsByEmail(email);
  if (customerIds.length === 0) {
    return { hasLiveOrPastDue: false, latestEndedAt: null };
  }

  const allSubscriptions = [];
  for (const customerId of customerIds) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 10,
    });
    allSubscriptions.push(...subscriptions.data);
  }

  const hasLiveOrPastDue = allSubscriptions.some(
    (sub) => LIVE_STATUSES.includes(sub.status) || PAST_DUE_STATUSES.includes(sub.status)
  );
  if (hasLiveOrPastDue) {
    return { hasLiveOrPastDue: true, latestEndedAt: null };
  }

  const lastEnded = selectMostRecentlyEndedSubscription(allSubscriptions);
  return {
    hasLiveOrPastDue: false,
    latestEndedAt: lastEnded ? endedAtOf(lastEnded) * 1000 : null,
  };
}

/**
 * Stripeに直接問い合わせて、顧客の有無・有効なサブスク(active/trialing)の有無・
 * 契約中プランの上限値を判定する。api/login.js はcustomerFound/activeを見て別々の
 * エラーメッセージを出し分けており、requireAuth()の再チェックは activeだけを見る。
 *
 * 戻り値の limits は、有効なサブスクが無いときも DEFAULT_PLAN_LIMITS が入る
 * （呼び出し側で null チェックを強いないため）。activeがfalseのときは
 * そもそも上限以前にアクセスさせない前提なので、値に意味は無い
 * (ただしPAST_DUEだけは例外。下記status参照)。
 *
 * status は所有者の契約状態の分類(OWNER_STATUS)。activeの単純なtrue/falseでは
 * 「解約済み」「Stripe顧客なし」「支払い遅延中」「Stripe障害で不明」が区別できず、
 * api/cron/process-cases.js の自動失注がこれらを全部同じ既定値(-1=無期限)で
 * 扱ってしまっていた（バグ）。activeの判定自体(ログイン可否)は一切変えず、
 * 追加の分類情報としてstatusを乗せているだけなので、既存の呼び出し元
 * (activeだけを見る箇所)の挙動には影響しない。
 *   - PAST_DUEのときのlimitsは DEFAULT_PLAN_LIMITS ではなく、支払い遅延中の
 *     契約自体のPrice metadataを使う。契約はまだ終了していないので、実態の
 *     プランを返す方が正しい(activeがfalseなので、この値は現状どこでも
 *     消費されない。api/cron/process-cases.js だけがこの後resolveAutoLoseRetentionDays()
 *     経由で参照する)。
 *   - CANCELEDのときは lastPlanLimits に「最後に終了した契約」のPrice metadataを
 *     乗せる(見つかれば)。無ければnull。
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
    return {
      customerFound: true,
      active: true,
      limits: { ...ADMIN_PLAN_LIMITS },
      period: null,
      status: OWNER_STATUS.ADMIN,
      lastPlanLimits: null,
      endedAt: null,
    };
  }

  // 顧客IDとサブスクの解決は getActiveSubscriptionWithItem() に集約してある
  // （プラン変更側と同じ規則でプラン本体のアイテムを選ぶため）。Stripeへの往復は
  // customers.list と subscriptions.list の2回のままで増えていない。
  const { customerId, subscription, item, pastDueSubscription, lastEndedSubscription } =
    await getActiveSubscriptionWithItem(email);

  if (!customerId) {
    return {
      customerFound: false,
      active: false,
      limits: { ...DEFAULT_PLAN_LIMITS },
      period: null,
      status: OWNER_STATUS.NO_CUSTOMER,
      lastPlanLimits: null,
      endedAt: null,
    };
  }

  if (!subscription && pastDueSubscription) {
    // 契約自体は終了していない(支払い遅延中)。activeは従来どおりfalseのまま
    // 変えない(ログイン可否を変える話ではない)。limitsだけは実態の契約に
    // 合わせる。
    const pastDuePrice = selectPlanPrice(pastDueSubscription);
    const limits = pastDuePrice ? planLimitsFromPrice(pastDuePrice) : { ...DEFAULT_PLAN_LIMITS };
    return {
      customerFound: true,
      active: false,
      limits,
      period: null,
      status: OWNER_STATUS.PAST_DUE,
      lastPlanLimits: null,
      endedAt: null,
    };
  }

  if (!subscription) {
    // 解約済み(または一度も有効化されなかったincomplete_expiredのみ)。
    const lastPrice = lastEndedSubscription ? selectPlanPrice(lastEndedSubscription) : null;
    const lastPlanLimits = lastPrice ? planLimitsFromPrice(lastPrice) : null;
    // 契約終了時刻(ms epoch)。lib/ownerDeletion.js が削除予定日(起点+6か月)の
    // 起点として使う。lastEndedSubscriptionが無ければnull(呼び出し側は
    // 「検知した時刻」を代わりの起点にする。このファイルの方針コメント参照)。
    const endedAt = lastEndedSubscription ? endedAtOf(lastEndedSubscription) * 1000 : null;
    return {
      customerFound: true,
      active: false,
      limits: { ...DEFAULT_PLAN_LIMITS },
      period: null,
      status: OWNER_STATUS.CANCELED,
      lastPlanLimits,
      endedAt,
    };
  }

  const price = item?.price || null;
  const limits = price
    ? planLimitsFromPrice(price)
    : { ...DEFAULT_PLAN_LIMITS };

  return {
    customerFound: true,
    active: true,
    limits,
    period: billingPeriodFromSubscription(subscription),
    status: OWNER_STATUS.ACTIVE,
    lastPlanLimits: null,
    endedAt: null,
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

/** limits / lastPlanLimits 共通の形チェック。 */
function isValidLimitsShape(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.plan === 'string' &&
    Number.isInteger(value.searchLimit) &&
    Number.isInteger(value.caseLimit) &&
    Number.isInteger(value.retentionDays)
  );
}

const VALID_OWNER_STATUSES = new Set(Object.values(OWNER_STATUS));

/** キャッシュから読んだ値が現行スキーマ(v5)の形をしているか確認する。 */
function isValidCachedState(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.active === 'boolean' &&
    isValidLimitsShape(value.limits) &&
    // period はキーが無いだけでも不正とみなす（v2の値がv3キーに紛れた場合の保険）
    'period' in value &&
    isValidCachedPeriod(value.period) &&
    typeof value.status === 'string' &&
    VALID_OWNER_STATUSES.has(value.status) &&
    (value.lastPlanLimits === null || isValidLimitsShape(value.lastPlanLimits)) &&
    // endedAt もキーが無いだけで不正とみなす(v4以前の値がv5キーに紛れた場合の保険)
    'endedAt' in value &&
    (value.endedAt === null || Number.isFinite(value.endedAt))
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
 * 【degraded】フェイルオープンで既定値を返したときだけ true。呼び出し側が
 * 「本当に無制限プランなのか」「Stripeに聞けなかっただけなのか」を区別するための印。
 * DEFAULT_PLAN_LIMITS は全項目が無制限(-1)なので、この印が無いと両者が同じ値に見える。
 *
 * 区別が要るのは、値を保存してしまう処理がある場合。api/cron/process-cases.js は
 * 自動失注のときに retentionDays を案件へ焼き込むため、障害時の既定値(-1=無期限)を
 * 焼き込むと「二度とアーカイブされない案件」が恒久的に残る。degraded が立っていたら
 * ステータス変更ごと見送って次回のcronに回す。
 * 一方 requireAuth()経由の通常リクエストは値を保存せず、その場の判定に使うだけなので
 * この印を見る必要はない（従来どおりフェイルオープンで通す）。
 *
 * 【キャッシュには入れない】degraded はメモリ上の戻り値にだけ乗せる。フェイルオープンの
 * 結果は元々キャッシュに書かずに早期returnしているため(下記catch参照)、劣化した値を
 * TTLの1時間使い回すことは構造上起きない。保存する形は { active, limits, period, status,
 * lastPlanLimits, endedAt } のまま(v5)。
 *
 * @returns {Promise<{active: boolean, limits: {plan: string, searchLimit: number, caseLimit: number, retentionDays: number}, period: {start: number, end: number} | null, degraded: boolean, status: string, lastPlanLimits: object|null, endedAt: number|null}>}
 */
export async function getSubscriptionStateCached(email) {
  // 管理者はStripe顧客が無いので照会もキャッシュもせず即返す
  // (login.js / _auth.js のバイパスと同じ扱い)。
  if (isAdminEmail(email)) {
    // 管理者は照会自体が不要（Stripe顧客を持たない）。無制限なのは事実なので degraded ではない
    return {
      active: true,
      limits: { ...ADMIN_PLAN_LIMITS },
      period: null,
      degraded: false,
      status: OWNER_STATUS.ADMIN,
      lastPlanLimits: null,
      endedAt: null,
    };
  }

  const key = subscriptionCacheKey(email);

  try {
    const cached = await redis.get(key);
    if (isValidCachedState(cached)) {
      return {
        active: cached.active,
        limits: { ...cached.limits },
        period: cached.period ? { ...cached.period } : null,
        degraded: false,
        status: cached.status,
        lastPlanLimits: cached.lastPlanLimits ? { ...cached.lastPlanLimits } : null,
        endedAt: cached.endedAt,
      };
    }
  } catch (err) {
    console.error('[subscription] キャッシュ読み込みに失敗しました。Stripeへ直接照会します:', err);
  }

  let state;
  try {
    const { active, limits, period, status, lastPlanLimits, endedAt } = await checkActiveSubscriptionLive(email);
    state = { active, limits, period, status, lastPlanLimits, endedAt };
  } catch (err) {
    console.error('[subscription] Stripeへの照会に失敗しました。一時的に有効とみなします:', err);
    // ここで返す既定値は「本当に無制限」ではなく「聞けなかった」。値を保存する処理
    // （案件へのretentionDays焼き込みなど）が区別できるよう degraded を立てる。
    // statusはUNKNOWN(=本当の状態が不明)にする。CANCELED/NO_CUSTOMERにしないのは、
    // 呼び出し側(cron)がそちらの分岐(予備値フォールバック)へ誤って進んでしまう
    // ことを防ぐため。なおこの経路は下の redis.set を通らないので、劣化した値は
    // キャッシュされない。endedAtもUNKNOWN同様nullにし、呼び出し側
    // (lib/ownerDeletion.js)が誤って削除予定を登録しないようにする。
    return {
      active: true,
      limits: { ...DEFAULT_PLAN_LIMITS },
      period: null,
      degraded: true,
      status: OWNER_STATUS.UNKNOWN,
      lastPlanLimits: null,
      endedAt: null,
    };
  }

  try {
    await redis.set(key, state, { ex: SUBSCRIPTION_CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('[subscription] キャッシュ書き込みに失敗しました:', err);
  }

  return { ...state, degraded: false };
}

// 解約済み/顧客なしの所有者向けの、最終的な安全側フォールバック(日数)。
// getLightPlanRetentionDaysFallback() がライトプランのretention_daysを取得
// できない・値が不正なときにここへ落ちる。ライトプランの保存期間(30日)に
// 合わせた値であり、「解約から全データを削除するまでの期間」(利用規約第6条の
// 6か月)とは別の概念なので混同しないこと。
//
// 【lib/subscription.js冒頭の「プラン数値をコードに書かない」方針との関係】
// この値はStripeで販売する特定プランの料金・上限ではなく、「Stripe側の設定が
// 壊れていても、解約済み所有者のデータをライトプラン相当の保存期間より長く
// 残さない」という安全弁(最終防波堤)。プラン設定として運用側が調整する数値
// ではないため、この例外はこのファイルの方針に反しない。
export const FALLBACK_RETENTION_DAYS_SAFE_NET = 30;

/**
 * ライトプラン(STRIPE_PRICE_ID_LIGHT)のretention_daysを取得する。
 * api/cron/process-cases.js が「解約済み/顧客なし」所有者向けの予備値として使う
 * (最後の契約のmetadataが取れない・欠損・無制限(-1)だった場合の最終フォールバック)。
 *
 * 【絶対に -1・0未満・undefined・NaN を返さない】STRIPE_PRICE_ID_LIGHT未設定・
 * Stripe取得失敗・metadataの値が不正/無制限のいずれでも、必ず
 * FALLBACK_RETENTION_DAYS_SAFE_NET(正の整数の固定値)に倒す。ここで-1を通すと
 * 「ライトプランのmetadataが壊れている」という設定ミス1つで、解約済み所有者
 * 全員が無期限保持に落ちる(今回直す不具合と同じ構造の再発になる)。
 *
 * 【cronの1回の実行で複数回呼ばない】この関数自体は呼ばれるたびにStripeへ
 * 問い合わせる(状態を持たない)。api/cron/process-cases.js側で1回の実行につき
 * 高々1回だけ呼ぶよう、結果をローカル変数でメモ化すること(関数自体はメモ化しない。
 * 「ライトプランのretention_daysが実行中に変わる」ことは無いが、モジュール
 * スコープでメモ化すると温かいまま使い回されるサーバーレスインスタンスで
 * Stripe側の変更に長時間気づけなくなるため、あえてcronの1回の呼び出し単位に
 * 留める)。
 */
export async function getLightPlanRetentionDaysFallback() {
  const priceId = process.env.STRIPE_PRICE_ID_LIGHT;
  if (!priceId) {
    console.error(
      '[subscription] STRIPE_PRICE_ID_LIGHT が未設定です。解約済み/顧客なしの所有者の' +
        `保存期間に安全側の既定値(${FALLBACK_RETENTION_DAYS_SAFE_NET}日)を使います`
    );
    return FALLBACK_RETENTION_DAYS_SAFE_NET;
  }

  try {
    const price = await stripe.prices.retrieve(priceId);
    const { retentionDays } = planLimitsFromPrice(price);
    if (Number.isInteger(retentionDays) && !isUnlimited(retentionDays)) {
      return retentionDays;
    }
    console.error(
      `[subscription] ライトプラン(${priceId})のretention_daysが不正または無制限(${retentionDays})のため、` +
        `安全側の既定値(${FALLBACK_RETENTION_DAYS_SAFE_NET}日)を使います`
    );
  } catch (err) {
    console.error(
      `[subscription] ライトプラン(${priceId})の取得に失敗しました。安全側の既定値` +
        `(${FALLBACK_RETENTION_DAYS_SAFE_NET}日)を使います:`,
      err
    );
  }

  return FALLBACK_RETENTION_DAYS_SAFE_NET;
}

/**
 * api/cron/process-cases.js のステップ1(自動失注)専用。所有者のOWNER_STATUSから、
 * 焼き込むretentionDaysを1つに確定させる。
 *
 *   ACTIVE/ADMIN/PAST_DUE ... 契約自体は終了していない(支払い遅延中を含む)ので、
 *                             state.limits.retentionDaysをそのまま使う(従来どおり。
 *                             値が-1(無制限)でも、それは現に有効な契約の実態なので
 *                             正しい)
 *   CANCELED/NO_CUSTOMER  ... state.lastPlanLimits.retentionDays が有限の整数
 *                             (0以上)ならそれを使う。最後のプラン自体が
 *                             retention_days:-1(無制限)だった場合も含め、それ以外は
 *                             すべて fallbackRetentionDays (無ければ
 *                             getLightPlanRetentionDaysFallback() で取得)に倒す。
 *                             解約済みに無制限を引き継がせない判断で、保存期間の
 *                             長短が逆転する(ライトの予備値の方が長くなる)場合が
 *                             あり得るが、解約後は別途「解約から6か月で全データを
 *                             削除する」仕組みで上書きされる想定のため実害はない。
 *
 * 呼び出し側(process-cases.js)はdegraded:trueのケースをこの関数に渡す前に
 * deferしてスキップする(この関数はdegradedを一切見ない・呼ばれない前提)。
 *
 * @param {{status: string, limits: object, lastPlanLimits: object|null}} state
 * @param {{fallbackRetentionDays?: number}} [options]
 *   fallbackRetentionDays ... 呼び出し側が事前に取得したライトプランの
 *   retention_days(cronの1回の実行内でのメモ化用)。省略時はこの関数が
 *   getLightPlanRetentionDaysFallback()を直接呼ぶ。
 * @returns {Promise<number>}
 */
export async function resolveAutoLoseRetentionDays(state, { fallbackRetentionDays } = {}) {
  if (
    state.status === OWNER_STATUS.ACTIVE ||
    state.status === OWNER_STATUS.ADMIN ||
    state.status === OWNER_STATUS.PAST_DUE
  ) {
    return state.limits.retentionDays;
  }

  const last = state.lastPlanLimits;
  if (last && Number.isInteger(last.retentionDays) && !isUnlimited(last.retentionDays)) {
    return last.retentionDays;
  }

  if (Number.isInteger(fallbackRetentionDays)) {
    return fallbackRetentionDays;
  }

  return getLightPlanRetentionDaysFallback();
}

/**
 * 早期割引クーポン（50%オフ6ヶ月・引き換え上限10回・スタンダード/プロ限定）の枠が
 * まだ残っているか（＝適用してよいか）を、取得済みの Stripe Coupon オブジェクトから
 * 判定する。工程E-5: 枠が尽きた場合は割引の存在に一切触れず定価で見せるための判定。
 *
 * 【純粋な判定のみ。Stripeへの問い合わせはここでは行わない】
 * 呼び出し側（api/checkout.js の fetchCouponState()）は、確認ステップの表示文言
 * （percent_off / duration_in_months）のために coupons.retrieve() を既に1回呼んでいる。
 * ここでもう1回呼ぶと get-upgrade-options の Promise.all に往復が1本増えるため、
 * 同じ取得結果をそのまま渡してもらう形にして、この関数はStripeを呼ばない。
 *
 * 【STRIPE_COUPON_ID未設定・retrieve失敗（Stripe障害）はこの関数の対象外】
 * 「取得できたかどうか」は呼び出し側（fetchCouponState()）の関心事であり、
 * この関数が担当するのは「取得できた結果をどう解釈するか」だけ。
 *   - 未設定                  ... 呼び出し側がこの関数を呼ばずに false を返す
 *   - retrieve が例外を投げた ... 呼び出し側がこの関数を呼ばずに true を返す
 *     （Stripeの一時障害で本来割引を受けられる人に定価を出すのを避けるための
 *      フェイルオープン。障害時に true で通しても、確定時に Stripe が弾いて
 *      既存の409/500経路に落ちるだけで金銭的な取り違えは起きない）
 * そのため coupon は常に retrieve に成功した実オブジェクトが渡ってくる前提とし、
 * 未取得を表す null 等の防御的な既定値は持たない（呼び出し側の責務を握りつぶすと、
 * 「未設定なのにtrueが返る」ような取り違えを静かに通してしまうため）。
 *
 * @param {{valid?: boolean, max_redemptions?: number|null, times_redeemed?: number}} coupon
 *   stripe.coupons.retrieve() の戻り値。
 * @returns {boolean}
 */
export function isEarlyBirdCouponAvailable(coupon) {
  if (coupon.valid === false) return false;

  if (
    typeof coupon.max_redemptions === 'number' &&
    coupon.times_redeemed >= coupon.max_redemptions
  ) {
    return false;
  }

  return true;
}
