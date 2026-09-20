// tests/api/login.verify-otp.test.mjs
// api/login.js の action:'verify-otp' の分岐網羅。request-otpはtests/api/login.request-otp.test.mjsへ。
// フェイクの構成はtests/api/login.request-otp.test.mjs冒頭のコメントと同じ。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/login.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeOtpMail from '../support/fakes/otpMail.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { storeOtp, hashOtpCode, readOtp } from '../../lib/otp.js';

const EMAIL = 'otp-verify-test@example.com';
const ADMIN_EMAIL = 'admin@example.com';
const IP = '203.0.113.20';
const CODE = '123456';

function req(body) {
  return fakeReq(body, { headers: { 'x-forwarded-for': IP } });
}

async function seedOtp(email, code) {
  await storeOtp(email, hashOtpCode(email, code));
}

beforeEach(() => {
  fakeStripe.__reset();
  fakeOtpMail.__reset();
  __resetFakeRedis();
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  process.env.ADMIN_EMAILS = 'admin@example.com';
  delete process.env.LOGIN_MODE;
  delete process.env.VERCEL_ENV;
});

// 管理者アカウントを使う理由: getSubscriptionStateCached()はlib/subscription.js経由の
// `./redis`を未フェイクの実クライアントで呼ぶため、非管理者だとKV_REST_API_URL/TOKEN
// 未設定でも実際にfetchを試みて失敗するまで数秒かかる(get・set2回で計8秒超)。
// 管理者はこの関数の内部でStripe/Redisどちらにも触れず即答するため、テストの本題
// (照合成功後のtoken発行・キー削除)を変えずに高速化できる
// (既存のtests/api/checkout.*.test.mjsが同種の理由でgetSubscriptionStateCached()/
// readQuota()を意図的にフェイクしていないのと同じ制約への対処)。
test('正しいコードで200・tokenが返り、otp:{email}とotp:attempts:{email}が削除される', async () => {
  await seedOtp(ADMIN_EMAIL, CODE);
  const res = fakeRes();
  await handler(req({ action: 'verify-otp', email: ADMIN_EMAIL, code: CODE }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(res.body.admin, true);
  assert.ok(res.body.quota);

  assert.equal(await readOtp(ADMIN_EMAIL), null);
  assert.equal(await redis.get(redisKey('otp', 'attempts', ADMIN_EMAIL)), null);
});

test('誤ったコードで401 INVALID_CODE、attemptsがインクリメントされる', async () => {
  await seedOtp(EMAIL, CODE);
  const res = fakeRes();
  await handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'INVALID_CODE');
  assert.equal(await redis.get(redisKey('otp', 'attempts', EMAIL)), 1);
  assert.ok(await readOtp(EMAIL)); // レコードはまだ残る
});

test('5回連続で誤ったコード: 5回目で401 INVALID_CODEかつレコード削除、6回目は401 CODE_EXPIRED', async () => {
  await seedOtp(EMAIL, CODE);

  for (let i = 1; i <= 5; i++) {
    const res = fakeRes();
    await handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'INVALID_CODE');
  }
  assert.equal(await readOtp(EMAIL), null); // 5回目で削除済み

  const res6 = fakeRes();
  await handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res6);
  assert.equal(res6.statusCode, 401);
  assert.equal(res6.body.code, 'CODE_EXPIRED');
});

test('レコードがない(未発行・期限切れ)場合は401 CODE_EXPIRED', async () => {
  const res = fakeRes();
  await handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'CODE_EXPIRED');
});

test('全角数字・空白入りのコードでも照合が通る', async () => {
  // 管理者アカウントを使う理由は上の「正しいコードで200」テストと同じ
  // (このテストの主題はコードの正規化であり、admin/非adminは無関係)。
  await seedOtp(ADMIN_EMAIL, CODE);
  const res = fakeRes();
  await handler(req({ action: 'verify-otp', email: ADMIN_EMAIL, code: '１２３ ４５６' }), res);
  assert.equal(res.statusCode, 200);
});

