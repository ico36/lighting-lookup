// tests/api/cron.welcome-email.test.mjs
// api/cron/process-cases.js ステップ5(会員番号の採番・保険)に相乗りした、
// ウェルカムメールの送信保険(lib/welcomeEmail.js)のテスト。
//
// 【会員番号ステップと同じcandidatesを使う】このステップは会員番号採番(保険)が
// 既に列挙した照明サーチの有効な契約者(candidates)をそのまま使い回すため、
// Stripeへの追加往復は発生しない設計(api/cron/process-cases.js参照)。
// wireActiveSubscriptions()はtests/api/cron.member-no.test.mjsの同名ヘルパーの
// 簡略版をこのファイル専用に用意する(他ファイルには手を入れない)。
//
// 【Resend送信】lib/welcomeEmail.jsのsendWelcomeEmail()はグローバルfetchを直接
// 呼ぶため、loader.mjsでは差し替えられない。tests/lib/otpMail.test.mjsと同じ方式で
// globalThis.fetch自体をこのテストの中だけスタブに差し替える(afterEachで必ず元に戻す)。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cron/process-cases.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeBlob from '../support/fakes/blob.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { welcomeEmailSentKey } from '../../lib/welcomeEmail.js';

const CRON_SECRET = 'test-cron-secret';
const REAL_FETCH = globalThis.fetch;

let fetchCalls;

beforeEach(() => {
  fakeStripe.__reset();
  fakeBlob.__reset();
  __resetFakeRedis();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  delete process.env.VERCEL_ENV;
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function callCron() {
  const req = fakeReq(undefined, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

/** @param {{id: string, customerId: string, email: string, priceId?: string, customerMetadata?: object}} e */
function wireActiveSubscription(e) {
  const priceId = e.priceId || 'price_standard_test';
  const nowSec = Math.floor(Date.now() / 1000);
  const sub = {
    id: e.id,
    customer: { id: e.customerId, email: e.email, metadata: e.customerMetadata || {} },
    status: 'active',
    start_date: nowSec,
    items: { data: [{ id: `si_${e.id}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
  };

  fakeStripe.__setHandler('customers.list', async (params) => {
    if (params.email !== e.email) return { data: [] };
    return { data: [{ id: e.customerId }] };
  });
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.price) {
      if (params.price !== priceId) return { data: [] };
      return { data: params.status === sub.status ? [sub] : [] };
    }
    if (params.customer === e.customerId) return { data: [sub] };
    return { data: [] };
  });
}

test('会員番号あり・送信済みなし → ウェルカムメールを1回だけ送る', async () => {
  const email = 'cron-welcome-ok@example.com';
  wireActiveSubscription({ id: 'sub_cron_ok', customerId: 'cus_cron_ok', email });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.welcomeEmail.checked, 1);
  assert.equal(res.body.welcomeEmail.sent, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(await redis.get(welcomeEmailSentKey('sub_cron_ok')), '1');
});

test('送信済み(welcome-email:sent)がある場合は送らない。候補一覧のsubscription.idで先に確認するため、Resendだけでなく追加のStripe問い合わせも発生しない', async () => {
  const email = 'cron-welcome-already@example.com';
  // 会員番号も事前に同期済みにしておく(RedisとStripe写しが一致)。そうしないと
  // 会員番号採番(保険)側がcustomers.list/customers.retrieveを呼んでしまい、
  // ウェルカムメール側が追加で呼んでいないことを区別できない。
  wireActiveSubscription({
    id: 'sub_cron_already',
    customerId: 'cus_cron_already',
    email,
    customerMetadata: { ls_member_no: '1' },
  });
  await redis.set(redisKey('ls_member_no', 'by_email', email), '1');
  await redis.set(welcomeEmailSentKey('sub_cron_already'), '1');

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.welcomeEmail.checked, 1);
  assert.equal(res.body.welcomeEmail.sent, 0);
  assert.equal(fetchCalls.length, 0, '送信済みなのでResendへ問い合わせない');

  const calls = fakeStripe.__getCallLog();
  assert.ok(
    !calls.includes('customers.list'),
    'maybeSendWelcomeEmail()内のgetActiveSubscriptionWithItem()が呼ばれている(customers.list)'
  );
  assert.ok(!calls.includes('prices.retrieve'), 'maybeSendWelcomeEmail()内のプラン名解決が呼ばれている(prices.retrieve)');
  assert.ok(!calls.includes('customers.retrieve'), '会員番号側のStripe往復も発生していないはず');
});

test('会員番号が未採番の契約者には送らない(checkedは増えるがsentは増えない)', async () => {
  const email = 'cron-welcome-no-member-no@example.com';
  // getMemberNo/assignMemberNoIfMissingの往復をそのまま通すため、Stripe側の
  // customers.retrieve/updateも最低限動くようにしておく(wireActiveSubscriptionの
  // customers.listだけでは採番までは進むはずだが、ここでは意図的に採番前の状態を
  // 確認したいので、assignMemberNoIfMissing自体が失敗する状況を作る)。
  wireActiveSubscription({ id: 'sub_cron_no_no', customerId: 'cus_cron_no_no', email });
  fakeStripe.__setHandler('customers.retrieve', async () => {
    throw new Error('stripe down');
  });

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), null);
  assert.equal(res.body.welcomeEmail.checked, 1);
  assert.equal(res.body.welcomeEmail.sent, 0);
  assert.equal(fetchCalls.length, 0);
});
