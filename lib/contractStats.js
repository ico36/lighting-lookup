// lib/contractStats.js
// 経営統計ページ(stats.ma-system.co.jp)向け、「現在、照明サーチの契約が有効
// (LIVE_STATUSES=active/trialing)なアカウント」の管理と都道府県別集計。
//
// 【表示・集計のたびにStripeへ問い合わせない】api/stats/overview.jsや週次集計
// (lib/statsWeeklyEmail.js)がこのファイルの集計関数を呼ぶたびにStripeへ問い合わせる
// と、2026-11-02の「cronのStripe問い合わせを減らす」方針と食い違う。そのため
// 「現在有効かどうか」はWebhook(api/stripe-webhook.js)が契約状態の変化のたびに
// 更新するRedisのSET(CONTRACT_STATUS_ACTIVE_KEY)に記録しておき、集計はこのSETと
// company:{email}(都道府県)だけを読む。
//
// 【SADD/SREMの実行元】
//   - syncContractStatus(email) ... Webhookから契約ごとに呼ぶ。現在の状態を
//     Stripeへ取り直してから(event.data.objectの中身は信用しない。
//     lib/welcomeEmail.jsのmaybeSendWelcomeEmail()と同じ考え方)SADD/SREMする。
//   - reconcileActiveSet(seenEmails) ... 日次cronの保険(会員番号採番と同じ
//     candidatesを使い回す)。Webhookの取りこぼし(customer.subscription.deletedが
//     届かなかった等)でSETに残り続けた「今はもう有効でない」メールアドレスを
//     SREMする。候補一覧は既に取得済みのため、追加のStripe往復は発生しない。
//
// 【削除待ちの件数】lib/ownerDeletion.jsのOWNER_DELETION_SCHEDULE_KEY(ZSET)を
// そのまま再利用する。ただし「6か月以内に再契約した」メールアドレスは、削除予定の
// 期日が来るまでこのZSETに残り続けるため、そのままzcard()すると「契約中」と
// 「削除待ち」の両方に数えてしまう。CONTRACT_STATUS_ACTIVE_KEYに含まれるメンバーは
// 除いてから数える(getPendingDeletionCount())。

import { redis, redisKey } from './redis';
import { getActiveSubscriptionWithItem } from './subscription';
import { isAdminEmail } from './adminEmails';
import { PREFECTURES } from './prefectures';
import { OWNER_DELETION_SCHEDULE_KEY } from './ownerDeletion';

export const CONTRACT_STATUS_ACTIVE_KEY = redisKey('contract-status', 'active');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * 契約ごとにWebhookから呼ぶ。現在の状態をStripeへ取り直し(照明サーチの3Priceへの
 * 絞り込み・有効ステータス判定はgetActiveSubscriptionWithItem()に委ねる)、
 * 有効ならSADD、そうでなければSREMする。
 *
 * @param {string} rawEmail
 * @returns {Promise<boolean>} 現在有効と判定したかどうか
 */
export async function syncContractStatus(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return false;

  const { subscription } = await getActiveSubscriptionWithItem(email);

  if (subscription) {
    await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, email);
    return true;
  }

  await redis.srem(CONTRACT_STATUS_ACTIVE_KEY, email);
  return false;
}

/**
 * 日次cronの保険。seenEmails(今回のcron実行で「現在有効」と確認できた
 * メールアドレスの集合)に含まれないメンバーをCONTRACT_STATUS_ACTIVE_KEYから
 * 取り除く。Webhookの取りこぼしで有効でなくなった契約がSETに残り続けるのを防ぐ。
 *
 * @param {Set<string>|string[]} seenEmails
 * @returns {Promise<{removed: string[]}>}
 */
export async function reconcileActiveSet(seenEmails) {
  const seenSet = seenEmails instanceof Set ? seenEmails : new Set(seenEmails);
  const members = await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY);
  const stale = members.filter((email) => !seenSet.has(email));

  for (const email of stale) {
    await redis.srem(CONTRACT_STATUS_ACTIVE_KEY, email);
  }

  return { removed: stale };
}

/**
 * 現在有効な契約を都道府県別に集計する。lib/companyStats.jsのbuildPrefectureStats()
 * と考え方は同じ(管理者除外・都道府県未登録は「未登録」・北から順)だが、対象が
 * 「company:を持つ全アカウント」ではなく「CONTRACT_STATUS_ACTIVE_KEYに含まれる、
 * 現在有効な契約だけ」という点が異なる(解約後6か月以内でcompany:が残っている
 * アカウントは数えない)。
 *
 * @returns {Promise<{total: number, unregistered: number, byPrefecture: Record<string, number>}>}
 */
export async function buildActiveContractPrefectureStats() {
  const members = await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY);
  const targets = members.filter((email) => !isAdminEmail(email));

  const countByPrefecture = new Map();
  let unregistered = 0;

  if (targets.length > 0) {
    const keys = targets.map((email) => redisKey('company', email));
    const values = await redis.mget(...keys);

    values.forEach((value) => {
      const company = value && typeof value === 'object' ? value : null;
      const prefecture = company?.prefecture;
      if (prefecture) {
        countByPrefecture.set(prefecture, (countByPrefecture.get(prefecture) || 0) + 1);
      } else {
        unregistered++;
      }
    });
  }

  const byPrefecture = {};
  for (const prefecture of PREFECTURES) {
    const count = countByPrefecture.get(prefecture) || 0;
    if (count > 0) byPrefecture[prefecture] = count;
  }

  return { total: targets.length, unregistered, byPrefecture };
}

/**
 * 解約済みで削除待ち(owner-deletion:scheduleに登録されている)の件数。
 * 6か月以内に再契約してCONTRACT_STATUS_ACTIVE_KEYに戻っているメールアドレスは
 * 除いて数える(ファイル冒頭のコメント参照)。
 *
 * @returns {Promise<number>}
 */
export async function getPendingDeletionCount() {
  const scheduled = await redis.zrange(OWNER_DELETION_SCHEDULE_KEY, 0, -1);
  if (scheduled.length === 0) return 0;

  const activeMembers = await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY);
  const activeSet = new Set(activeMembers);
  return scheduled.filter((email) => !activeSet.has(email)).length;
}