test('6桁の数字にならない入力は400で、attemptsは増えない', async () => {
  await seedOtp(EMAIL, CODE);
  const res = fakeRes();
  await handler(req({ action: 'verify-otp', email: EMAIL, code: '12345' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(await redis.get(redisKey('otp', 'attempts', EMAIL)), 0); // storeOtp直後の初期値のまま
});

test('照合成功後に契約が失効していれば401 SUBSCRIPTION_INACTIVE', async () => {
  await seedOtp(EMAIL, CODE);
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [] }));

  const res = fakeRes();
  await handler(req({ action: 'verify-otp', email: EMAIL, code: CODE }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'SUBSCRIPTION_INACTIVE');
  assert.equal(await readOtp(EMAIL), null); // 照合自体は成功しているので削除済み
});

test('レコードがない状態でverify-otpを何回投げてもemail単位の検証カウンタが増えない', async () => {
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    await handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res);
    assert.equal(res.body.code, 'CODE_EXPIRED');
  }
  assert.equal(await redis.get(redisKey('ratelimit', 'otp-verify', 'email', EMAIL)), null);
  // IP単位のカウンタは(レコードの有無に関わらず)毎回増える
  assert.equal(await redis.get(redisKey('ratelimit', 'otp-verify', 'ip', IP)), 3);
});

test('email単位の検証回数制限(11回目)は429', async () => {
  await seedOtp(EMAIL, CODE);
  // email単位カウンタはレコードがある場合だけ数える。attemptsの上限(5)より先に
  // 検証回数制限(10)へ到達させたいので、5回失敗した直後に新しいOTPを都度re-seedして
  // attemptsの上限には引っかからないようにする。
  for (let i = 0; i < 10; i++) {
    await seedOtp(EMAIL, CODE);
    const res = fakeRes();
    await handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res);
    assert.equal(res.statusCode, 401);
  }
  await seedOtp(EMAIL, CODE);
  const res11 = fakeRes();
  await handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res11);
  assert.equal(res11.statusCode, 429);
});

test('IP単位の検証回数制限(31回目)は429', async () => {
  for (let i = 0; i < 30; i++) {
    const res = fakeRes();
    // emailごとの検証制限(10/日)に引っかからないよう、呼び出しごとにemailを変える。
    await handler(req({ action: 'verify-otp', email: `ip-verify-${i}@example.com`, code: '000000' }), res);
    assert.equal(res.body.code, 'CODE_EXPIRED');
  }
  const res31 = fakeRes();
  await handler(req({ action: 'verify-otp', email: 'ip-verify-final@example.com', code: '000000' }), res31);
  assert.equal(res31.statusCode, 429);
});

test('同時に複数のverify-otp(誤ったコード)を投げてもOTP_MAX_ATTEMPTSを超えて照合されない', async () => {
  await seedOtp(EMAIL, CODE);

  const CONCURRENT_REQUESTS = 8;
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () => {
      const res = fakeRes();
      return handler(req({ action: 'verify-otp', email: EMAIL, code: '000000' }), res).then(() => res);
    })
  );

  const invalidCodeCount = results.filter((res) => res.body.code === 'INVALID_CODE').length;
  const codeExpiredCount = results.filter((res) => res.body.code === 'CODE_EXPIRED').length;

  assert.equal(invalidCodeCount, 5); // OTP_MAX_ATTEMPTS
  assert.equal(codeExpiredCount, CONCURRENT_REQUESTS - 5);
  assert.equal(await readOtp(EMAIL), null);
});

test('大文字を含むメールでrequest-otpし、小文字でverify-otpしても通る', async () => {
  // 管理者アカウントを使う理由は上の「正しいコードで200」テストと同じ
  // (このテストの主題はメールアドレスの正規化であり、admin/非adminは無関係)。
  const mixedCaseEmail = 'Admin@Example.COM';
  const lowerCaseEmail = ADMIN_EMAIL;

  const requestRes = fakeRes();
  await handler(req({ action: 'request-otp', email: mixedCaseEmail }), requestRes);
  assert.equal(requestRes.statusCode, 200);

  const sent = fakeOtpMail.__getSentEmails();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, lowerCaseEmail); // 正規化されて保存・送信されている

  const verifyRes = fakeRes();
  await handler(req({ action: 'verify-otp', email: lowerCaseEmail, code: sent[0].code }), verifyRes);
  assert.equal(verifyRes.statusCode, 200);
  assert.equal(typeof verifyRes.body.token, 'string');
});

test('管理者でもrequest-otpを経ずにverify-otpだけでは401 CODE_EXPIRED(即時ログイン経路廃止の回帰防止)', async () => {
  const res = fakeRes();
  await handler(req({ action: 'verify-otp', email: ADMIN_EMAIL, code: '123456' }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'CODE_EXPIRED');
  assert.equal('token' in res.body, false);
});
