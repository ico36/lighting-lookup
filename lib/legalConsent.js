// lib/legalConsent.js
// 利用規約への同意記録(tos:{email})の読み書きと、Stripe Checkoutのconsent_collectionで
// 取得済みの同意を検出して自動記録する処理。
//
// 【Stripeクライアントを新設しない理由】lib/subscription.js が生成したインスタンスを
// そのまま再利用する。このリポジトリでStripeクライアントを生成している箇所は
// api/checkout.js と lib/subscription.js の2箇所のみで、どちらもオプション無しの
// `Stripe(process.env.STRIPE_SECRET_KEY)`(timeout・リトライともSDK既定値)。
// 新たに3つ目のインスタンスを作ると設定がずれる余地が生まれるため、顧客解決の
// getStripeCustomerIdByEmail() と同じ lib/subscription.js の既存インスタンスに揃える。
//
// 【company:{email}とは別キーにする理由】company.jsが持つ「自社情報」と本ファイルが
// 持つ「規約同意の記録」はドメインが異なる。同じJSONに同居させると、片方の保存処理が
// もう片方のフィールドを消してしまう事故につながるため、redisキーを分離する。

import { redis, redisKey } from './redis';
import { stripe, getStripeCustomerIdByEmail } from './subscription';

// 利用規約の現在の版。
//
// 【版を上げるときの注意】CURRENT_TOS_EFFECTIVE_AT を必ず同時に更新すること。
// 版だけを上げて基準時刻を据え置くと、旧版のときに同意した過去のCheckout
// セッションを detectAndRecordCheckoutConsent() が新版への同意として誤って
// 自動記録してしまう(旧版の同意が新版にも有効だったことにされてしまう)。
export const CURRENT_TOS_VERSION = 'v1';

// CURRENT_TOS_VERSION の版が効力を持ち始めた時刻(Unix秒)。この時刻より前に
// 作られたCheckoutセッションの同意は、この版への同意の根拠として使わない。
// v1 は consent_collection 導入前の版であり、そもそも同意付きセッションが
// 存在しないため 0(Unixエポック)で問題ない。
export const CURRENT_TOS_EFFECTIVE_AT = 0;

export const tosConsentKey = (email) => redisKey('tos', email);

/** 保存済みの同意記録を返す。無ければ null。 */
export async function getTosConsent(email) {
  return redis.get(tosConsentKey(email));
}

/** 保存済みの同意記録が現行版のものか。 */
export function isTosConsentCurrent(consent) {
  return !!consent && consent.version === CURRENT_TOS_VERSION;
}

/**
 * 同意を記録する。
 * @param {string} email
 * @param {{source: string, sessionId?: string}} options
 *   source ... 'gate'(アプリ内の確認ボタン) | 'stripe_checkout'(Checkoutでの同意を検出)
 *   sessionId ... 'stripe_checkout' のとき、根拠にしたCheckoutセッションのid
 */
export async function recordTosConsent(email, { source, sessionId } = {}) {
  await redis.set(tosConsentKey(email), {
    version: CURRENT_TOS_VERSION,
    acceptedAt: Date.now(),
    source,
    ...(sessionId ? { sessionId } : {}),
  });
}

/**
 * Checkoutのconsent_collectionで取得済みの同意があれば tos:{email} に自動記録する。
 * 呼び出し元(api/login.js)は、tos:{email} が未記録/旧版のときだけこれを呼ぶ想定。
 *
 * Stripeへの往復は customers.list と checkout.sessions.list の2回。
 * getStripeCustomerIdByEmail() は checkActiveSubscriptionLive() 側でも呼ばれて
 * いるため、ログイン1回あたり customers.list が重複して2回走ることになるが、
 * checkActiveSubscriptionLive() の戻り値からは顧客IDを取り出せない(customerFound:
 * booleanのみ)ため、同関数を無改修のまま済ませる代償として許容する。
 *
 * 【失敗時はfalseを返すだけで例外を投げない】Stripe側の障害・タイムアウトで
 * ログイン自体を止めたくないため、呼び出し元でtry/catchを書かせず、ここで
 * 吸収してログにだけ残す。
 *
 * @returns {Promise<boolean>} 記録できたら true
 */
export async function detectAndRecordCheckoutConsent(email) {
  try {
    const customerId = await getStripeCustomerIdByEmail(email);
    if (!customerId) return false;

    const sessions = await stripe.checkout.sessions.list({
      customer: customerId,
      status: 'complete',
      limit: 10,
    });

    const accepted = (sessions.data || []).find(
      (s) => s.consent?.terms_of_service === 'accepted' && s.created >= CURRENT_TOS_EFFECTIVE_AT
    );
    if (!accepted) return false;

    await recordTosConsent(email, { source: 'stripe_checkout', sessionId: accepted.id });
    return true;
  } catch (err) {
    console.error('[legalConsent] Checkoutセッションからの同意記録に失敗しました:', err);
    return false;
  }
}
