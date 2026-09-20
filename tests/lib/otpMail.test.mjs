// tests/lib/otpMail.test.mjs
// lib/otpMail.js の sendOtpEmail() の分岐網羅。Resendの下にあるのはfetchだけで、
// loader.mjs で差し替えられるimport specifierが無いため、globalThis.fetch自体を
// このテストの中だけスタブに差し替える(afterEachで必ず元に戻す)。
// api/login.js からの利用(送信失敗時のロールバック等)はtests/api/login.*.test.mjs側で
// tests/support/fakes/otpMail.mjs を使って確認する(ここは対象外)。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendOtpEmail } from '../../lib/otpMail.js';

const REAL_FETCH = globalThis.fetch;
const REAL_CONSOLE_ERROR = console.error;

let fetchCalls;
let consoleErrorCalls;

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  fetchCalls = [];
  consoleErrorCalls = [];
  console.error = (...args) => {
    consoleErrorCalls.push(args);
  };
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  console.error = REAL_CONSOLE_ERROR;
});

function stubFetchOk() {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ id: 'email_test' }) };
  };
}

function stubFetchError(status, body) {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: false, status, json: async () => body };
  };
}

function stubFetchAbort() {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    throw err;
  };
}

test('正常系: Resendへ正しいURL・ヘッダー・ボディ(from/to/subject/text)で送る', async () => {
  stubFetchOk();

  await sendOtpEmail({ to: 'user@example.com', code: '123456' });

  assert.equal(fetchCalls.length, 1);
  const { url, options } = fetchCalls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Authorization'], 'Bearer test-resend-api-key');
  assert.equal(options.headers['Content-Type'], 'application/json');

  const body = JSON.parse(options.body);
  assert.deepEqual(Object.keys(body), ['from', 'to', 'subject', 'text']);
  assert.equal(body.from, '照明サーチ <noreply@example.com>');
  assert.deepEqual(body.to, ['user@example.com']);
  assert.equal(body.subject, '照明サーチ ログインコード');
  assert.ok(body.text.includes('123456'));
  assert.ok(body.text.includes('10分'));
  assert.ok(!/https?:\/\//.test(body.text)); // URLは入れない
});

test('MAIL_FROMは表示名付きでも加工せずそのままfromに渡す', async () => {
  process.env.MAIL_FROM = '照明サーチ <login@lighting-lookup.example>';
  stubFetchOk();

  await sendOtpEmail({ to: 'user@example.com', code: '000000' });

  const body = JSON.parse(fetchCalls[0].options.body);
  assert.equal(body.from, '照明サーチ <login@lighting-lookup.example>');
});

test('Resendが非2xxを返すと例外を投げ、メッセージにコード・APIキーを含まない', async () => {
  stubFetchError(422, { name: 'validation_error', message: 'Invalid `to` field' });

  await assert.rejects(
    () => sendOtpEmail({ to: 'user@example.com', code: '654321' }),
    (err) => {
      assert.ok(!err.message.includes('654321'));
      assert.ok(!err.message.includes('test-resend-api-key'));
      return true;
    }
  );

  // console.errorにHTTPステータスとResendのエラー内容(name/message)は出すが、
  // コード・APIキーは出さない。
  assert.equal(consoleErrorCalls.length, 1);
  const loggedArgs = consoleErrorCalls[0];
  assert.ok(loggedArgs.includes(422));
  assert.ok(loggedArgs.includes('validation_error'));
  assert.ok(loggedArgs.includes('Invalid `to` field'));
  const loggedText = loggedArgs.join(' ');
  assert.ok(!loggedText.includes('654321'));
  assert.ok(!loggedText.includes('test-resend-api-key'));
});

test('タイムアウト等でfetch自体が失敗(AbortError)しても例外にコード・APIキーを含まない', async () => {
  stubFetchAbort();

  await assert.rejects(
    () => sendOtpEmail({ to: 'user@example.com', code: '111222' }),
    (err) => {
      assert.ok(!err.message.includes('111222'));
      assert.ok(!err.message.includes('test-resend-api-key'));
      return true;
    }
  );

  assert.equal(consoleErrorCalls.length, 1);
  const loggedText = consoleErrorCalls[0].join(' ');
  assert.ok(!loggedText.includes('111222'));
  assert.ok(!loggedText.includes('test-resend-api-key'));
});
