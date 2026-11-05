// tests/lib/contractStats.test.mjs
// lib/contractStats.js の単体テスト。
//   - syncContractStatus(): Webhookから呼ばれる想定の、現在有効かどうかの再判定
//   - reconcileActiveSet(): 日次cronの保険。取りこぼしの除去
//   - buildActiveContractPrefectureStats(): 都道府県別集計
//   - getPendingDeletionCount(): 削除待ち件数(6か月以内に再契約した分の除外含む)

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACT_STATUS_ACTIVE_KEY,
  syncContractStatus,
  reconcileActiveSet,
  buildActiveContractPrefectureStats,
  getPendingDeletionCount,
} from '../../lib/contractStats.js';
import { OWNER_DELETION_SCHEDULE_KEY } from '../../lib/ownerDeletion.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  delete process.env.ADMIN_EMAILS;
});

function wireSubscription({ email, customerId = 'cus_test', priceId = 'price_standard_test', status = 'active' }) {
  fakeStripe.__setHandler('customers.list', async (params) => {
    if (params.email !== email) return { data: [] };
    return { data: [{ id: customerId }] };
  });
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.customer !== customerId) return { data: [] };
    return {
      data: [{
        id: `sub_${customerId}`,
        customer: customerId,
        status,
        items: { data: [{ id: `si_${customerId}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
      }],
    };
  });
}

// --- syncContractStatus() ---

test('syncContractStatus(): 有効な契約ならSADDし、trueを返す', async () => {
  const email = 'active@example.com';
  wireSubscription({ email });

  const result = await syncContractStatus(email);

  assert.equal(result, true);
  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), [email]);
});

test('syncContractStatus(): 有効でない(incomplete)契約ならSREMし、falseを返す', async () => {
  const email = 'incomplete@example.com';
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, email); // 以前は有効だった想定
  wireSubscription({ email, status: 'incomplete' });

  const result = await syncContractStatus(email);

  assert.equal(result, false);
  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), []);
});

test('syncContractStatus(): KYノートなど照明サーチ以外のPriceならSADDしない', async () => {
  const email = 'ky-note@example.com';
  wireSubscription({ email, priceId: 'price_other_product' });

  const result = await syncContractStatus(email);

  assert.equal(result, false);
  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), []);
});

// --- reconcileActiveSet() ---

test('reconcileActiveSet(): seenEmailsに含まれないメンバーをSREMし、removedで返す', async () => {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'stale@example.com', 'current@example.com');

  const result = await reconcileActiveSet(new Set(['current@example.com']));

  assert.deepEqual(result.removed, ['stale@example.com']);
  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), ['current@example.com']);
});

test('reconcileActiveSet(): 配列でも渡せる', async () => {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'stale@example.com', 'current@example.com');

  const result = await reconcileActiveSet(['current@example.com']);

  assert.deepEqual(result.removed, ['stale@example.com']);
});

// --- buildActiveContractPrefectureStats() ---

test('buildActiveContractPrefectureStats(): 都道府県別に集計し、北から順に並ぶ', async () => {
  await redis.sadd(
    CONTRACT_STATUS_ACTIVE_KEY,
    'tokyo-1@example.com',
    'tokyo-2@example.com',
    'hokkaido@example.com'
  );
  await redis.set(redisKey('company', 'tokyo-1@example.com'), { name: 'A', prefecture: '東京都' });
  await redis.set(redisKey('company', 'tokyo-2@example.com'), { name: 'B', prefecture: '東京都' });
  await redis.set(redisKey('company', 'hokkaido@example.com'), { name: 'C', prefecture: '北海道' });

  const result = await buildActiveContractPrefectureStats();

  assert.equal(result.total, 3);
  assert.equal(result.unregistered, 0);
  assert.deepEqual(Object.keys(result.byPrefecture), ['北海道', '東京都']); // 北から順
  assert.equal(result.byPrefecture['東京都'], 2);
  assert.equal(result.byPrefecture['北海道'], 1);
});

test('buildActiveContractPrefectureStats(): company:が無い、またはprefectureが無いものは未登録に数える', async () => {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'no-company@example.com', 'no-prefecture@example.com');
  await redis.set(redisKey('company', 'no-prefecture@example.com'), { name: 'B' }); // prefecture無し

  const result = await buildActiveContractPrefectureStats();

  assert.equal(result.total, 2);
  assert.equal(result.unregistered, 2);
  assert.deepEqual(result.byPrefecture, {});
});

test('buildActiveContractPrefectureStats(): 管理者アカウントは除外する(防御的フィルタ)', async () => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'admin@example.com', 'customer@example.com');
  await redis.set(redisKey('company', 'customer@example.com'), { name: 'C', prefecture: '沖縄県' });

  const result = await buildActiveContractPrefectureStats();

  assert.equal(result.total, 1);
  assert.deepEqual(result.byPrefecture, { 沖縄県: 1 });
});

test('buildActiveContractPrefectureStats(): SETが空ならtotal/unregisteredともに0', async () => {
  const result = await buildActiveContractPrefectureStats();
  assert.deepEqual(result, { total: 0, unregistered: 0, byPrefecture: {} });
});

// --- getPendingDeletionCount() ---

test('getPendingDeletionCount(): owner-deletion:scheduleの件数をそのまま返す(contract-status:activeに無い場合)', async () => {
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now(), member: 'canceled-1@example.com' });
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now(), member: 'canceled-2@example.com' });

  assert.equal(await getPendingDeletionCount(), 2);
});

test('getPendingDeletionCount(): 6か月以内に再契約してcontract-status:activeに戻っているメールアドレスは数えない', async () => {
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now(), member: 'resubscribed@example.com' });
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now(), member: 'still-canceled@example.com' });
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'resubscribed@example.com');

  const count = await getPendingDeletionCount();

  assert.equal(count, 1, '再契約済みの1件を除いた残り1件だけを数えるはず');
});

test('getPendingDeletionCount(): owner-deletion:scheduleが空なら0(Stripeへの照会に相当する処理は発生しない)', async () => {
  assert.equal(await getPendingDeletionCount(), 0);
});
