// tests/lib/statsViewers.test.mjs
// lib/statsViewers.js の isStatsViewerEmail() の単体テスト。
// lib/adminEmails.js と同じ形(カンマ区切りの環境変数)なので、判定ロジックの
// 網羅性もlib/adminEmails.jsの考え方に合わせる。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { isStatsViewerEmail, getStatsViewerEmails } from '../../lib/statsViewers.js';

beforeEach(() => {
  delete process.env.STATS_VIEWER_EMAILS;
});

test('STATS_VIEWER_EMAILSに含まれるメールアドレスはtrue', () => {
  process.env.STATS_VIEWER_EMAILS = 'shibata@example.com,owner@example.com';
  assert.equal(isStatsViewerEmail('shibata@example.com'), true);
  assert.equal(isStatsViewerEmail('owner@example.com'), true);
});

test('STATS_VIEWER_EMAILSに含まれないメールアドレスはfalse', () => {
  process.env.STATS_VIEWER_EMAILS = 'shibata@example.com';
  assert.equal(isStatsViewerEmail('other@example.com'), false);
});

test('大文字・前後の空白は無視して判定する', () => {
  process.env.STATS_VIEWER_EMAILS = ' Shibata@Example.com ,owner@example.com';
  assert.equal(isStatsViewerEmail('shibata@example.com'), true);
  assert.equal(isStatsViewerEmail('  SHIBATA@EXAMPLE.COM  '), true);
});

test('STATS_VIEWER_EMAILS未設定・空文字なら常にfalse', () => {
  assert.equal(isStatsViewerEmail('shibata@example.com'), false);
  process.env.STATS_VIEWER_EMAILS = '';
  assert.equal(isStatsViewerEmail('shibata@example.com'), false);
});

test('getStatsViewerEmails(): カンマ区切りを正規化した配列で返す(重複は除く)', () => {
  process.env.STATS_VIEWER_EMAILS = ' Shibata@Example.com , owner@example.com,shibata@example.com';
  assert.deepEqual(getStatsViewerEmails(), ['shibata@example.com', 'owner@example.com']);
});

test('getStatsViewerEmails(): 未設定なら空配列', () => {
  assert.deepEqual(getStatsViewerEmails(), []);
});

test('ADMIN_EMAILSとは別のリストである(管理者に設定しても統計の許可リストには入らない)', () => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  process.env.STATS_VIEWER_EMAILS = 'shibata@example.com';
  assert.equal(isStatsViewerEmail('admin@example.com'), false);
  delete process.env.ADMIN_EMAILS;
});
