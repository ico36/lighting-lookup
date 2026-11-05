// tests/api/stats.login.test.mjs
// api/stats/login.js の単体テスト。本体(api/login.js)と違い、許可リスト
// (STATS_VIEWER_EMAILS)に無いアドレスにもコードを送らないが、応答の形・
// クールダウンの付与タイミングは許可リストの有無に関わらず同じにする
// (応答から許可リストの有無が分からないようにする)ことを重点的に確認する。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/stats/login.js';
import { verifyStatsSessionToken } from '../../api/stats/_auth.js';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { __resetFakeRedis } from '../support/fakes/redis.mjs';

const REAL_FETCH = globalThis.fetch;

let fetchCalls;

beforeEach(() => {
  __resetFakeRedis();
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '経営統計 <noreply@example.com>';
  // SESSION_SECRETはOTPコードのハッシュ化(lib/otp.jsのhashOtpCode、namespaceを
  // 問わず共有)に使われる。STATS_SESSION_SECRETとは別の用途(セッショントークンの
  // 署名)で、こちらも必要。
  process.env.SESSION_SECRET = 'main-secret';
  process.env.STATS_SESSION_SECRET = 'stats-secret';
  process.env.STATS_VIEWER_EMAILS = 'shibata@example.com';
  fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function callLogin(body, overrides = {}) {
  const req = fakeReq(body, overrides);
  const res = fakeRes();
  await handler(req, res);
  return res;
}

function extractSentCode() {
  assert.equal(fetchCalls.length, 1);
  const body = JSON.parse(fetchCalls[0].options.body);
  const match = body.text.match(/(\d{6})/);
  assert.ok(match, 'メール本文に6桁のコードが含まれているはず');
  return match[1];
}

// --- request-otp ---

test('request-otp: 許可リストにあるメールアドレスには実際にコードを送る', async () => {
  const res = await callLogin({ action: 'request-otp', email: 'shibata@example.com' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, mode: 'otp' });
  assert.equal(fetchCalls.length, 1);
});

test('request-otp: 許可リストに無いメールアドレスにはコードを送らないが、応答は同じ形', async () => {
  const res = await callLogin({ action: 'request-otp', email: 'stranger@example.com' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, mode: 'otp' });
  assert.equal(fetchCalls.length, 0, '許可リストに無いのでResendへは送らない');
});

test('request-otp: 許可リストの有無に関わらず、2回目はクールダウンで429になる(応答から判別できない)', async () => {
  const allowedFirst = await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
  const strangerFirst = await callLogin({ action: 'request-otp', email: 'stranger@example.com' });
  assert.equal(allowedFirst.statusCode, 200);
  assert.equal(strangerFirst.statusCode, 200);

  const allowedSecond = await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
  const strangerSecond = await callLogin({ action: 'request-otp', email: 'stranger@example.com' });

  assert.equal(allowedSecond.statusCode, 429);
  assert.equal(strangerSecond.statusCode, 429);
  assert.deepEqual(allowedSecond.body, strangerSecond.body, '応答の内容も完全に同じはず');
});

test('request-otp: メールアドレスの形式が不正なら400', async () => {
  const res = await callLogin({ action: 'request-otp', email: 'not-an-email' });
  assert.equal(res.statusCode, 400);
});

test('request-otp: RESEND_API_KEY/MAIL_FROM未設定なら500', async () => {
  delete process.env.RESEND_API_KEY;
  const res = await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
  assert.equal(res.statusCode, 500);
});

test('request-otp: メール単位のレート制限を超えると429', async () => {
  // メール単位のレート制限はcheckRateLimit(key, 10, ...)なので、同一メールへの
  // 11回目のrequest-otpで429になることを確認する。クールダウン(429)と区別するため、
  // __expireKey()でクールダウン分だけ毎回クリアしながら11回呼ぶ。
  const { __expireKey, redisKey } = await import('../support/fakes/redis.mjs');
  for (let i = 0; i < 10; i++) {
    const res = await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
    assert.equal(res.statusCode, 200, `${i + 1}回目は200のはず`);
    __expireKey(redisKey('stats-otp', 'cooldown', 'shibata@example.com'));
  }
  const res = await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
  assert.equal(res.statusCode, 429);
});

// --- verify-otp ---

test('verify-otp: 正しいコードでログインに成功し、有効なトークンが発行される', async () => {
  await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
  const code = extractSentCode();

  const res = await callLogin({ action: 'verify-otp', email: 'shibata@example.com', code });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(verifyStatsSessionToken(res.body.token), 'shibata@example.com');
});

test('verify-otp: コードを要求していないメールアドレス(許可リスト外)は常にCODE_EXPIRED', async () => {
  const res = await callLogin({ action: 'verify-otp', email: 'stranger@example.com', code: '123456' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'CODE_EXPIRED');
});

test('verify-otp: 正しいコードでも、検証時に許可リストから外れていればログインできない', async () => {
  await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
  const code = extractSentCode();

  process.env.STATS_VIEWER_EMAILS = 'other@example.com'; // 発行後にリストから外れた想定

  const res = await callLogin({ action: 'verify-otp', email: 'shibata@example.com', code });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.token, undefined);
});

test('verify-otp: 間違ったコードはINVALID_CODE', async () => {
  await callLogin({ action: 'request-otp', email: 'shibata@example.com' });

  const res = await callLogin({ action: 'verify-otp', email: 'shibata@example.com', code: '000000' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'INVALID_CODE');
});

test('verify-otp: STATS_SESSION_SECRET未設定なら500(正しいコードでも発行できない)', async () => {
  await callLogin({ action: 'request-otp', email: 'shibata@example.com' });
  const code = extractSentCode();
  delete process.env.STATS_SESSION_SECRET;

  const res = await callLogin({ action: 'verify-otp', email: 'shibata@example.com', code });
  assert.equal(res.statusCode, 500);
});

test('verify-otp: コードの形式が不正なら400', async () => {
  const res = await callLogin({ action: 'verify-otp', email: 'shibata@example.com', code: 'abc' });
  assert.equal(res.statusCode, 400);
});

// --- handler共通 ---

test('GET等のPOST以外は405', async () => {
  const res = await callLogin({ action: 'request-otp', email: 'shibata@example.com' }, { method: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('actionが不正・未指定なら400', async () => {
  const res = await callLogin({ email: 'shibata@example.com' });
  assert.equal(res.statusCode, 400);
});
