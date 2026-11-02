// tests/api/stripe-webhook.test.mjs
// api/stripe-webhook.js の handleSubscriptionEvent() の単体テスト。
//
// 【raw body・署名検証(handler本体)はここでは検証しない】テストハーネスの
// fakeReq/fakeResは生のHTTPストリームを再現しないため、stripe.webhooks.constructEvent
// に依存する部分は対象外にする。ここでは「署名検証済みのStripe Eventを受け取った後の
// 振る舞い」(handleSubscriptionEvent、exportされている)だけを、フェイクStripe/
// フェイクRedisで検証する。raw body・署名検証はStripe CLI(stripe trigger等)での
// 実機確認が必要(デプロイ後に確認すること)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleSubscriptionEvent } from '../../api/stripe-webhook.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
});

function wireCustomer(email, { customerId = `cus_${email}`, priceId = 'price_standard_test', status = 'active' } = {}) {
  fakeStripe.__setHandler('customers.list', async (params) => {
    if (params.email !== email) return { data: [] };
    return { data: [{ id: customerId }] };
  });
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.customer !== customerId) return { data: [] };
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      data: [{
        id: `sub_${customerId}`,
        customer: customerId,
        status,
        start_date: nowSec,
        items: { data: [{ id: `si_${customerId}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
      }],
    };
  });
  return customerId;
}

function subscriptionCreatedEvent(customerId) {
  return {
    type: 'customer.subscription.created',
    data: { object: { id: `sub_${customerId}`, customer: customerId, status: 'active' } },
  };
}

test('customer.subscription.created: 照明サーチの有効な契約なら会員番号を発番する', async () => {
  const email = 'webhook-new@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });

  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '1');
  assert.equal(fakeStripe.__peekCustomer(customerId).metadata.ls_member_no, '1');
});

test('customer.subscription.updated: created同様に扱う(3Dセキュア確認後にactiveへ変わるケース)', async () => {
  const email = 'webhook-updated@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });

  await handleSubscriptionEvent({
    type: 'customer.subscription.updated',
    data: { object: { id: `sub_${customerId}`, customer: customerId, status: 'active' } },
  });

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '1');
});

test('対象外のイベント種別は無視する', async () => {
  const email = 'webhook-ignored@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });

  await handleSubscriptionEvent({
    type: 'customer.subscription.deleted',
    data: { object: { id: `sub_${customerId}`, customer: customerId, status: 'canceled' } },
  });

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), null);
});

test('subscriptionがincomplete(支払い確認待ち)なら何もしない(ログイン/cronフォールバックに委ねる)', async () => {
  const email = 'webhook-incomplete@example.com';
  const customerId = wireCustomer(email, { status: 'incomplete' });
  fakeStripe.__seedCustomer(customerId, { email });

  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), null);
});

test('KYノートのみの契約(照明サーチのPriceを含まない)なら何もしない', async () => {
  const email = 'webhook-other-product@example.com';
  const customerId = wireCustomer(email, { priceId: 'price_ky_note_test' });
  fakeStripe.__seedCustomer(customerId, { email });
  // price_ky_note_test はホワイトリスト外なので defaultPrice() のフォールバック
  // (metadata無し)が返るが、assignMemberNoIfMissing()は price IDそのものを
  // 見ているため、metadataの中身に関係なく除外される。

  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), null);
});

test('customerにemailが無い場合は何もしない', async () => {
  const customerId = 'cus_no_email';
  fakeStripe.__seedCustomer(customerId, { email: null });
  fakeStripe.__setHandler('customers.list', async () => {
    throw new Error('emailが無いので呼ばれないはず');
  });

  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));
  // 例外にならず終わることだけを確認(呼び出し自体が早期returnする)
});

test('customerがオブジェクト形式(expand済み)でも customer.id から解決できる', async () => {
  const email = 'webhook-expanded@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });

  await handleSubscriptionEvent({
    type: 'customer.subscription.created',
    data: { object: { id: `sub_${customerId}`, customer: { id: customerId }, status: 'active' } },
  });

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '1');
});
