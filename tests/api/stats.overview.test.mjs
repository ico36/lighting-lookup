// tests/api/stats.overview.test.mjs
// api/stats/overview.js の単体テスト。認証(requireStatsAuth)・集計結果の形・
// Stripeへ一切問い合わせないことを確認する。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/stats/overview.js';
import { createStatsSessionToken } from '../../api/stats/_auth.js';
import { CONTRACT_STATUS_ACTIVE_KEY } from '../../lib/contractStats.js';
import { saveWeeklySnapshot } from '../../lib/statsSnapshots.js';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';
import * as fakeStripe from '../support/fakes/stripe.mjs';

beforeEach(() => {
  __resetFakeRedis();
  fakeStripe.__reset();
  process.env.STATS_SESSION_SECRET = 'stats-secret';
  process.env.STATS_VIEWER_EMAILS = 'shibata@example.com';
});

async function callOverview(overrides = {}) {
  const req = fakeReq(undefined, { method: 'GET', ...overrides });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

function authHeader() {
  const token = createStatsSessionToken('shibata@example.com');
  return { headers: { authorization: `Bearer ${token}` } };
}

test('未認証(トークン無し)なら401で、統計の内容は含まれない', async () => {
  const res = await callOverview();
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.current, undefined);
});

test('認証済みなら現在値・削除待ち件数・比較・履歴を返す(初回は比較対象が無い)', async () => {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'customer@example.com');
  await redis.set(redisKey('company', 'customer@example.com'), { name: 'A', prefecture: '東京都' });

  const res = await callOverview(authHeader());

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.current, { total: 1, unregistered: 0, byPrefecture: { 東京都: 1 } });
  assert.equal(res.body.pendingDeletion, 0);
  assert.deepEqual(res.body.comparison, {
    baselineDate: null,
    totalDelta: null,
    unregisteredDelta: null,
    byPrefectureDelta: null,
  });
  assert.deepEqual(res.body.history, []);
});

test('直近のスナップショットがあれば、今日の日付でも除外せず比較対象にする', async () => {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'customer@example.com');
  await redis.set(redisKey('company', 'customer@example.com'), { name: 'A', prefecture: '東京都' });
  await saveWeeklySnapshot('2026-11-09', {
    total: 1,
    unregistered: 0,
    byPrefecture: { 東京都: 1 },
    pendingDeletion: 0,
    capturedAt: Date.now(),
  });

  const res = await callOverview(authHeader());

  assert.equal(res.body.comparison.baselineDate, '2026-11-09');
  assert.equal(res.body.comparison.totalDelta, 0);
  assert.deepEqual(res.body.history, [{ date: '2026-11-09', total: 1 }]);
});

test('Stripeへは一切問い合わせない', async () => {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'customer@example.com');

  await callOverview(authHeader());

  assert.deepEqual(fakeStripe.__getCallLog(), []);
});

test('GET以外は405', async () => {
  const res = await callOverview({ method: 'POST', ...authHeader() });
  assert.equal(res.statusCode, 405);
});
