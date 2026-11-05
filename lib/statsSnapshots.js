// lib/statsSnapshots.js
// 経営統計ページ(stats.ma-system.co.jp)向け、週次スナップショットの保存・取得・差分計算。
//
// Redisキー(いずれも redisKey() 経由。Preview環境では preview: 接頭辞):
//   stats:weekly:{YYYY-MM-DD}  ... そのJST月曜の集計結果(JSON)。
//     { byPrefecture, unregistered, total, pendingDeletion, capturedAt }
//   stats:weekly-index         ... ZSET。member=日付文字列、score=capturedAt(ms epoch)。
//     日付の昇順・降順での取得(直近N件の履歴、直近のスナップショット)に使う。
//
// 【同じ日付の保存は上書きでよい】日次cronが同じ月曜に2回以上動いても、保存する
// 内容はほぼ同じ時刻に計算した同じ集計なので、上書きで実害は無い(送信済みメールの
// ような不可逆の副作用とは違う)。そのため保存前の存在確認は行わない。
//
// 【「直近のスナップショット」は今日の日付を除外してから選ぶ】同じ月曜に2回cronが
// 動いた場合、2回目の実行が「直近のスナップショット」として自分自身(1回目が保存した
// 今日の分)を参照してしまうと、先週との差分が常にゼロになる事故になる。
// getPreviousSnapshot()は呼び出し側が渡す今日の日付を除外してから最新を選ぶ。

import { redis, redisKey } from './redis';
import { PREFECTURES } from './prefectures';

export const WEEKLY_SNAPSHOT_INDEX_KEY = redisKey('stats', 'weekly-index');

function weeklySnapshotKey(dateStr) {
  return redisKey('stats', 'weekly', dateStr);
}

/**
 * 週次スナップショットを保存する(同じ日付なら上書き)。
 *
 * @param {string} dateStr "YYYY-MM-DD"(JST月曜の日付)
 * @param {{byPrefecture: Record<string, number>, unregistered: number, total: number, pendingDeletion: number, capturedAt: number}} data
 */
export async function saveWeeklySnapshot(dateStr, data) {
  await redis.set(weeklySnapshotKey(dateStr), data);
  await redis.zadd(WEEKLY_SNAPSHOT_INDEX_KEY, { score: data.capturedAt, member: dateStr });
}

/**
 * 指定した日付のスナップショットを取得する。無ければnull。
 * @param {string} dateStr
 */
export async function getSnapshot(dateStr) {
  return (await redis.get(weeklySnapshotKey(dateStr))) || null;
}

/**
 * 直近のスナップショットを取得する。excludeDateStr(今日の日付)は比較対象から外す。
 * 保存済みのスナップショットが無ければnull。
 *
 * @param {string} [excludeDateStr]
 * @returns {Promise<({date: string} & object) | null>}
 */
export async function getPreviousSnapshot(excludeDateStr) {
  // zrangeは昇順(score=capturedAtの小さい順)で返るため、除外したあとの末尾が最新。
  const dates = await redis.zrange(WEEKLY_SNAPSHOT_INDEX_KEY, 0, -1);
  const candidates = excludeDateStr ? dates.filter((d) => d !== excludeDateStr) : dates;
  if (candidates.length === 0) return null;

  const latestDate = candidates[candidates.length - 1];
  const snapshot = await getSnapshot(latestDate);
  if (!snapshot) return null;

  return { date: latestDate, ...snapshot };
}

/**
 * 直近N件のスナップショットを古い順(推移グラフ向け)で返す。
 * @param {number} limit
 * @returns {Promise<Array<{date: string} & object>>}
 */
export async function getSnapshotHistory(limit) {
  const dates = await redis.zrange(WEEKLY_SNAPSHOT_INDEX_KEY, 0, -1);
  const recentDates = dates.slice(-limit); // zrangeは昇順なので末尾側が新しい
  const snapshots = await Promise.all(recentDates.map((date) => getSnapshot(date)));

  return recentDates
    .map((date, i) => (snapshots[i] ? { date, ...snapshots[i] } : null))
    .filter(Boolean);
}

/**
 * 現在値とスナップショット(直近または任意の比較対象)の差分を計算する。
 * previousがnull(保存した記録が無い＝初回)の場合はnullを返す
 * (呼び出し側は「初回のため増減なし」のように扱う)。
 *
 * @param {{total: number, unregistered: number, byPrefecture: Record<string, number>}} current
 * @param {{total: number, unregistered: number, byPrefecture: Record<string, number>} | null} previous
 * @returns {{totalDelta: number, unregisteredDelta: number, byPrefectureDelta: Record<string, number>} | null}
 */
export function computeDiff(current, previous) {
  if (!previous) return null;

  const byPrefectureDelta = {};
  for (const prefecture of PREFECTURES) {
    const delta = (current.byPrefecture[prefecture] || 0) - (previous.byPrefecture[prefecture] || 0);
    if (delta !== 0) byPrefectureDelta[prefecture] = delta;
  }

  return {
    totalDelta: current.total - previous.total,
    unregisteredDelta: current.unregistered - previous.unregistered,
    byPrefectureDelta,
  };
}
