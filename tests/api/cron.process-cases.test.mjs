// tests/api/cron.process-cases.test.mjs
// api/cron/process-cases.js ステップ1(自動失注)の retentionDays 焼き込みの回帰。
//
// 【背景】所有者が「解約済み(customerFound:true, active:false)」または
// 「Stripe顧客なし(customerFound:false)」のとき、getSubscriptionStateCached()が
// DEFAULT_PLAN_LIMITS(retentionDays:-1)をdegraded:falseで返し、cronのdegraded
// チェックをすり抜けて-1がそのまま案件に焼き込まれていた(=二度とアーカイブされない)。
// lib/subscription.jsにOWNER_STATUS(admin/active/past_due/canceled/no_customer/
// unknown)を追加し、canceled/no_customerのときは「最後に契約していたプランの
// retention_days」→それも取れなければ「ライトプランのretention_days」の順で
// フォールバックする。past_due(支払い遅延中)は契約が終了していないため
// canceledとは区別し、現在の契約のプラン値をそのまま使う。
//
// 【loader.mjsの前提】lib/subscription.js の `./redis`(subcheck:{version}キャッシュ)と
// api/cron/process-cases.js の `../../lib/redis` をフェイクへ差し替え済み
// (tests/support/loader.mjs)。これが無いと非管理者メールでの
// getSubscriptionStateCached() が実クライアントへの接続を試み、テストごとに
// 数秒かかる(tests/api/login.verify-otp.test.mjsの既存コメント参照)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cron/process-cases.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis, redis } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import {
  STATUS,
  GLOBAL_OPEN_KEY,
  GLOBAL_TERMINAL_KEY,
  createCase,
  getCase,
} from '../../lib/cases.js';
import { AUTO_LOSE_GRACE_DAYS, DAY_MS } from '../../lib/planLimits.js';
import {
  getLightPlanRetentionDaysFallback,
  FALLBACK_RETENTION_DAYS_SAFE_NET,
} from '../../lib/subscription.js';

const CRON_SECRET = 'test-cron-secret';
const LIGHT_RETENTION_DAYS = 30; // fakes/stripe.mjs の price_light_test.metadata.retention_days
const STANDARD_RETENTION_DAYS = 365; // 同 price_standard_test

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  // getActiveSubscriptionWithItem()が照明サーチのPrice IDホワイトリストを
  // 必ず要求する(3つ揃っていないとgetLightingSearchPriceIds()が例外を投げる)。
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.ADMIN_EMAILS = 'admin@example.com';
  delete process.env.VERCEL_ENV;
});

