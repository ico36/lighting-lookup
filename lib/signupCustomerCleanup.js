// lib/signupCustomerCleanup.js
// 未決済の申し込みで先に作られたStripe Customerの掃除。
//
// api/checkout.js のhandleCreateCheckoutは、社名をcustomer.nameに反映し初回の
// 請求書・領収書の宛名に間に合わせるため、Checkoutセッションを作る前に
// customers.create()でCustomerを先に作る。決済を完了しないまま放置されると、
// このCustomer(社名・メールアドレスを含む)がStripeに無期限に残ってしまう
// (lib/ownerDeletion.jsの「解約から6か月」はRedisのcompany:*/tos:*キーを起点に
// するため、一度もログインしていないこのCustomerは対象にならない)。これを
// 別に掃除するための仕組み。
//
// 【メールではなく顧客IDで管理する理由】同一メールに複数のCustomerが存在する
// 場合、lib/subscription.jsのgetStripeCustomerIdByEmail()は先頭1件しか見ない。
// 掃除対象は「このcreate-checkoutが作ったその1件」なので、作成直後に得た
// customer.idをそのままZSETのmemberにする。
//
// 【判定にgetActiveSubscriptionWithItem()を使わない理由】あの関数はメールから
// customers.list(limit:1)で顧客を引き直す経路を経由するため、このCustomer自体の
// 契約有無の判定には使えない(別のCustomerの契約を見てしまう可能性がある)。
// ここではcustomerId自身に対してsubscriptions.list({customer: customerId,
// status:'all'})を直接呼ぶ。照明サーチ以外のPriceも含めて絞り込まない
// (「本当に一度も契約していないか」を保守的に判定するため)。

import { redis, redisKey } from './redis';
import { stripe } from './subscription';

export const SIGNUP_PENDING_CUSTOMER_KEY = redisKey('signup', 'pending-customer');

// Checkoutセッションの有効期限(最大24時間)より長くする。有効期限内に別タブ・
// 別の機会で決済を完了する猶予を潰さないため。
export const SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS = 7;

/**
 * 掃除のドライラン切り替え。lib/ownerDeletion.js の isOwnerDeletionDryRun() と
 * 同じ方式('false'という文字列と厳密一致したときだけ実削除)。本番でこの機能を
 * 有効化する初期値は必ずドライランにする。
 */
export function isSignupCustomerCleanupDryRun() {
  return process.env.SIGNUP_CUSTOMER_CLEANUP_DRY_RUN !== 'false';
}

/**
 * customers.create()に成功した直後に呼ぶ。member=customer.id、score=作成時刻(ms)。
 */
export async function registerPendingSignupCustomer(customerId, { now = Date.now() } = {}) {
  await redis.zadd(SIGNUP_PENDING_CUSTOMER_KEY, { score: now, member: customerId });
}

/**
 * 猶予期間(7日)を過ぎたエントリを処理する。api/cron/process-cases.js から呼ぶ。
 *
 * 1件でも契約(status:'all'、照明サーチ以外のPriceも含む)が見つかれば、対象外に
 * なったと判断してZSETから外すだけにする(ドライラン中でも外す。これは「削除」
 * ではなく「対象外になった候補の掃除」なので、決定事項のドライラン保持の対象外)。
 *
 * 契約が無ければ削除対象。ドライラン中はログだけ出してZSETに残す(ドライランを
 * 解除したときに対象が消えていないようにするため)。ドライランでなければ
 * customers.del()し、成功した場合だけZSETから外す。
 *
 * @param {{now?: number}} options
 */
export async function processPendingSignupCustomers({ now = Date.now() } = {}) {
  const dryRun = isSignupCustomerCleanupDryRun();
  const cutoff = now - SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const results = { removedHasSubscription: [], deleted: [], dryRunTargets: [], errors: [] };

  const dueCustomerIds = await redis.zrange(SIGNUP_PENDING_CUSTOMER_KEY, 0, cutoff, { byScore: true });

  for (const customerId of dueCustomerIds) {
    let subscriptions;
    try {
      subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    } catch (err) {
      console.error(`[signupCustomerCleanup] ${customerId} の契約確認に失敗しました:`, err);
      results.errors.push({ customerId, step: 'list-subscriptions', message: err.message });
      continue; // 予定は変更せず翌日再試行
    }

    if ((subscriptions.data || []).length > 0) {
      await redis.zrem(SIGNUP_PENDING_CUSTOMER_KEY, customerId);
      results.removedHasSubscription.push(customerId);
      console.log(`[signupCustomerCleanup] ${customerId} は契約が見つかったため削除対象から外しました`);
      continue;
    }

    if (dryRun) {
      results.dryRunTargets.push(customerId);
      console.log(
        `[signupCustomerCleanup] (dry-run) ${customerId} は削除予定です` +
          `(未決済のまま${SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS}日を超過)`
      );
      continue;
    }

    try {
      await stripe.customers.del(customerId);
    } catch (err) {
      console.error(`[signupCustomerCleanup] ${customerId} の削除に失敗しました:`, err);
      results.errors.push({ customerId, step: 'delete-customer', message: err.message });
      continue; // 予定を残して翌日再試行
    }

    await redis.zrem(SIGNUP_PENDING_CUSTOMER_KEY, customerId);
    results.deleted.push(customerId);
    console.log(`[signupCustomerCleanup] ${customerId} を削除しました`);
  }

  return results;
}
