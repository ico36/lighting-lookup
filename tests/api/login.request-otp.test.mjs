// tests/api/login.request-otp.test.mjs
// api/login.js の action:'request-otp' の分岐網羅。verify-otpはtests/api/login.verify-otp.test.mjsへ。
//
// 【フェイクの構成】api/login.js が読む `../lib/redis`・lib/otp.js が読む `./redis` は
// いずれもtests/support/fakes/redis.mjsへ(loader.mjsのルール2c〜2f、同一インスタンスを共有)。
// `../lib/otpMail` は tests/support/fakes/otpMail.mjsへ。Stripe SDKはtests/support/fakes/stripe.mjsへ
// (loader.mjsのルール1、lib/subscription.js経由で効く)。lib/subscription.js・lib/otp.js・
// lib/quota.js・lib/legalConsent.js自体はフェイクにせず本物を読み込む
// (lib/subscription.js・lib/quota.jsが直接読む`./redis`は未フェイクの実クライアントだが、
// KV_REST_API_URL/TOKEN未設定でも各関数がフェイルオープンで吸収するため問題にならない)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/login.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeOtpMail from '../support/fakes/otpMail.mjs';
import { __resetFakeRedis, __expireKey, redis, redisKey } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { readOtp, canResendOtp } from '../../lib/otp.js';

const EMAIL = 'otp-login-test@example.com';
const ADMIN_EMAIL = 'admin@example.com';
const IP = '203.0.113.10';

function req(body) {
  return fakeReq(body, { headers: { 'x-forwarded-for': IP } });
}

beforeEach(() => {
  fakeStripe.__reset();
  fakeOtpMail.__reset();
  __resetFakeRedis();
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  delete process.env.LOGIN_MODE; // 既定のotp
  delete process.env.VERCEL_ENV;
});

test('actionが無いと400', async () => {
  const res = fakeRes();
  await handler(req({ email: EMAIL }), res);
  assert.equal(res.statusCode, 400);
});

test('不正なaction文字列は400', async () => {
  const res = fakeRes();
  await handler(req({ action: 'foo', email: EMAIL }), res);
  assert.equal(res.statusCode, 400);
});

test('未契約(顧客なし)はNO_CUSTOMERを返し、OTPを送らない', async () => {
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'NO_CUSTOMER');
  assert.equal(fakeOtpMail.__getSentEmails().length, 0);
  assert.equal(await readOtp(EMAIL), null);
});

test('未契約(有効なサブスクなし)はNO_ACTIVE_SUBSCRIPTIONを返し、OTPを送らない', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [] }));
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'NO_ACTIVE_SUBSCRIPTION');
  assert.equal(fakeOtpMail.__getSentEmails().length, 0);
});

test('管理者は契約チェックをスキップしてOTP発行まで進む', async () => {
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: ADMIN_EMAIL }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'otp');
  const sent = fakeOtpMail.__getSentEmails();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ADMIN_EMAIL);
});

test('otpモードの成功レスポンスにadminを含めない(未認証の相手に管理者かどうかを教えない)', async () => {
  const resAdmin = fakeRes();
  await handler(req({ action: 'request-otp', email: ADMIN_EMAIL }), resAdmin);
  assert.equal('admin' in resAdmin.body, false);

  const resUser = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), resUser);
  assert.equal('admin' in resUser.body, false);
});

test('正常系: ハッシュ化されたOTPがRedisに保存され、otpMailフェイクに正しい宛先・6桁コードが渡る', async () => {
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 200);

  const record = await readOtp(EMAIL);
  assert.ok(record);
  assert.equal(typeof record.hash, 'string');

  const sent = fakeOtpMail.__getSentEmails();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, EMAIL);
  assert.match(sent[0].code, /^\d{6}$/);
  assert.notEqual(record.hash, sent[0].code); // 平文コードがそのまま保存されていない
});

test('RESEND_API_KEY未設定(otpモード)は500。Redisに何も書き込まれない', async () => {
  delete process.env.RESEND_API_KEY;
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 500);
  assert.equal(await readOtp(EMAIL), null);
  assert.equal(fakeOtpMail.__getSentEmails().length, 0);
});

test('MAIL_FROM未設定(otpモード)は500', async () => {
  delete process.env.MAIL_FROM;
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 500);
});

