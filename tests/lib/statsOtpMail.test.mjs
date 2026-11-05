// tests/lib/statsOtpMail.test.mjs
// lib/statsOtpMail.js の sendStatsOtpEmail() の分岐網羅。tests/lib/otpMail.test.mjsと
// 同じ構造(globalThis.fetch自体をスタブに差し替える)。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendStatsOtpEmail } from '../../lib/statsOtpMail.js';

const REAL_FETCH = globalThis.fetch;
const REAL_CONSOLE_ERROR = console.error;

let fetchCalls;
let consoleErrorCalls;

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '経営統計 <noreply@example.com>';
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

test('正常系: Resendへ正しいURL・ヘッダー・ボディ(from/to/subject/text)で送る。件名・本文は統計サイト向け', async () => {
  stubFetchOk();

  await sendStatsOtpEmail({ to: 'shibata@example.com', code: '123456' });

  assert.equal(fetchCalls.length, 1);
  const { url, options } = fetchCalls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['Authorization'], 'Bearer test-resend-api-key');
  assert.equal(options.headers['Content-Type'], 'application/json');

  const body = JSON.parse(options.body);
  assert.deepEqual(Object.keys(body), ['from', 'to', 'subject', 'text']);
  assert.equal(body.from, '経営統計 <noreply@example.com>');
  assert.deepEqual(body.to, ['shibata@example.com']);
  assert.equal(body.subject, '経営統計ログインコード');
  assert.ok(body.text.includes('123456'));
  assert.ok(body.text.includes('10分'));
  assert.ok(!body.text.includes('照明サーチ'), '照明サーチ本体のブランドと混同させない');
});

test('Resendが非2xxを返すと例外を投げ、メッセージにコード・APIキーを含まない', async () => {
  stubFetchError(422, { name: 'validation_error', message: 'Invalid `to` field' });

  await assert.rejects(
    () => sendStatsOtpEmail({ to: 'shibata@example.com', code: '654321' }),
    (err) => {
      assert.ok(!err.message.includes('654321'));
      assert.ok(!err.message.includes('test-resend-api-key'));
      return true;
    }
  );

  assert.equal(consoleErrorCalls.length, 1);
  const loggedText = consoleErrorCalls[0].join(' ');
  assert.ok(loggedText.includes('422'));
  assert.ok(loggedText.includes('validation_error'));
  assert.ok(!loggedText.includes('654321'));
  assert.ok(!loggedText.includes('test-resend-api-key'));
});

test('タイムアウト等でfetch自体が失敗(AbortError)しても例外にコード・APIキーを含まない', async () => {
  stubFetchAbort();

  await assert.rejects(
    () => sendStatsOtpEmail({ to: 'shibata@example.com', code: '111222' }),
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
