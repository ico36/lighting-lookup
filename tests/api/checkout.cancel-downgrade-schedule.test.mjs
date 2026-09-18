// tests/api/checkout.cancel-downgrade-schedule.test.mjs
// handleCancelDowngradeSchedule（api/checkout.jsのaction:'cancel-downgrade-schedule'）の回帰。
// 予約の取り消し＝subscriptionSchedules.release()を呼ぶだけで、サブスク自体には
// 触れないことを確認する。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/checkout.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeAuth from '../support/fakes/auth.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';

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
});

async function callCancelDowngradeSchedule() {
  const req = fakeReq({ action: 'cancel-downgrade-schedule' });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('予約中のスケジュールをreleaseする', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test', { schedule: 'sub_sched_existing' })],
  }));
  const releaseCalls = [];
  fakeStripe.__setHandler('subscriptionSchedules.release', async (id) => {
    releaseCalls.push(id);
    return { id, status: 'released' };
  });

  const res = await callCancelDowngradeSchedule();

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.deepEqual(releaseCalls, ['sub_sched_existing']);
  // subscriptions.update等、サブスク本体への書き込みは一切行わない
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptions.update'));
});

test('予約が無い場合は404 no_pending_downgrade。releaseは呼ばれない', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionOnPlan('price_standard_test')],
  }));

  const res = await callCancelDowngradeSchedule();

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'no_pending_downgrade');
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptionSchedules.release'));
});

test('契約自体が見つからない場合は404 subscription_not_found', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [] }));
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  const res = await callCancelDowngradeSchedule();

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'subscription_not_found');
});
