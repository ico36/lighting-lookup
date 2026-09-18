// tests/api/checkout.schedule-downgrade.test.mjs
// handleScheduleDowngrade（api/checkout.jsのaction:'schedule-downgrade'）の回帰。
// Subscription Scheduleの2フェーズ構成(現行プランを更新日まで維持→更新日から
// 新プラン)、早期割引がライト側フェーズに引き継がれないこと(discounts: '')、
// 既に予約中/プラン変更後/quote不正の異常系を検証する。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/checkout.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeAuth from '../support/fakes/auth.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { createUpgradeQuote } from '../../lib/upgradeQuote.js';

const EMAIL = 'tester@example.com';

function subscriptionOnPlan(priceId, extra = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: 'sub_test',
    customer: 'cus_test',
    status: 'active',
    current_period_start: nowSec,
    current_period_end: nowSec + 30 * 24 * 60 * 60,
    schedule: null,
    discounts: [],
    items: { data: [{ id: 'si_test', price: fakeStripe.__getDefaultPrice(priceId) }] },
    ...extra,
  };
}

function downgradeQuote(overrides = {}) {
  return createUpgradeQuote({
    email: EMAIL,
    fromPriceId: 'price_standard_test',
    toPriceId: 'price_light_test',
    toPlan: 'light',
    amountDue: 0,
    currency: 'jpy',
    couponSent: false,
    couponApplied: false,
    ...overrides,
  });
}

beforeEach(() => {
  fakeStripe.__reset();
  fakeAuth.__reset();
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_standard_test')] }));
});

async function callScheduleDowngrade(quote) {
  const req = fakeReq({ action: 'schedule-downgrade', quote });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('正常系: 2フェーズのSubscription Scheduleが作られ、新プラン側はdiscountsを明示的にクリアする', async () => {
  const res = await callScheduleDowngrade(downgradeQuote());

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.targetPlan, 'light');
  assert.ok(Number.isFinite(res.body.effectiveAt));

  assert.ok(fakeStripe.__getCallLog().includes('subscriptionSchedules.create'));
  assert.ok(fakeStripe.__getCallLog().includes('subscriptionSchedules.update'));

  const scheduleId = fakeStripe.__getScheduleStoreIds()[0];
  const schedule = await fakeStripe.__peekSchedule(scheduleId);

  assert.equal(schedule.end_behavior, 'release');
  assert.equal(schedule.metadata.app_downgrade_target_plan, 'light');
  assert.equal(schedule.phases.length, 2);
  assert.equal(schedule.phases[0].items[0].price, 'price_standard_test');
  assert.equal(schedule.phases[1].items[0].price, 'price_light_test');
  // 早期割引はライトへ引き継がせない方針。「指定しない」ことで継承に任せるのではなく
  // 空文字で明示的にクリアしていることを確認する。
  assert.equal(schedule.phases[1].discounts, '');
});

test('現行フェーズには、いま実際に適用されている割引をそのまま明示的に引き継ぐ', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { discounts: ['di_early_bird_test'] })],
  }));

  const res = await callScheduleDowngrade(downgradeQuote());
  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);

  const scheduleId = fakeStripe.__getScheduleStoreIds()[0];
  const schedule = await fakeStripe.__peekSchedule(scheduleId);

  assert.deepEqual(schedule.phases[0].discounts, [{ discount: 'di_early_bird_test' }]);
});

test('解約予約中(cancel_at_period_end: true)の場合は409 cancel_pendingで拒否する', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { cancel_at_period_end: true })],
  }));

  const res = await callScheduleDowngrade(downgradeQuote());

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'cancel_pending');
  assert.match(res.body.message, /解約手続き済み/);
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptionSchedules.create'));
});

test('cancel_atが設定されている場合も409 cancel_pendingで拒否する', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { cancel_at: Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60 })],
  }));

  const res = await callScheduleDowngrade(downgradeQuote());

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'cancel_pending');
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptionSchedules.create'));
});

test('既に予約中のダウングレードがある場合は409 downgrade_already_scheduled', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { schedule: 'sub_sched_existing' })],
  }));

  const res = await callScheduleDowngrade(downgradeQuote());

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'downgrade_already_scheduled');
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptionSchedules.create'));
});

test('quote発行後にプランが変わっていた場合は409 plan_changed', async () => {
  // quoteのfromPriceIdはstandardのままだが、現在の契約はproに変わっている想定
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_pro_test')] }));
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';

  const res = await callScheduleDowngrade(downgradeQuote());

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'plan_changed');
});

test('壊れたquoteは400 invalid_quote', async () => {
  const res = await callScheduleDowngrade('not-a-real-quote');

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_quote');
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptions.list'));
});
