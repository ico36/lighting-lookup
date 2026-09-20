// tests/lib/otp.test.mjs
// lib/otp.js の分岐網羅。api/login.js のレート制限・メール送信・レスポンス組み立ては
// 対象外(これらはコミット3のtests/api/login.*.test.mjsで扱う)。
//
// 【フェイクの構成】lib/otp.js が読む `./redis` は tests/support/loader.mjs のルールで
// tests/support/fakes/redis.mjs へ差し替わる。lib/otp.js自体は本物のまま読み込む。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { __resetFakeRedis, __expireKey, __getTTLSeconds, redisKey } from '../support/fakes/redis.mjs';
import {
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  generateOtpCode,
  hashOtpCode,
  normalizeOtpCode,
  storeOtp,
  readOtp,
  incrementOtpAttempts,
  clearOtpState,
  canResendOtp,
  markOtpSent,
} from '../../lib/otp.js';

const EMAIL = 'otp-test@example.com';

beforeEach(() => {
  __resetFakeRedis();
  process.env.SESSION_SECRET = 'test-session-secret';
});

test('generateOtpCode() は常に6桁の数字文字列を返す(先頭ゼロを含む)', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateOtpCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('hashOtpCode() は同一のemail・codeなら同じハッシュ、どちらかが違えば異なるハッシュ', () => {
  const h1 = hashOtpCode(EMAIL, '123456');
  const h2 = hashOtpCode(EMAIL, '123456');
  const h3 = hashOtpCode(EMAIL, '654321');
  const h4 = hashOtpCode('other@example.com', '123456');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.notEqual(h1, h4);
});

test('normalizeOtpCode() は全角数字を半角化し、空白・ハイフンを除去する', () => {
  assert.equal(normalizeOtpCode('１２３４５６'), '123456');
  assert.equal(normalizeOtpCode('123 456'), '123456');
  assert.equal(normalizeOtpCode('123-456'), '123456');
  assert.equal(normalizeOtpCode('１２３-４５６'), '123456');
});

test('normalizeOtpCode() は6桁の数字にならない入力にnullを返す', () => {
  assert.equal(normalizeOtpCode('12345'), null);
  assert.equal(normalizeOtpCode('1234567'), null);
  assert.equal(normalizeOtpCode('12345a'), null);
  assert.equal(normalizeOtpCode(''), null);
  assert.equal(normalizeOtpCode(undefined), null);
  assert.equal(normalizeOtpCode(123456), null);
});

test('storeOtp() は otp:{email} と otp:attempts:{email} を同じTTLで同時に作る', async () => {
  const hash = hashOtpCode(EMAIL, '123456');
  await storeOtp(EMAIL, hash);

  const record = await readOtp(EMAIL);
  assert.equal(record.hash, hash);
  assert.equal(typeof record.createdAt, 'number');

  const attemptsTTL = __getTTLSeconds(redisKey('otp', 'attempts', EMAIL));
  const otpTTL = __getTTLSeconds(redisKey('otp', EMAIL));
  assert.ok(attemptsTTL !== null && otpTTL !== null);
  // 同時に設定しているため、テスト実行のわずかな誤差はあっても数秒以内には収まる。
  assert.ok(Math.abs(attemptsTTL - otpTTL) <= 2);
  assert.ok(otpTTL <= OTP_TTL_SECONDS && otpTTL > OTP_TTL_SECONDS - 5);
});

test('readOtp() は未発行のemailにnullを返す', async () => {
  assert.equal(await readOtp(EMAIL), null);
});

test('incrementOtpAttempts() は呼ぶたびに加算した値を返す', async () => {
  await storeOtp(EMAIL, hashOtpCode(EMAIL, '123456'));
  assert.equal(await incrementOtpAttempts(EMAIL), 1);
  assert.equal(await incrementOtpAttempts(EMAIL), 2);
  assert.equal(await incrementOtpAttempts(EMAIL), 3);
});

test('incrementOtpAttempts() は otp:attempts:{email} が欠けていても1からカウントしTTLを付け直す(保険)', async () => {
  // storeOtp() を経由せず、いきなり incrementOtpAttempts() だけ呼ぶケース
  // (本来起こらないはずだが、保険のEXPIRE付与を確認する)。
  const attempts = await incrementOtpAttempts(EMAIL);
  assert.equal(attempts, 1);
  const ttl = __getTTLSeconds(redisKey('otp', 'attempts', EMAIL));
  assert.ok(ttl !== null && ttl > OTP_TTL_SECONDS - 5);
});

test('clearOtpState() は otp:{email}・otp:attempts:{email}・otp:cooldown:{email} を全て削除する', async () => {
  await storeOtp(EMAIL, hashOtpCode(EMAIL, '123456'));
  await incrementOtpAttempts(EMAIL);
  await markOtpSent(EMAIL);

  await clearOtpState(EMAIL);

  assert.equal(await readOtp(EMAIL), null);
  assert.equal(await incrementOtpAttempts(EMAIL), 1); // 削除済みなので1から
  assert.equal(await canResendOtp(EMAIL), true); // クールダウンも消えている
});

test('canResendOtp()/markOtpSent() は送信直後クールダウン中はfalse、経過後(TTL失効相当)はtrue', async () => {
  assert.equal(await canResendOtp(EMAIL), true);

  await markOtpSent(EMAIL);
  assert.equal(await canResendOtp(EMAIL), false);

  const ttl = __getTTLSeconds(redisKey('otp', 'cooldown', EMAIL));
  assert.ok(ttl !== null && ttl <= OTP_RESEND_COOLDOWN_SECONDS && ttl > OTP_RESEND_COOLDOWN_SECONDS - 5);

  __expireKey(redisKey('otp', 'cooldown', EMAIL));
  assert.equal(await canResendOtp(EMAIL), true);
});

test('OTP_MAX_ATTEMPTS は5', () => {
  assert.equal(OTP_MAX_ATTEMPTS, 5);
});
