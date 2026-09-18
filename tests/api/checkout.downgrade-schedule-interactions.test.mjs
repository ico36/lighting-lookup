// tests/api/checkout.downgrade-schedule-interactions.test.mjs
// ダウングレード予約(Subscription Schedule)と、既存のアップグレード処理
// (get-upgrade-options/update-plan)との相互作用の回帰。
//   - get-upgrade-options のレスポンスに pendingDowngrade が乗る
//   - update-plan は、予約中のスケジュールがあれば subscriptions.update() の前に
//     必ず release() する(既存の課金ロジック自体には触れていないことも確認する)

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
  fakeAuth.__setAuth({ email: EMAIL, limits: { plan: 'light', searchLimit: 20, caseLimit: 5, retentionDays: 30 } });
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.STRIPE_COUPON_ID = 'coupon_test';
});

test('get-upgrade-options: 予約中のダウングレードがあればpendingDowngradeに反映される', async () => {
  const effectiveAtSec = Math.floor(Date.now() / 1000) + 20 * 24 * 60 * 60;
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_light_test', { schedule: 'sub_sched_existing' })],
  }));
  fakeStripe.__setHandler('subscriptionSchedules.retrieve', async (id) => ({
    id,
    metadata: { app_downgrade_target_plan: 'light' },
    phases: [
      { start_date: Math.floor(Date.now() / 1000), end_date: effectiveAtSec },
      { start_date: effectiveAtSec },
    ],
  }));

  const req = fakeReq({ action: 'get-upgrade-options' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.pendingDowngrade, 'pendingDowngradeがnullのまま');
  assert.equal(res.body.pendingDowngrade.effectiveAt, effectiveAtSec * 1000);
});

test('get-upgrade-options: 予約が無ければpendingDowngradeはnull', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_light_test')] }));

  const req = fakeReq({ action: 'get-upgrade-options' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pendingDowngrade, null);
});

test('update-plan: 予約中のスケジュールがあればsubscriptions.update()の前にreleaseされる', async () => {
  fakeStripe.__seedSchedule('sub_sched_existing');
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_light_test', { schedule: 'sub_sched_existing' })],
  }));
  fakeStripe.__setHandler('subscriptions.update', async () => ({}));

  const quote = createUpgradeQuote({
    email: EMAIL,
    fromPriceId: 'price_light_test',
    toPriceId: 'price_standard_test',
    toPlan: 'standard',
    amountDue: 8800,
    currency: 'jpy',
    couponSent: false,
    couponApplied: false,
  });

  const req = fakeReq({ action: 'update-plan', quote });
  const res = fakeRes();
  await handler(req, res);

  // getSubscriptionStateCached()・readQuota()は未フェイクのため200までは到達しない
  // 前提(checkout.update-plan.test.mjsの「比較対照」と同じ考え方)。ここで見たいのは
  // 呼び出し順(release→update)だけ。
  const callLog = fakeStripe.__getCallLog();
  const releaseIndex = callLog.indexOf('subscriptionSchedules.release');
  const updateIndex = callLog.indexOf('subscriptions.update');

  assert.notEqual(releaseIndex, -1, 'subscriptionSchedules.releaseが呼ばれていない');
  assert.notEqual(updateIndex, -1, 'subscriptions.updateが呼ばれていない');
  assert.ok(releaseIndex < updateIndex, 'releaseがupdateより先に呼ばれていない');
});

test('update-plan: 予約が無ければreleaseは呼ばれない', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [subscriptionOnPlan('price_light_test')] }));
  fakeStripe.__setHandler('subscriptions.update', async () => ({}));

  const quote = createUpgradeQuote({
    email: EMAIL,
    fromPriceId: 'price_light_test',
    toPriceId: 'price_standard_test',
    toPlan: 'standard',
    amountDue: 8800,
    currency: 'jpy',
    couponSent: false,
    couponApplied: false,
  });

  const req = fakeReq({ action: 'update-plan', quote });
  const res = fakeRes();
  await handler(req, res);

  assert.ok(!fakeStripe.__getCallLog().includes('subscriptionSchedules.release'));
});
