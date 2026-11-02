// lib/memberNo.js
// 照明サーチの会員番号(ls_member_no)の発番・取得。
//
// 【保存場所】Redis(redisKey('ls_member_no', 'by_email', email))を正とする。
// Stripe顧客のmetadata.ls_member_noは写し(将来のコミュニティサイト連携など、
// Stripe側からも参照できるようにするためのミラー)。書き込みが片方失敗しても、
// 次回の呼び出し(Webhook再送・ログイン・日次cronのいずれか)でRedisの値を
// 元にStripe側を書き直すだけなので、番号が欠番にならない(決定事項)。
//
// 【メールアドレス単位にした理由】解約→再契約で同じStripe顧客が使い回されるのが
// 通常のケースだが、万一別のStripe Customerオブジェクトが同じメールで新たに
// 作られても(例: 将来KYノート側が独自にCustomerを作る等)、メールアドレスを
// キーにしておけば自動的に同じ番号を引き継げる。1アカウント=1メールという
// このサービスの設計(CLAUDE.md参照)とも一致する。
//
// 【他製品(KYノート等)との混在対策】getActiveSubscriptionWithItem()が既に
// 照明サーチの3Price(STRIPE_PRICE_ID_LIGHT/STANDARD/PRO)への絞り込みと
// 有効ステータス(active/trialing)判定を行っているため、ここでは何も
// 判定ロジックを持たず、その結果(subscriptionがnullかどうか)だけを見る。
// 呼び出し側(Webhook・ログイン・日次cron)はメールアドレスを渡すだけでよい。

import { redis, redisKey } from './redis';
import { stripe, getActiveSubscriptionWithItem } from './subscription';

const LOCK_TTL_SECONDS = 30;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * 表示用に整形する(LS-000001形式)。保存は数値文字列のまま、整形はここでだけ行う。
 * @param {string|number|null|undefined} no
 * @returns {string|null}
 */
export function formatMemberNo(no) {
  const n = Number(no);
  if (!Number.isInteger(n) || n <= 0) return null;
  return `LS-${String(n).padStart(6, '0')}`;
}

/**
 * Redisの対応表に保存されている番号を取得する(整形前の生の値)。Stripeへは一切
 * 問い合わせない。日次cronの保険ステップが、Stripe顧客metadataの写しと食い違って
 * いないか比べるために使う(getMemberNo()の値とmetadata.ls_member_noの両方が
 * あって一致していれば、assignMemberNoIfMissing()を呼ばずに済ませる)。
 *
 * @param {string} rawEmail
 * @returns {Promise<string|null>}
 */
export async function getMemberNo(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;
  return (await redis.get(redisKey('ls_member_no', 'by_email', email))) || null;
}

/**
 * Redisの対応表だけを見て、既に会員番号があるかを確認する(Stripeへは一切問い合わせない)。
 * ログイン時のフォールバック呼び出し(api/login.js)が、既に番号がある利用者について
 * 毎回のログインでassignMemberNoIfMissing()のStripe往復(customers.list・
 * subscriptions.list・customers.retrieve)を発生させないための近道として使う。
 *
 * Stripe側の写し(metadata.ls_member_no)とのずれ直しはここでは行わない。
 * 日次cronの保険ステップが毎回assignMemberNoIfMissing()を呼ぶため、そちらに任せる。
 *
 * @param {string} rawEmail
 * @returns {Promise<boolean>}
 */
export async function hasMemberNo(rawEmail) {
  return Boolean(await getMemberNo(rawEmail));
}

/**
 * 指定したメールアドレスが照明サーチの有効な契約者で、まだ会員番号が無ければ発番する。
 * 既にある場合は何もしない(冪等)。KYノートのみの契約者・解約済み・契約なしは
 * getActiveSubscriptionWithItem() の結果(subscription === null)で自動的に除外される。
 *
 * Webhook(customer.subscription.created/updated)・ログイン時のフォールバック・
 * 日次cronの保険の3箇所すべてがこの関数を呼ぶ想定。
 *
 * @param {string} rawEmail
 * @returns {Promise<string|null>} 会員番号(数値文字列)。対象外・ロック競合時はnull
 */
export async function assignMemberNoIfMissing(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;

  const { customerId, subscription } = await getActiveSubscriptionWithItem(email);
  if (!subscription || !customerId) return null;

  const lockKey = redisKey('ls_member_no', 'lock', email);
  const acquired = await redis.set(lockKey, '1', { nx: true, ex: LOCK_TTL_SECONDS });
  if (!acquired) return null; // 他の呼び出し(Webhook/ログイン/cron)が同時に処理中

  try {
    const byEmailKey = redisKey('ls_member_no', 'by_email', email);
    let no = await redis.get(byEmailKey);
    const customer = await stripe.customers.retrieve(customerId);

    if (!no) {
      // Redisに無ければ、Stripe側の写しが残っていないか確認してから新規発番する
      // (Redisの対応表が何かの理由で消えても、Stripe側から元の番号に戻せるようにするため)。
      const fromStripe = customer?.metadata?.ls_member_no;
      no = fromStripe ? fromStripe : String(await redis.incr(redisKey('ls_member_no', 'counter')));
      await redis.set(byEmailKey, no);
    }

    if (customer?.metadata?.ls_member_no !== no) {
      await stripe.customers.update(customerId, { metadata: { ls_member_no: no } });
    }

    return no;
  } finally {
    await redis.del(lockKey);
  }
}
