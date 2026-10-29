// tests/api/checkout.get-downgrade-options.test.mjs
// handleGetDowngradeOptions（api/checkout.jsのaction:'get-downgrade-options'）の回帰。
// DOWNGRADE_PATHSに沿った候補の返却、light(既に最下位)とunknown/adminの区別、
// pendingDowngrade(予約中の表示)を検証する。invoices.createPreviewは使わない設計
// なので、その呼び出しが無いことも確認する。

import { test, beforeEach, mock } from 'node:test';
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

// ===== 現在のプラン・月額・次回更新日(または解約予定日) =====

test('割引なし: currentPriceLabelは定価で、currentDiscountはnull。追加のStripe問い合わせは発生しない', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_standard_test')] }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currentPlanName, 'スタンダードプラン');
  assert.deepEqual(res.body.currentPriceLabel, { unitAmount: 9900, currency: 'jpy' });
  assert.equal(res.body.currentDiscount, null);
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptions.retrieve'), 'discountsが空なのに追加問い合わせが発生した');
});

test('早期割引が適用中: currentDiscountに割引後金額と終了日(discount.end)が入る', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  const endSec = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { discounts: ['di_early_bird'] })],
  }));
  fakeStripe.__setHandler('subscriptions.retrieve', async (id) => ({
    ...subscriptionOnPlan('price_standard_test'),
    id,
    discounts: [{ id: 'di_early_bird', coupon: { percent_off: 50 }, end: endSec }],
  }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.currentPriceLabel, { unitAmount: 9900, currency: 'jpy' });
  assert.deepEqual(res.body.currentDiscount, { discountedAmount: 4950, endAt: endSec * 1000 });
});

test('割引の割引額が割り切れない場合は、定価も出さない(実際の請求より高く見せない)', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  const endSec = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { discounts: ['di_odd'] })],
  }));
  fakeStripe.__setHandler('subscriptions.retrieve', async (id) => ({
    ...subscriptionOnPlan('price_standard_test'),
    id,
    // 9900 * 33.33% = 3299.67(割り切れない)
    discounts: [{ id: 'di_odd', coupon: { percent_off: 33.33 }, end: endSec }],
  }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.currentPriceLabel, null);
  assert.equal(res.body.currentDiscount, null);
  // プラン名・次回更新日など他の情報は影響を受けない
  assert.equal(res.body.currentPlanName, 'スタンダードプラン');
});

test('割引詳細の追加問い合わせが失敗しても、レスポンス全体は500にならず月額だけ表示しない', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });

  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { discounts: ['di_unreachable'] })],
  }));
  const errorMock = mock.method(console, 'error', () => {});
  try {
    fakeStripe.__setHandler('subscriptions.retrieve', async () => {
      throw new Error('fake stripe: 一時的な障害');
    });

    const res = await callGetDowngradeOptions();

    assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.currentPriceLabel, null);
    assert.equal(res.body.currentDiscount, null);
    assert.equal(res.body.currentPlanName, 'スタンダードプラン');
    assert.deepEqual(res.body.options.map((o) => o.plan), ['light']);
    assert.ok(errorMock.mock.calls.length > 0, 'console.errorが呼ばれていません');
  } finally {
    errorMock.mock.restore();
  }
});

test('解約予約中・cancel_atが月の途中(current_period_endと異なる): cancelEffectiveAtはcancel_atを使う', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });
  const cancelAtSec = Math.floor(Date.now() / 1000) + 10 * 24 * 60 * 60; // current_period_end(+30日)より前

  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { cancel_at: cancelAtSec })],
  }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelPending, true);
  assert.equal(res.body.cancelEffectiveAt, cancelAtSec * 1000);
  assert.notEqual(res.body.cancelEffectiveAt, res.body.nextRenewalAt);
});

test('解約予約中・cancel_at_period_endのみ(cancel_at未設定): cancelEffectiveAtはnextRenewalAtにフォールバックする', async () => {
  fakeAuth.__setAuth({ limits: { plan: 'standard', searchLimit: 100, caseLimit: 30, retentionDays: 365 } });

  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { cancel_at_period_end: true })],
  }));

  const res = await callGetDowngradeOptions();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cancelPending, true);
  assert.equal(res.body.cancelEffectiveAt, res.body.nextRenewalAt);
});