// readQuota()はlib/subscription.js経由の`./redis`を未フェイクの実クライアントで
// 呼ぶため、上限が有限のプラン(既定のprice_light_test)だとKV_REST_API_URL/TOKEN
// 未設定でも実際にfetchを試みて失敗するまで数秒かかる。上限無制限のプラン
// (price_pro_test)ならisCountable()が早期にfalseを返しredisに触れないため、
// テストとしての意味(非管理者でlegacyが成功しadmin:falseを返す)を変えずに高速化できる。
function seedUnlimitedPlanSubscription() {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [
      {
        id: 'sub_test',
        customer: 'cus_test',
        status: 'active',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        items: { data: [{ id: 'si_test', price: fakeStripe.__getDefaultPrice('price_pro_test') }] },
      },
    ],
  }));
}

test('LOGIN_MODE=legacyはtoken・admin・quota・mode:legacyを返し、otpMailフェイクが呼ばれない', async () => {
  process.env.LOGIN_MODE = 'legacy';
  seedUnlimitedPlanSubscription();
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'legacy');
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.admin, false);
  assert.ok(res.body.quota);
  assert.equal(fakeOtpMail.__getSentEmails().length, 0);
});

test('LOGIN_MODE=legacyはRESEND_API_KEY/MAIL_FROM未設定でも成功する(設定チェック対象外)', async () => {
  process.env.LOGIN_MODE = 'legacy';
  seedUnlimitedPlanSubscription();
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'legacy');
});

test('60秒以内の連続request-otpはクールダウンで429。2通目は送られない', async () => {
  const res1 = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res1);
  assert.equal(res1.statusCode, 200);

  const res2 = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res2);
  assert.equal(res2.statusCode, 429);
  assert.equal(fakeOtpMail.__getSentEmails().length, 1);
});

test('クールダウン中は契約チェック(Stripeフェイク)が呼ばれない', async () => {
  await handler(req({ action: 'request-otp', email: EMAIL }), fakeRes());
  const callsAfterFirst = fakeStripe.__getCallLog().length;
  assert.ok(callsAfterFirst > 0);

  await handler(req({ action: 'request-otp', email: EMAIL }), fakeRes());
  const callsAfterSecond = fakeStripe.__getCallLog().length;
  assert.equal(callsAfterSecond, callsAfterFirst);
});

test('email側レート制限: 6回目は429', async () => {
  for (let i = 0; i < 5; i++) {
    const res = fakeRes();
    await handler(req({ action: 'request-otp', email: EMAIL }), res);
    assert.equal(res.statusCode, 200);
    // クールダウンはこのテストの対象外なので、レート制限だけを見るために毎回消す。
    __expireKey(redisKey('otp', 'cooldown', EMAIL));
  }
  const res6 = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res6);
  assert.equal(res6.statusCode, 429);
});

test('IP側レート制限: 21回目は429', async () => {
  for (let i = 0; i < 20; i++) {
    const res = fakeRes();
    await handler(req({ action: 'request-otp', email: `ip-rate-${i}@example.com` }), res);
    assert.equal(res.statusCode, 200);
  }
  const res21 = fakeRes();
  await handler(req({ action: 'request-otp', email: 'ip-rate-final@example.com' }), res21);
  assert.equal(res21.statusCode, 429);
});

test('LOGIN_MODE=legacyでもemail側レート制限: 6回目は429', async () => {
  process.env.LOGIN_MODE = 'legacy';
  seedUnlimitedPlanSubscription();
  for (let i = 0; i < 5; i++) {
    const res = fakeRes();
    await handler(req({ action: 'request-otp', email: EMAIL }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mode, 'legacy');
  }
  const res6 = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res6);
  assert.equal(res6.statusCode, 429);
});

test('LOGIN_MODE=legacyでもIP側レート制限: 21回目は429', async () => {
  process.env.LOGIN_MODE = 'legacy';
  seedUnlimitedPlanSubscription();
  for (let i = 0; i < 20; i++) {
    const res = fakeRes();
    await handler(req({ action: 'request-otp', email: `legacy-ip-rate-${i}@example.com` }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mode, 'legacy');
  }
  const res21 = fakeRes();
  await handler(req({ action: 'request-otp', email: 'legacy-ip-rate-final@example.com' }), res21);
  assert.equal(res21.statusCode, 429);
});

test('送信失敗時はotp:{email}・otp:attempts:{email}・otp:cooldown:{email}のいずれも残らない', async () => {
  fakeOtpMail.__setShouldFail(true);
  const res = fakeRes();
  await handler(req({ action: 'request-otp', email: EMAIL }), res);
  assert.equal(res.statusCode, 500);

  assert.equal(await readOtp(EMAIL), null);
  assert.equal(await canResendOtp(EMAIL), true);
  assert.equal(await redis.get(redisKey('otp', 'attempts', EMAIL)), null);
});
