// lib/subscription.js
// Stripeサブスクリプションの有効性チェック。
//   - api/login.js         : ログイン時のライブチェック(checkActiveSubscriptionLive)
//   - api/_auth.js の requireAuth() : 発行済みセッションの定期再チェック
//     (hasActiveSubscriptionCached、Redisキャッシュ経由)
//
// セッショントークン自体は発行時に固定された有効期限(30日)を署名検証するだけで
// Stripeには問い合わせない仕組みだったため、解約後も最大30日間アプリを使い続け
// られてしまう問題があった。requireAuth()経由でリクエストごとに再チェックする。

import Stripe from 'stripe';
import { redis } from './redis';

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// セッション再チェックでのキャッシュ有効期間。「解約してから実際にアクセスできなく
// なるまでの最大遅延」に相当する。短くするほどStripeへの問い合わせが増え、長くする
// ほど解約後の猶予が伸びる。利用者が数名規模の運用であることを踏まえ1時間とする。
const SUBSCRIPTION_CACHE_TTL_SECONDS = 60 * 60;

const subscriptionCacheKey = (email) => `subcheck:${email}`;

/**
 * Stripeに直接問い合わせて、顧客の有無と有効なサブスク(active/trialing)の有無を
 * 判定する。api/login.js はcustomerFound/activeを見て別々のエラーメッセージを
 * 出し分けており、requireAuth()の再チェック(hasActiveSubscriptionCached)は
 * activeだけを見る。
 */
export async function checkActiveSubscriptionLive(email) {
  const customers = await stripe.customers.list({ email, limit: 1 });
  if (customers.data.length === 0) {
    return { customerFound: false, active: false };
  }

  const customer = customers.data[0];
  const subscriptions = await stripe.subscriptions.list({
    customer: customer.id,
    status: 'all',
    limit: 10,
  });

  const active = subscriptions.data.some((sub) => ['active', 'trialing'].includes(sub.status));
  return { customerFound: true, active };
}

/**
 * セッション再検証用。Redisに短いTTLでキャッシュし、キャッシュが無ければStripeに
 * 再照会する。
 *
 * Stripe/Redis自体が障害・タイムアウトした場合は「有効」とみなして通す
 * (フェイルオープン)。このアプリは電気工事士が現場作業中に使うツールのため、
 * インフラ側の一時的な不調でログイン済みユーザーを締め出す実害の方が大きいと判断。
 * 障害時の結果はキャッシュしない＝Stripeが復旧すれば次のリクエストで正しい値に
 * 切り替わる。
 */
export async function hasActiveSubscriptionCached(email) {
  const key = subscriptionCacheKey(email);

  try {
    const cached = await redis.get(key);
    if (cached !== null && cached !== undefined) {
      return cached === true;
    }
  } catch (err) {
    console.error('[subscription] キャッシュ読み込みに失敗しました。Stripeへ直接照会します:', err);
  }

  let active;
  try {
    ({ active } = await checkActiveSubscriptionLive(email));
  } catch (err) {
    console.error('[subscription] Stripeへの照会に失敗しました。一時的に有効とみなします:', err);
    return true;
  }

  try {
    await redis.set(key, active, { ex: SUBSCRIPTION_CACHE_TTL_SECONDS });
  } catch (err) {
    console.error('[subscription] キャッシュ書き込みに失敗しました:', err);
  }

  return active;
}
