// tests/api/checkout.get-downgrade-options.test.mjs
// handleGetDowngradeOptions（api/checkout.jsのaction:'get-downgrade-options'）の回帰。
// DOWNGRADE_PATHSに沿った候補の返却、light(既に最下位)とunknown/adminの区別、
// pendingDowngrade(予約中の表示)を検証する。invoices.createPreviewは使わない設計
// なので、その呼び出しが無いことも確認する。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/checkout.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeAuth from '../support/fakes/auth.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { verifyUpgradeQuote } from '../../lib/upgradeQuote.js';

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
});

async function callGetDowngradeOptions() {
  const req = fakeReq({ action: 'get-downgrade-options' });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('pro契約: standard/lightの2候補が返り、createPreviewは呼ばれない', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'pro', searchLimit: -1, caseLimit: -1, retentionDays: -1 } });
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_pro_test')] }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.contactOnly, false);
  assert.equal(res.body.alreadyLowest, false);
  assert.deepEqual(res.body.options.map((o) => o.plan), ['standard', 'light']);
  assert.equal(res.body.pendingDowngrade, null);
  assert.ok(!fakeStripe.__getCallLog().includes('invoices.createPreview'));

  const light = res.body.options.find((o) => o.plan === 'light');
  const verified = verifyUpgradeQuote(light.quote, EMAIL);
  assert.equal(verified.ok, true);
  assert.equal(verified.quote.toPlan, 'light');
  assert.equal(verified.quote.amountDue, 0);
});

test('standard契約: light1候補のみ', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_standard_test')] }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.options.map((o) => o.plan), ['light']);
});

test('light契約: 既に最下位。options空だがcontactOnlyではなくalreadyLowest:true', async () => {
  // fakeAuthの既定がまさにlightプラン
  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.options, []);
  assert.equal(res.body.alreadyLowest, true);
  assert.equal(res.body.contactOnly, false);
});

test('unknownプラン: 移行先を機械的に決められないのでcontactOnly:true・alreadyLowest:false', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'unknown', searchLimit: -1, caseLimit: -1, retentionDays: -1 } });
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_light_test')] }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.options, []);
  assert.equal(res.body.contactOnly, true);
  assert.equal(res.body.alreadyLowest, false);
});

test('cancel_at_period_end: true(解約予約中)なら候補を出さずcancelPending:trueを返す', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { cancel_at_period_end: true })],
  }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.cancelPending, true);
  assert.deepEqual(res.body.options, []);
  assert.equal(res.body.contactOnly, false);
  assert.equal(res.body.alreadyLowest, false);
});

test('cancel_atが設定されている(解約予約中)場合も同様にcancelPending:trueを返す', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'pro', searchLimit: -1, caseLimit: -1, retentionDays: -1 } });
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_pro_test', { cancel_at: Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60 })],
  }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelPending, true);
  assert.deepEqual(res.body.options, []);
});

test('解約予約中でなければcancelPending:falseで、通常どおり候補が返る', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_standard_test')] }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelPending, false);
  assert.deepEqual(res.body.options.map((o) => o.plan), ['light']);
});

test('予約中のダウングレードがあればpendingDowngradeに反映される', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  const effectiveAtSec = Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60;

  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { schedule: 'sub_sched_existing' })],
  }));
  fakeStripe.__setHandler('subscriptionSchedules.retrieve', async (id) => {
    assert.equal(id, 'sub_sched_existing');
    return {
      id,
      metadata: { app_downgrade_target_plan: 'light' },
      phases: [
        { start_date: Math.floor(Date.now() / 1000), end_date: effectiveAtSec },
        { start_date: effectiveAtSec },
      ],
    };
  });

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.pendingDowngrade, 'pendingDowngradeがnullのまま');
  assert.equal(res.body.pendingDowngrade.targetPlan, 'light');
  assert.equal(res.body.pendingDowngrade.scheduleId, 'sub_sched_existing');
  assert.equal(res.body.pendingDowngrade.effectiveAt, effectiveAtSec * 1000);
});
