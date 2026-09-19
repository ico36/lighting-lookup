// tests/api/checkout.upgrade-cancel-pending.test.mjs
// 解約予約中(cancel_at_period_end/cancel_at設定済み)のアップグレードをブロックする回帰。
// ダウングレード側(isCancelPending, checkout.get-downgrade-options.test.mjs /
// checkout.schedule-downgrade.test.mjs)と同じ扱いにする変更なので、テストの構成も揃える。
//   - get-upgrade-options: 候補を出さずcancelPending:trueを返す
//   - update-plan: 409 cancel_pendingで拒否し、subscriptions.update()を呼ばない
//     （フロントを経由しない呼び出しへの防御。get-upgrade-optionsが弾いていれば
//     フロント経由では通常ここに来ないが、直接叩かれた場合の安全弁を検証する）

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

beforeEach(() => {
  fakeStripe.__reset();
  fakeAuth.__reset();
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.STRIPE_COUPON_ID = 'coupon_test';
});

async function callGetUpgradeOptions() {
  const req = fakeReq({ action: 'get-upgrade-options' });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('get-upgrade-options: cancel_at_period_end: true(解約予約中)なら候補を出さずcancelPending:trueを返す', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_light_test', { cancel_at_period_end: true })],
  }));

  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.cancelPending, true);
  assert.deepEqual(res.body.options, []);
  assert.equal(res.body.contactOnly, false);
  // 候補が確定する前に打ち切るため、日割りプレビューは1本も呼ばれない
  assert.ok(!fakeStripe.__getCallLog().includes('invoices.createPreview'));
});

test('get-upgrade-options: cancel_atが設定されている場合も同様にcancelPending:trueを返す', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_light_test', {
      cancel_at: Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60,
    })],
  }));

  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelPending, true);
  assert.deepEqual(res.body.options, []);
  assert.equal(res.body.contactOnly, false);
});

test('get-upgrade-options: 解約予約中でなければcancelPending:falseで、通常どおり候補が返る', async () => {
  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelPending, false);
  assert.deepEqual(res.body.options.map((o) => o.plan), ['standard', 'pro']);
});

async function callUpdatePlan(quote) {
  const req = fakeReq({ action: 'update-plan', quote });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

function upgradeQuote(overrides = {}) {
  return createUpgradeQuote({
    email: EMAIL,
    fromPriceId: 'price_light_test',
    toPriceId: 'price_standard_test',
    toPlan: 'standard',
    amountDue: 8800,
    currency: 'jpy',
    couponSent: false,
    couponApplied: false,
    ...overrides,
  });
}

test('update-plan: 解約予約中(cancel_at_period_end: true)の場合は409 cancel_pendingで拒否し、subscriptions.updateを呼ばない', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_light_test', { cancel_at_period_end: true })],
  }));

  const res = await callUpdatePlan(upgradeQuote());

  assert.equal(res.statusCode, 409, `409を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'cancel_pending');
  assert.match(res.body.message, /解約手続き済み/);
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptions.update'));
});

test('update-plan: cancel_atが設定されている場合も409 cancel_pendingで拒否し、subscriptions.updateを呼ばない', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_light_test', {
      cancel_at: Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60,
    })],
  }));

  const res = await callUpdatePlan(upgradeQuote());

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'cancel_pending');
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptions.update'));
});

test('update-plan: 解約予約中でなければcancel_pendingにならず、subscriptions.updateまで進む（比較対照）', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_light_test')] }));
  fakeStripe.__setHandler('subscriptions.update', async () => ({}));

  const res = await callUpdatePlan(upgradeQuote());

  assert.notEqual(res.body?.error, 'cancel_pending');
  assert.ok(fakeStripe.__getCallLog().includes('subscriptions.update'));
});