async function callCron() {
  const req = fakeReq(undefined, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

// AUTO_LOSE_GRACE_DAYS日以上前からGLOBAL_OPEN_KEYに置かれている(=自動失注の対象)
// 案件を1件作る。createCase()はcases:openのスコアをDate.now()にするため、
// 作成後に明示的に過去へ書き換える。
async function createStaleOpenCase(email) {
  const record = await createCase(email, {}, { caseLimit: 5, initialStatus: STATUS.PENDING_APPROVAL });
  await redis.zadd(GLOBAL_OPEN_KEY, {
    score: Date.now() - (AUTO_LOSE_GRACE_DAYS + 1) * DAY_MS,
    member: record.id,
  });
  return record;
}

function customPrice({ id, plan, retentionDays }) {
  const metadata = { plan, search_limit: '100', case_limit: '30' };
  if (retentionDays !== undefined) metadata.retention_days = String(retentionDays);
  return { id, unit_amount: 0, currency: 'jpy', metadata, product: { id: `prod_${id}`, name: plan } };
}

function subscriptionWith({ id = 'sub_test', status, priceId, canceledAt, endedAt, createdAt }) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id,
    customer: 'cus_test',
    status,
    canceled_at: canceledAt ?? null,
    ended_at: endedAt ?? null,
    created: createdAt ?? nowSec,
    current_period_start: nowSec,
    current_period_end: nowSec + 30 * 24 * 60 * 60,
    items: { data: [{ id: `si_${id}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
  };
}

test('有効な契約者: 現在のプラン(standard)の保存期間が焼き込まれる', async () => {
  const email = 'active@example.com';
  const record = await createStaleOpenCase(email);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionWith({ status: 'active', priceId: 'price_standard_test' })],
  }));

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.autoLost, [record.id]);
  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, STANDARD_RETENTION_DAYS);
  assert.equal(updated.status, STATUS.LOST);
});

test('解約済み: 最後に契約していたプラン(standard)の保存期間が焼き込まれ、cases:terminalに登録される', async () => {
  const email = 'canceled@example.com';
  const record = await createStaleOpenCase(email);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [
      subscriptionWith({
        status: 'canceled',
        priceId: 'price_standard_test',
        endedAt: Math.floor(Date.now() / 1000) - 3600,
        canceledAt: Math.floor(Date.now() / 1000) - 3600,
      }),
    ],
  }));

  await callCron();

  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, STANDARD_RETENTION_DAYS);
  assert.notEqual(updated.retentionDays, -1);
  const terminalScore = await redis.zrange(GLOBAL_TERMINAL_KEY, 0, Number.MAX_SAFE_INTEGER, { byScore: true });
  assert.ok(terminalScore.includes(record.id), 'cases:terminalに登録され、将来アーカイブ対象になっていること');
});

test('解約済みでmetadata欠損(retention_daysなし): ライトプランの予備値(30)が焼き込まれる', async () => {
  const email = 'canceled-missing-meta@example.com';
  const record = await createStaleOpenCase(email);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [
      {
        ...subscriptionWith({ status: 'canceled', priceId: 'price_standard_test', endedAt: Math.floor(Date.now() / 1000) }),
        // Price IDは照明サーチのホワイトリスト(STRIPE_PRICE_ID_STANDARD)と
        // 一致させる必要がある(getActiveSubscriptionWithItem()のPrice ID絞り込み)。
        // retention_daysが無いmetadataでも、Price ID自体は実在の照明サーチPriceの
        // ままというのが「metadata欠損」の実態(Price IDが変わるわけではない)。
        items: {
          data: [{ id: 'si_missing', price: customPrice({ id: 'price_standard_test', plan: 'standard' }) }],
        },
      },
    ],
  }));

  await callCron();

  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, LIGHT_RETENTION_DAYS);
  assert.notEqual(updated.retentionDays, -1);
});

test('顧客なし: ライトプランの予備値(30)が焼き込まれる', async () => {
  const email = 'no-customer@example.com';
  const record = await createStaleOpenCase(email);
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  await callCron();

  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, LIGHT_RETENTION_DAYS);
  assert.notEqual(updated.retentionDays, -1);
});

test('degraded(Stripe障害): 従来どおり見送られ、retentionDaysは焼き込まれない', async () => {
  const email = 'degraded@example.com';
  const record = await createStaleOpenCase(email);
  fakeStripe.__setHandler('customers.list', async () => {
    throw new Error('stripe unavailable (test)');
  });

  const res = await callCron();

  assert.deepEqual(res.body.deferred, [record.id]);
  assert.deepEqual(res.body.autoLost, []);
  const updated = await getCase(record.id);
  assert.equal(updated.status, STATUS.PENDING_APPROVAL, 'ステータスは変更されない');
  assert.equal(updated.retentionDays, undefined, 'retentionDaysフィールドは付与されない');
});

test('管理者: 従来どおりADMIN_PLAN_LIMITS(-1=無期限)が焼き込まれ、cases:terminalには登録されない', async () => {
  const email = 'admin@example.com';
  const record = await createStaleOpenCase(email);
  // 管理者はStripeに問い合わせないため、stripeハンドラの設定は不要
  // (呼ばれたらテストの前提が崩れるので、あえて例外を投げるハンドラのままにする)
  fakeStripe.__setHandler('customers.list', async () => {
    throw new Error('管理者判定はStripeに問い合わせないはずなのに呼ばれた');
  });

  await callCron();

  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, -1);
  const terminal = await redis.zrange(GLOBAL_TERMINAL_KEY, 0, Number.MAX_SAFE_INTEGER, { byScore: true });
  assert.ok(!terminal.includes(record.id), '無制限プランはcases:terminalに登録されない(正常系)');
});

test('past_due(支払い遅延中): canceledとして扱われず、現在の契約(standard)の保存期間がそのまま使われる', async () => {
  const email = 'past-due@example.com';
  const record = await createStaleOpenCase(email);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionWith({ status: 'past_due', priceId: 'price_standard_test' })],
  }));

  await callCron();

  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, STANDARD_RETENTION_DAYS);
});

test('incomplete_expiredしかない所有者: 最後のプラン候補が無いため予備値(30)が焼き込まれる', async () => {
  const email = 'incomplete-only@example.com';
  const record = await createStaleOpenCase(email);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionWith({ status: 'incomplete_expired', priceId: 'price_standard_test' })],
  }));

  await callCron();

  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, LIGHT_RETENTION_DAYS);
});

test('終了済みの契約が複数ある所有者: ended_atが最も新しいものが選ばれる', async () => {
  const email = 'multi-ended@example.com';
  const record = await createStaleOpenCase(email);
  const nowSec = Math.floor(Date.now() / 1000);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [
      subscriptionWith({ id: 'sub_old', status: 'canceled', priceId: 'price_light_test', endedAt: nowSec - 200 * 24 * 60 * 60 }),
      subscriptionWith({ id: 'sub_new', status: 'canceled', priceId: 'price_standard_test', endedAt: nowSec - 10 * 24 * 60 * 60 }),
    ],
  }));

  await callCron();

  const updated = await getCase(record.id);
  assert.equal(updated.retentionDays, STANDARD_RETENTION_DAYS, 'ended_atが新しいsub_new(standard)が選ばれること');
});

test('cronの1回の実行中は、対象owner全員に対してライトPriceを1回しか引かない', async () => {
  const emailA = 'no-customer-a@example.com';
  const emailB = 'no-customer-b@example.com';
  const caseA = await createStaleOpenCase(emailA);
  const caseB = await createStaleOpenCase(emailB);
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  await callCron();

  const updatedA = await getCase(caseA.id);
  const updatedB = await getCase(caseB.id);
  assert.equal(updatedA.retentionDays, LIGHT_RETENTION_DAYS);
  assert.equal(updatedB.retentionDays, LIGHT_RETENTION_DAYS);

  const priceRetrieveCalls = fakeStripe.__getCallLog().filter((name) => name === 'prices.retrieve');
  assert.equal(priceRetrieveCalls.length, 1, `所有者2人でもprices.retrieveは1回のはず(実際: ${priceRetrieveCalls.length}回)`);
});

// --- getLightPlanRetentionDaysFallback() 単体: 失敗経路のどれを通っても
//     正の整数の安全側定数に必ず止まることを固定する ---

test('getLightPlanRetentionDaysFallback(): STRIPE_PRICE_ID_LIGHT未設定なら安全側の定数(30)', async () => {
  delete process.env.STRIPE_PRICE_ID_LIGHT;
  const result = await getLightPlanRetentionDaysFallback();
  // 定数同士の比較(FALLBACK_RETENTION_DAYS_SAFE_NET)だけだと、定数の値を
  // 何に変えても通ってしまうため、数値リテラル30とも直接比較して固定する。
  assert.equal(result, 30);
  assert.equal(result, FALLBACK_RETENTION_DAYS_SAFE_NET);
  assert.ok(Number.isInteger(result) && result > 0);
});

test('getLightPlanRetentionDaysFallback(): prices.retrieveが失敗しても安全側の定数(30)', async () => {
  fakeStripe.__setHandler('prices.retrieve', async () => {
    throw new Error('stripe unavailable (test)');
  });
  const result = await getLightPlanRetentionDaysFallback();
  assert.equal(result, 30);
  assert.equal(result, FALLBACK_RETENTION_DAYS_SAFE_NET);
});

test('getLightPlanRetentionDaysFallback(): retention_daysが欠損していても安全側の定数(30)', async () => {
  fakeStripe.__setHandler('prices.retrieve', async () => customPrice({ id: 'price_light_test', plan: 'light' }));
  const result = await getLightPlanRetentionDaysFallback();
  assert.equal(result, 30);
  assert.equal(result, FALLBACK_RETENTION_DAYS_SAFE_NET);
});

test('getLightPlanRetentionDaysFallback(): retention_daysが-1(無制限)でも安全側の定数(30)(-1を返さない)', async () => {
  fakeStripe.__setHandler('prices.retrieve', async () =>
    customPrice({ id: 'price_light_test', plan: 'light', retentionDays: -1 })
  );
  const result = await getLightPlanRetentionDaysFallback();
  assert.equal(result, 30);
  assert.equal(result, FALLBACK_RETENTION_DAYS_SAFE_NET);
  assert.notEqual(result, -1);
});

test('getLightPlanRetentionDaysFallback(): 正常系はライトプランのretention_daysをそのまま返す', async () => {
  const result = await getLightPlanRetentionDaysFallback();
  assert.equal(result, LIGHT_RETENTION_DAYS);
});

// FALLBACK_RETENTION_DAYS_SAFE_NETは「ライトプランの保存期間」であり、
// 「解約から全データを削除するまでの期間」(利用規約に定める保存期間、現状6か月)
// とは別の概念。定数を数値リテラルではなくFALLBACK_RETENTION_DAYS_SAFE_NET同士の
// 比較にすると、値を何に変えても(例: 誤って180を入れても)このテストは通って
// しまうため、数値リテラル30と直接比較して固定する。意図的にこの値を変える
// 場合は、ライトプランの実際の保存期間設定(Stripe Priceのretention_days)と
// 突き合わせること(利用規約の保存期間の記述と混同しないこと)。
test('FALLBACK_RETENTION_DAYS_SAFE_NETは30(ライトプランの保存期間)に固定されている', () => {
  assert.equal(FALLBACK_RETENTION_DAYS_SAFE_NET, 30);
  assert.ok(Number.isInteger(FALLBACK_RETENTION_DAYS_SAFE_NET));
  assert.ok(FALLBACK_RETENTION_DAYS_SAFE_NET > 0);
  assert.notEqual(FALLBACK_RETENTION_DAYS_SAFE_NET, -1);
  assert.notEqual(FALLBACK_RETENTION_DAYS_SAFE_NET, 0);
  assert.notEqual(FALLBACK_RETENTION_DAYS_SAFE_NET, undefined);
  assert.ok(!Number.isNaN(FALLBACK_RETENTION_DAYS_SAFE_NET));
});
