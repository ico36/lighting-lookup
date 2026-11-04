// tests/lib/signupCustomerCleanup.test.mjs
// lib/signupCustomerCleanup.js (未決済の申し込みで作られたStripe顧客の掃除)のテスト。
// 対象はprocessPendingSignupCustomers()の判定(猶予期間・契約の有無・ドライラン)。
// ZSETのmemberがcustomer.id(メールではない)であることを前提に、契約確認は
// customerId自身へのsubscriptions.list({customer, status:'all'})で行う想定。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNUP_PENDING_CUSTOMER_KEY,
  SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS,
  registerPendingSignupCustomer,
  processPendingSignupCustomers,
} from '../../lib/signupCustomerCleanup.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis, __getZScore } from '../support/fakes/redis.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  delete process.env.SIGNUP_CUSTOMER_CLEANUP_DRY_RUN; // 既定 = ドライラン
});

test('猶予期間(7日)を過ぎていない候補は何もしない(ZSETに残り、Stripeへの契約確認も行わない対象外)', async () => {
  const now = Date.now();
  const createdAt = now - 1 * DAY_MS;
  await registerPendingSignupCustomer('cus_recent', { now: createdAt });

  const result = await processPendingSignupCustomers({ now });

  assert.deepEqual(result.dryRunTargets, []);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.removedHasSubscription, []);
  assert.equal(__getZScore(SIGNUP_PENDING_CUSTOMER_KEY, 'cus_recent'), createdAt);
});

test('ドライラン中(既定)は、猶予期間を過ぎて契約も無い候補をログだけ出してZSETに残す(解除時に対象が消えていないように)', async () => {
  const now = Date.now();
  const createdAt = now - (SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS + 1) * DAY_MS;
  await registerPendingSignupCustomer('cus_overdue', { now: createdAt });
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [] }));

  const result = await processPendingSignupCustomers({ now });

  assert.deepEqual(result.dryRunTargets, ['cus_overdue']);
  assert.deepEqual(result.deleted, []);
  assert.ok(!fakeStripe.__getCallLog().includes('customers.del'), 'ドライラン中はcustomers.delを呼ばない');
  assert.equal(__getZScore(SIGNUP_PENDING_CUSTOMER_KEY, 'cus_overdue'), createdAt);
});

test('ドライランを解除(SIGNUP_CUSTOMER_CLEANUP_DRY_RUN=false)すると、猶予期間を過ぎて契約も無い候補は削除されZSETから外れる', async () => {
  process.env.SIGNUP_CUSTOMER_CLEANUP_DRY_RUN = 'false';
  const now = Date.now();
  const createdAt = now - (SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS + 1) * DAY_MS;
  await registerPendingSignupCustomer('cus_overdue', { now: createdAt });
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [] }));

  const result = await processPendingSignupCustomers({ now });

  assert.deepEqual(result.deleted, ['cus_overdue']);
  assert.ok(fakeStripe.__getCallLog().includes('customers.del'));
  assert.equal(__getZScore(SIGNUP_PENDING_CUSTOMER_KEY, 'cus_overdue'), null);
});

test('契約が1件でも見つかれば、ドライラン中でも削除せずZSETから外すだけにする(照明サーチ以外のPriceでも対象外になる)', async () => {
  const now = Date.now();
  const createdAt = now - (SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS + 1) * DAY_MS;
  await registerPendingSignupCustomer('cus_subscribed', { now: createdAt });
  // statusを問わず(status:'all')1件でもあれば対象外。Priceも照明サーチ以外(他製品)を想定。
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [{
      id: 'sub_other_product',
      customer: 'cus_subscribed',
      status: 'active',
      items: { data: [{ price: { id: 'price_other_product' } }] },
    }],
  }));

  const result = await processPendingSignupCustomers({ now });

  assert.deepEqual(result.removedHasSubscription, ['cus_subscribed']);
  assert.deepEqual(result.dryRunTargets, []);
  assert.ok(
    !fakeStripe.__getCallLog().includes('customers.del'),
    '契約が見つかった場合は削除ではなく対象外化(ZSETから外すだけ)'
  );
  assert.equal(__getZScore(SIGNUP_PENDING_CUSTOMER_KEY, 'cus_subscribed'), null);
});

test('契約確認(subscriptions.list)が失敗した場合は、予定を変更せず翌日再試行する', async () => {
  const now = Date.now();
  const createdAt = now - (SIGNUP_CUSTOMER_CLEANUP_GRACE_DAYS + 1) * DAY_MS;
  await registerPendingSignupCustomer('cus_error', { now: createdAt });
  fakeStripe.__setHandler('subscriptions.list', async () => {
    throw new Error('stripe down');
  });

  const result = await processPendingSignupCustomers({ now });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].customerId, 'cus_error');
  assert.equal(__getZScore(SIGNUP_PENDING_CUSTOMER_KEY, 'cus_error'), createdAt);
});
