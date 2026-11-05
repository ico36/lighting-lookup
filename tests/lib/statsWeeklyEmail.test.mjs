// tests/lib/statsWeeklyEmail.test.mjs
// lib/statsWeeklyEmail.js の runWeeklyStatsEmail() の単体テスト。
// 月曜判定・送信済みの印による二重送信防止・スナップショットの上書き保存・
// 宛先ごとの成否の集計を対象にする。
//
// 【Resend送信】lib/welcomeEmail.jsと同じ方式でglobalThis.fetchをスタブに差し替える。
// 【Stripeは使わない】buildActiveContractPrefectureStats()・getPendingDeletionCount()は
// どちらもRedisだけを読むため、fakeStripeは不要。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { runWeeklyStatsEmail } from '../../lib/statsWeeklyEmail.js';
import { CONTRACT_STATUS_ACTIVE_KEY } from '../../lib/contractStats.js';
import { getSnapshot } from '../../lib/statsSnapshots.js';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';

const REAL_FETCH = globalThis.fetch;

let fetchCalls;

beforeEach(() => {
  __resetFakeRedis();
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '経営統計 <noreply@example.com>';
  process.env.STATS_VIEWER_EMAILS = 'shibata@example.com';
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

// 2026-11-09は月曜、2026-11-10は火曜(JST 03:00=cronの実行時刻を想定)。
const MONDAY_MS = Date.UTC(2026, 10, 8, 18, 0, 0); // UTC 11/8 18:00 = JST 11/9 03:00
const TUESDAY_MS = Date.UTC(2026, 10, 9, 18, 0, 0); // JST 11/10 03:00

async function seedActiveAccount(email, prefecture) {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, email);
  await redis.set(redisKey('company', email), { name: 'test', prefecture });
}

test('月曜でなければ何もしない(送信なし・スナップショット保存なし)', async () => {
  await seedActiveAccount('customer@example.com', '東京都');

  const result = await runWeeklyStatsEmail({ now: TUESDAY_MS });

  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, 'not_monday');
  assert.equal(fetchCalls.length, 0);
  assert.equal(await getSnapshot('2026-11-10'), null);
});

test('月曜・初回(比較対象のスナップショットが無い)なら「初回のため増減なし」の本文で送る', async () => {
  await seedActiveAccount('customer@example.com', '東京都');

  const result = await runWeeklyStatsEmail({ now: MONDAY_MS });

  assert.equal(result.ran, true);
  assert.deepEqual(result.recipients.succeeded, ['shibata@example.com']);
  assert.deepEqual(result.recipients.failed, []);
  assert.equal(fetchCalls.length, 1);

  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(body.subject, '【経営統計】週次レポート');
  assert.match(body.text, /初回のため増減なし/);
  assert.match(body.text, /東京都 1件/);
  assert.match(body.text, /有効な契約：1件/);

  const snapshot = await getSnapshot('2026-11-09');
  assert.equal(snapshot.total, 1);
});

test('先週のスナップショットがあれば、差分入りの本文で送る', async () => {
  // 先週(2026-11-02、MONDAY_MSのちょうど7日前)は東京都1件だった想定のスナップショットを
  // 直接用意する(2026-11-02の集計自体はこのテストの対象外)。
  const { saveWeeklySnapshot } = await import('../../lib/statsSnapshots.js');
  await saveWeeklySnapshot('2026-11-02', {
    total: 1,
    unregistered: 0,
    byPrefecture: { 東京都: 1 },
    pendingDeletion: 0,
    capturedAt: Date.UTC(2026, 10, 1, 18, 0, 0),
  });

  // 今週(2026-11-09)は東京都2件に増えた。
  await seedActiveAccount('customer-1@example.com', '東京都');
  await seedActiveAccount('customer-2@example.com', '東京都');

  const result = await runWeeklyStatsEmail({ now: MONDAY_MS });

  assert.equal(result.ran, true);
  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.match(body.text, /先週\(2026-11-02\)から\+1/);
  assert.match(body.text, /東京都 2件\(\+1\)/);
});

test('同じ月曜に2回走っても2通目は送らないが、スナップショットは上書きする', async () => {
  await seedActiveAccount('customer@example.com', '東京都');

  const first = await runWeeklyStatsEmail({ now: MONDAY_MS });
  assert.equal(first.ran, true);
  assert.equal(fetchCalls.length, 1);

  await seedActiveAccount('customer-2@example.com', '北海道'); // 2回目の間に増えた想定
  const second = await runWeeklyStatsEmail({ now: MONDAY_MS + 60_000 });

  assert.equal(second.ran, true);
  assert.equal(second.skippedReason, 'already_sent_today');
  assert.equal(fetchCalls.length, 1, '2通目は送られていないはず');

  const snapshot = await getSnapshot('2026-11-09');
  assert.equal(snapshot.total, 2, 'スナップショットは2回目の内容で上書きされているはず');
});

test('宛先が複数で一部送信に失敗しても、残りは送信され、失敗は結果に記録される', async () => {
  process.env.STATS_VIEWER_EMAILS = 'ok@example.com,fail@example.com';
  await seedActiveAccount('customer@example.com', '東京都');

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    fetchCalls.push({ url, options });
    if (body.to[0] === 'fail@example.com') {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };

  const result = await runWeeklyStatsEmail({ now: MONDAY_MS });

  assert.deepEqual(result.recipients.succeeded, ['ok@example.com']);
  assert.equal(result.recipients.failed.length, 1);
  assert.equal(result.recipients.failed[0].to, 'fail@example.com');
});

test('STATS_VIEWER_EMAILSが空でも例外にならず、ranはtrueのまま終わる', async () => {
  delete process.env.STATS_VIEWER_EMAILS;
  await seedActiveAccount('customer@example.com', '東京都');

  const result = await runWeeklyStatsEmail({ now: MONDAY_MS });

  assert.equal(result.ran, true);
  assert.deepEqual(result.recipients.succeeded, []);
  assert.deepEqual(result.recipients.failed, []);
  assert.equal(fetchCalls.length, 0);
});
