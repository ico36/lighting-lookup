// tests/lib/welcomeEmail.test.mjs
// lib/welcomeEmail.js の sendWelcomeEmail()(Resend送信の内容)と
// maybeSendWelcomeEmail()(送信条件・重複防止)の単体テスト。
//
// sendWelcomeEmail()のResend呼び出しはlib/otpMail.jsと同じ方針で、Node組み込みの
// グローバルfetch自体をこのテストの中だけスタブに差し替える(afterEachで必ず元に戻す)。
// maybeSendWelcomeEmail()のStripe呼び出し(customers.list/subscriptions.list/
// prices.retrieve)はフェイクStripe、送信済みフラグ・ロックはフェイクRedisを使う。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendWelcomeEmail, maybeSendWelcomeEmail } from '../../lib/welcomeEmail.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';

const REAL_FETCH = globalThis.fetch;
const REAL_CONSOLE_ERROR = console.error;
const REAL_CONSOLE_WARN = console.warn;

let fetchCalls;

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  process.env.SUPPORT_EMAIL = 'info@ma-system.co.jp';
  fetchCalls = [];
  console.error = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  console.error = REAL_CONSOLE_ERROR;
  console.warn = REAL_CONSOLE_WARN;
});

function stubFetchOk() {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };
}

function stubFetchError(status = 500) {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: false, status, json: async () => ({}) };
  };
}

// --- sendWelcomeEmail() 本体 ---

test('sendWelcomeEmail(): 件名・本文・from・reply_toを正しく組み立てる(テキストのみ、HTMLは作らない)', async () => {
  stubFetchOk();

  await sendWelcomeEmail({ to: 'user@example.com', memberNoFormatted: 'LS-000001', planName: 'スタンダードプラン' });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.resend.com/emails');
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(body.from, process.env.MAIL_FROM);
  assert.deepEqual(body.to, ['user@example.com']);
  assert.equal(body.reply_to, 'info@ma-system.co.jp');
  assert.equal(body.subject, '【照明サーチ】ご契約ありがとうございます');
  assert.ok(!('html' in body), 'HTMLメールにしない(textのみ)');
  assert.match(body.text, /会員番号：LS-000001/);
  assert.match(body.text, /ご契約プラン：スタンダードプラン/);
  assert.match(body.text, /ご登録メールアドレス：user@example\.com/);
  assert.match(body.text, /ヘルプ：https:\/\/lighting\.ma-system\.co\.jp\/\?help/);
  assert.match(body.text, /利用規約：https:\/\/lighting\.ma-system\.co\.jp\/terms\.html/);
  assert.match(body.text, /プライバシーポリシー：https:\/\/lighting\.ma-system\.co\.jp\/privacy\.html/);
  assert.match(body.text, /特定商取引法に基づく表記：https:\/\/lighting\.ma-system\.co\.jp\/tokushoho\.html/);
  assert.match(body.text, /info@ma-system\.co\.jp/);
});

test('sendWelcomeEmail(): Resendがエラーを返したら例外を投げる', async () => {
  stubFetchError(500);

  await assert.rejects(() =>
    sendWelcomeEmail({ to: 'user@example.com', memberNoFormatted: 'LS-000001', planName: 'ライトプラン' })
  );
});

test('sendWelcomeEmail(): fetch自体が失敗(タイムアウト等)しても例外を投げる', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };

  await assert.rejects(() =>
    sendWelcomeEmail({ to: 'user@example.com', memberNoFormatted: 'LS-000001', planName: 'ライトプラン' })
  );
});

test('sendWelcomeEmail(): SUPPORT_EMAIL未設定ならreply_toを含めない', async () => {
  delete process.env.SUPPORT_EMAIL;
  stubFetchOk();

  await sendWelcomeEmail({ to: 'user@example.com', memberNoFormatted: 'LS-000001', planName: 'ライトプラン' });

  const body = JSON.parse(fetchCalls[0].options.body);
  assert.ok(!('reply_to' in body));
});

// --- maybeSendWelcomeEmail() ---

