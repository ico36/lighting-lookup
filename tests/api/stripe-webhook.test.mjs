// tests/api/stripe-webhook.test.mjs
// api/stripe-webhook.js の handleSubscriptionEvent() の単体テスト。
// 会員番号(ls_member_no)の採番と、そのあとに行うウェルカムメール(lib/welcomeEmail.js)
// の送信確認の両方を対象にする。
//
// 【raw body・署名検証(handler本体)はここでは検証しない】テストハーネスの
// fakeReq/fakeResは生のHTTPストリームを再現しないため、stripe.webhooks.constructEvent
// に依存する部分は対象外にする。ここでは「署名検証済みのStripe Eventを受け取った後の
// 振る舞い」(handleSubscriptionEvent、exportされている)だけを、フェイクStripe/
// フェイクRedisで検証する。raw body・署名検証はStripe CLI(stripe trigger等)での
// 実機確認が必要(デプロイ後に確認すること)。
//
// 【ウェルカムメールのResend送信】lib/welcomeEmail.jsのsendWelcomeEmail()はグローバル
// fetchを直接呼ぶため、loader.mjsでは差し替えられない。tests/lib/otpMail.test.mjsと
// 同じ方式でglobalThis.fetch自体をこのテストの中だけスタブに差し替える
// (afterEachで必ず元に戻す)。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleSubscriptionEvent } from '../../api/stripe-webhook.js';
import { CONTRACT_STATUS_ACTIVE_KEY } from '../../lib/contractStats.js';
import { welcomeEmailSentKey } from '../../lib/welcomeEmail.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';

const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  // 既定は成功レスポンス。失敗時の挙動を見るテストだけ個別に差し替える。
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'email_test' }) });
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
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
  // customer.subscription.deletedは経営統計(contract-status:active)対応で
  // HANDLED_EVENT_TYPESに追加したため、このテストでは対象外のままの種別
  // (customer.subscription.trial_will_end)を使う。
  const email = 'webhook-ignored@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });

  await handleSubscriptionEvent({
    type: 'customer.subscription.trial_will_end',
    data: { object: { id: `sub_${customerId}`, customer: customerId, status: 'trialing' } },
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

test('customer.subscription.created: 会員番号採番のあとにウェルカムメールを送る', async () => {
  const email = 'webhook-welcome@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };

  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '1');
  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.match(body.text, /会員番号：LS-000001/);
  assert.equal(await redis.get(redisKey('welcome-email', 'sent', `sub_${customerId}`)), '1');
});

test('ウェルカムメールの送信に失敗しても、会員番号の採番結果やhandleSubscriptionEvent自体には影響しない', async () => {
  const email = 'webhook-welcome-fail@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  await assert.doesNotReject(() => handleSubscriptionEvent(subscriptionCreatedEvent(customerId)));

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '1', '会員番号の採番は成功している');
  assert.equal(await redis.get(redisKey('welcome-email', 'sent', `sub_${customerId}`)), null, '送信失敗時はフラグを立てない');
});

test('プラン変更(同じsubscription.idのまま)で再度updatedが届いても、ウェルカムメールは二重送信しない', async () => {
  const email = 'webhook-welcome-no-resend@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };

  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));
  assert.equal(fetchCalls.length, 1);

  // プラン変更後もsubscription.idは変わらない(同じcustomerId・同じsub_${customerId})。
  // priceだけ別のPriceに差し替えてupdatedイベントを再度送る想定。
  wireCustomer(email, { customerId, priceId: 'price_pro_test' });
  await handleSubscriptionEvent({
    type: 'customer.subscription.updated',
    data: { object: { id: `sub_${customerId}`, customer: customerId, status: 'active' } },
  });

  assert.equal(fetchCalls.length, 1, 'プラン変更の再通知では追加送信されない');
});

// --- 経営統計(contract-status:active)の同期 ---

test('customer.subscription.created: 照明サーチの有効な契約なら contract-status:active に追加する', async () => {
  const email = 'webhook-contract-active@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });

  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));

  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), [email]);
});

test('customer.subscription.deleted: 契約が実際に終了したら contract-status:active から外す', async () => {
  const email = 'webhook-contract-deleted@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { email });

  // 一度activeで登録されたあと、解約が確定(status: canceled)してdeletedイベントが届く想定。
  await handleSubscriptionEvent(subscriptionCreatedEvent(customerId));
  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), [email]);

  wireCustomer(email, { customerId, status: 'canceled' });
  await handleSubscriptionEvent({
    type: 'customer.subscription.deleted',
    data: { object: { id: `sub_${customerId}`, customer: customerId, status: 'canceled' } },
  });

  assert.deepEqual(await redis.smembers(CONTRACT_STATUS_ACTIVE_KEY), []);
});

test('customer.subscription.deleted: 会員番号・ウェルカムメールには影響しない(有効な契約が無いので何もしない)', async () => {
  const email = 'webhook-deleted-no-op@example.com';
  const customerId = wireCustomer(email, { status: 'canceled' });
  fakeStripe.__seedCustomer(customerId, { email });
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };

  await assert.doesNotReject(() =>
    handleSubscriptionEvent({
      type: 'customer.subscription.deleted',
      data: { object: { id: `sub_${customerId}`, customer: customerId, status: 'canceled' } },
    })
  );

  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), null, '会員番号は採番されない');
  assert.equal(fetchCalls.length, 0, 'ウェルカムメール(Resend)は送られない');
  assert.equal(await redis.get(welcomeEmailSentKey(`sub_${customerId}`)), null, '送信済みフラグも立たない');
});
