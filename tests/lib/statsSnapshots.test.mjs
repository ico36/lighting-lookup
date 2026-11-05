// tests/lib/statsSnapshots.test.mjs
// lib/statsSnapshots.js の単体テスト。保存・取得・「直近のスナップショット」の
// 今日除外ロジック・履歴取得・差分計算を対象にする。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  saveWeeklySnapshot,
  getSnapshot,
  getPreviousSnapshot,
  getSnapshotHistory,
  computeDiff,
} from '../../lib/statsSnapshots.js';
import { __resetFakeRedis } from '../support/fakes/redis.mjs';

beforeEach(() => {
  __resetFakeRedis();
});

function snapshot({ total, unregistered = 0, byPrefecture = {}, pendingDeletion = 0, capturedAt }) {
  return { total, unregistered, byPrefecture, pendingDeletion, capturedAt };
}

test('saveWeeklySnapshot()で保存したものをgetSnapshot()で取得できる', async () => {
  const data = snapshot({ total: 3, byPrefecture: { 東京都: 3 }, capturedAt: 1000 });
  await saveWeeklySnapshot('2026-11-02', data);

  assert.deepEqual(await getSnapshot('2026-11-02'), data);
});

test('getSnapshot(): 保存していない日付はnull', async () => {
  assert.equal(await getSnapshot('2026-11-02'), null);
});

test('saveWeeklySnapshot(): 同じ日付で2回保存すると上書きされる', async () => {
  await saveWeeklySnapshot('2026-11-09', snapshot({ total: 3, capturedAt: 1000 }));
  await saveWeeklySnapshot('2026-11-09', snapshot({ total: 5, capturedAt: 2000 }));

  const result = await getSnapshot('2026-11-09');
  assert.equal(result.total, 5);
});

test('getPreviousSnapshot(): 保存した記録が無ければnull', async () => {
  assert.equal(await getPreviousSnapshot('2026-11-09'), null);
});

test('getPreviousSnapshot(): 今日(excludeDateStr)自身は比較対象から除外する', async () => {
  // 同じ月曜にcronが2回動いた想定: 1回目が保存した今日の分だけがある状態。
  await saveWeeklySnapshot('2026-11-09', snapshot({ total: 5, capturedAt: 2000 }));

  assert.equal(await getPreviousSnapshot('2026-11-09'), null, '今日自身を比較対象にしてはいけない');
});

test('getPreviousSnapshot(): 今日を除いた直近(先週)のスナップショットを返す', async () => {
  await saveWeeklySnapshot('2026-11-02', snapshot({ total: 3, byPrefecture: { 東京都: 3 }, capturedAt: 1000 }));
  await saveWeeklySnapshot('2026-11-09', snapshot({ total: 5, byPrefecture: { 東京都: 5 }, capturedAt: 2000 }));

  const previous = await getPreviousSnapshot('2026-11-09');

  assert.equal(previous.date, '2026-11-02');
  assert.equal(previous.total, 3);
});

test('getSnapshotHistory(): 古い順でN件返す', async () => {
  await saveWeeklySnapshot('2026-10-26', snapshot({ total: 1, capturedAt: 1000 }));
  await saveWeeklySnapshot('2026-11-02', snapshot({ total: 2, capturedAt: 2000 }));
  await saveWeeklySnapshot('2026-11-09', snapshot({ total: 3, capturedAt: 3000 }));

  const history = await getSnapshotHistory(2);

  assert.deepEqual(history.map((h) => h.date), ['2026-11-02', '2026-11-09']);
  assert.deepEqual(history.map((h) => h.total), [2, 3]);
});

test('getSnapshotHistory(): 保存件数がlimit未満ならあるだけ返す', async () => {
  await saveWeeklySnapshot('2026-11-09', snapshot({ total: 3, capturedAt: 1000 }));

  const history = await getSnapshotHistory(5);
  assert.equal(history.length, 1);
});

test('computeDiff(): previousがnull(初回)ならnullを返す', () => {
  const current = { total: 3, unregistered: 0, byPrefecture: { 東京都: 3 } };
  assert.equal(computeDiff(current, null), null);
});

test('computeDiff(): 都道府県別の増減と合計の増減を計算する(増減ゼロの県は含めない)', () => {
  const current = { total: 5, unregistered: 1, byPrefecture: { 東京都: 3, 北海道: 1 } };
  const previous = { total: 3, unregistered: 0, byPrefecture: { 東京都: 2, 北海道: 1 } };

  const diff = computeDiff(current, previous);

  assert.equal(diff.totalDelta, 2);
  assert.equal(diff.unregisteredDelta, 1);
  assert.deepEqual(diff.byPrefectureDelta, { 東京都: 1 }); // 北海道は増減ゼロなので含まれない
});

test('computeDiff(): 減少(マイナス)も正しく計算する', () => {
  const current = { total: 2, unregistered: 0, byPrefecture: { 東京都: 2 } };
  const previous = { total: 4, unregistered: 0, byPrefecture: { 東京都: 2, 大阪府: 2 } };

  const diff = computeDiff(current, previous);

  assert.equal(diff.totalDelta, -2);
  assert.deepEqual(diff.byPrefectureDelta, { 大阪府: -2 });
});