/** @param {{email: string, customerId?: string, subscriptionId?: string, priceId?: string, status?: string}} opts */
function wireSubscription({
  email,
  customerId = 'cus_test',
  subscriptionId = 'sub_test',
  priceId = 'price_standard_test',
  status = 'active',
}) {
  fakeStripe.__setHandler('customers.list', async (params) => {
    if (params.email !== email) return { data: [] };
    return { data: [{ id: customerId }] };
  });
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.customer !== customerId) return { data: [] };
    return {
      data: [{
        id: subscriptionId,
        customer: customerId,
        status,
        items: { data: [{ id: `si_${subscriptionId}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
      }],
    };
  });
}

test('maybeSendWelcomeEmail(): 有効な契約・会員番号ありなら送信し、送信済みフラグ(subscription.id単位)を立てる', async () => {
  const email = 'send-ok@example.com';
  wireSubscription({ email });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  stubFetchOk();

  const result = await maybeSendWelcomeEmail(email);

  assert.deepEqual(result, { sent: true });
  assert.equal(await redis.get(redisKey('welcome-email', 'sent', 'sub_test')), '1');
  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].options.body);
  assert.match(body.text, /会員番号：LS-000001/);
  assert.match(body.text, /ご契約プラン：スタンダードプラン/, 'StripeのProduct名を使う');
});

test('maybeSendWelcomeEmail(): Product名が取れない場合はプラン識別子にフォールバックする', async () => {
  const email = 'fallback-plan@example.com';
  wireSubscription({ email });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  fakeStripe.__setHandler('prices.retrieve', async () => {
    throw new Error('stripe down');
  });
  stubFetchOk();

  await maybeSendWelcomeEmail(email);

  const body = JSON.parse(fetchCalls[0].options.body);
  assert.match(body.text, /ご契約プラン：standard/, '識別子(price.metadata.plan)にフォールバックする');
});

test('maybeSendWelcomeEmail(): KYノートなど照明サーチ以外のPriceでは送らない', async () => {
  const email = 'ky-note@example.com';
  wireSubscription({ email, priceId: 'price_other_product' });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  stubFetchOk();

  const result = await maybeSendWelcomeEmail(email);

  assert.equal(result.reason, 'no_active_subscription');
  assert.equal(fetchCalls.length, 0);
});

test('maybeSendWelcomeEmail(): incomplete等(有効でない)ステータスでは送らない', async () => {
  const email = 'incomplete@example.com';
  wireSubscription({ email, status: 'incomplete' });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  stubFetchOk();

  const result = await maybeSendWelcomeEmail(email);

  assert.equal(result.reason, 'no_active_subscription');
  assert.equal(fetchCalls.length, 0);
});

test('maybeSendWelcomeEmail(): trialingでも送る(LIVE_STATUSESに合わせる)', async () => {
  const email = 'trialing@example.com';
  wireSubscription({ email, status: 'trialing' });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  stubFetchOk();

  const result = await maybeSendWelcomeEmail(email);

  assert.deepEqual(result, { sent: true });
});

test('maybeSendWelcomeEmail(): 会員番号が未採番なら送らず、送信済みフラグも立てない', async () => {
  const email = 'no-member-no@example.com';
  wireSubscription({ email });
  stubFetchOk();

  const result = await maybeSendWelcomeEmail(email);

  assert.equal(result.reason, 'no_member_no');
  assert.equal(fetchCalls.length, 0);
  assert.equal(await redis.get(redisKey('welcome-email', 'sent', 'sub_test')), null);
});

test('maybeSendWelcomeEmail(): 同じsubscription.idには二度送らない(プラン変更等で再度呼ばれても)', async () => {
  const email = 'already-sent@example.com';
  wireSubscription({ email });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  await redis.set(redisKey('welcome-email', 'sent', 'sub_test'), '1');
  stubFetchOk();

  const result = await maybeSendWelcomeEmail(email);

  assert.equal(result.reason, 'already_sent');
  assert.equal(fetchCalls.length, 0);
});

test('maybeSendWelcomeEmail(): ロックが取れない(同時に処理中)場合は送信を試みない', async () => {
  const email = 'lock-busy@example.com';
  wireSubscription({ email });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  await redis.set(redisKey('welcome-email', 'lock', 'sub_test'), '1', { nx: true, ex: 30 });
  stubFetchOk();

  const result = await maybeSendWelcomeEmail(email);

  assert.equal(result.reason, 'lock_busy');
  assert.equal(fetchCalls.length, 0);
});

test('maybeSendWelcomeEmail(): 送信が失敗した場合は送信済みフラグを立てず、次回に再試行できる', async () => {
  const email = 'send-fail@example.com';
  wireSubscription({ email });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  stubFetchError(500);

  const failed = await maybeSendWelcomeEmail(email);
  assert.equal(failed.reason, 'send_failed');
  assert.equal(await redis.get(redisKey('welcome-email', 'sent', 'sub_test')), null);
  assert.equal(await redis.get(redisKey('welcome-email', 'lock', 'sub_test')), null, '失敗後はロックも解放されている');

  stubFetchOk();
  const retried = await maybeSendWelcomeEmail(email);

  assert.deepEqual(retried, { sent: true });
  assert.equal(fetchCalls.length, 2, '1回目(失敗)・2回目(成功)の両方がResendへ送信を試みている');
  assert.equal(await redis.get(redisKey('welcome-email', 'sent', 'sub_test')), '1');
});
