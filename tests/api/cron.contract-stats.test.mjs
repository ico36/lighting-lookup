// tests/api/cron.contract-stats.test.mjs
// api/cron/process-cases.js ステップ6(経営統計「現在有効」SETの保険)と
// ステップ7(経営統計の週次レポートの呼び出し配線)のテスト。
//
// ステップ6は会員番号採番(保険)と同じcandidatesを使い回す設計のため、
// tests/api/cron.member-no.test.mjsのwireActiveSubscriptions()と同じ簡略版を
// このファイル専用に用意する。週次レポート自体の詳細な挙動(月曜判定・差分・
// 二重送信防止等)はtests/lib/statsWeeklyEmail.test.mjsで確認済みのため、ここでは
// 「cronのJSON結果にresults.weeklyStatsEmailが載ること」の配線確認に絞る。
//
// 【fetchのスタブが必須】ここで有効にするcandidatesはステップ5のウェルカムメール
// 送信保険(lib/welcomeEmail.js)も同時に経由する。globalThis.fetchをスタブしないと
// Resendへ実際にネットワークリクエストが飛んでしまう(tests/api/cron.welcome-email.
// test.mjsと同じ理由)。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cron/process-cases.js';
import { CONTRACT_STATUS_ACTIVE_KEY } from '../../lib/contractStats.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeBlob from '../support/fakes/blob.mjs';
import { __resetFakeRedis, redis } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';

const CRON_SECRET = 'test-cron-secret';
const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  fakeStripe.__reset();
  fakeBlob.__reset();
  __resetFakeRedis();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  delete process.env.VERCEL_ENV;
  delete process.env.STATS_VIEWER_EMAILS; // 週次レポートは宛先無しで送信自体は発生しない
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'email_test' }) });
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function callCron() {
  const req = fakeReq(undefined, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

/** @param {{id: string, customerId: string, email: string, priceId?: string}} e */
function wireActiveSubscription(e) {
  const priceId = e.priceId || 'price_standard_test';
  const nowSec = Math.floor(Date.now() / 1000);
  const sub = {
    id: e.id,
    customer: { id: e.customerId, email: e.email, metadata: {} },
    status: 'active',
    start_date: nowSec,
    items: { data: [{ id: `si_${e.id}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
  };

  fakeStripe.__setHandler('customers.list', async (params) => {
    if (params.email !== e.email) return { data: [] };
    return { data: [{ id: e.customerId }] };
  });
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.price) {
      if (params.price !== priceId) return { data: [] };
      return { data: params.status === sub.status ? [sub] : [] };
    }
    if (params.customer === e.customerId) return { data: [sub] };
    return { data: [] };
  });
}

test('現在有効な契約者は contract-status:active にバックフィルされる(追加のStripe往復なし)', async () => {
  const email = 'backfill@example.com';
  wireActiveSubscription({ id: 'sub_backfill', customerId: 'cus_backfill', email });

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), [email]);
});

test('今回のcandidatesに出てこなくなったメールアドレスはSETから除去される(取りこぼしの保険)', async () => {
  await redis.sadd(CONTRACT_STATUS_ACTIVE_KEY, 'stale@example.com', 'still-active@example.com');
  wireActiveSubscription({ id: 'sub_still', customerId: 'cus_still', email: 'still-active@example.com' });

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), ['still-active@example.com']);
  assert.deepEqual(res.body.contractStatusReconcile.removed, ['stale@example.com']);
});

test('cronのJSON結果にweeklyStatsEmailが含まれる(配線確認。詳細はlib側のテストで確認済み)', async () => {
  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok('weeklyStatsEmail' in res.body);
  assert.ok('ran' in res.body.weeklyStatsEmail);
});
