// tests/lib/ownerDeletion.previewGrace.test.mjs
// lib/ownerDeletion.js の getOwnerDeletionPreviewGraceMinutes() の単体テスト。
// Preview環境限定の実機確認用の猶予期間短縮(OWNER_DELETION_PREVIEW_GRACE_MINUTES)が、
// VERCEL_ENV==='preview'のときだけ・正の整数のときだけ有効になることを固定する。
// 本番(production)・development・VERCEL_ENV未設定では値があっても完全に無視されること
// (=暦6か月のフォールバックに落ちること)を確認する。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { getOwnerDeletionPreviewGraceMinutes } from '../../lib/ownerDeletion.js';

beforeEach(() => {
  delete process.env.VERCEL_ENV;
  delete process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES;
});

test('preview環境・正の整数 → その値(分)を返す', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = '15';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), 15);
});

test('preview環境・未設定 → null', () => {
  process.env.VERCEL_ENV = 'preview';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});

test('preview環境・0 → 無視してnull', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = '0';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});

test('preview環境・負数 → 無視してnull', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = '-5';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});

test('preview環境・小数 → 無視してnull', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = '5.5';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});

test('preview環境・数字以外 → 無視してnull', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = 'abc';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});

test('preview環境・前後に空白付きの正の整数 → trimして値を返す', () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = ' 20 ';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), 20);
});

test('production環境 → 値があっても完全に無視してnull', () => {
  process.env.VERCEL_ENV = 'production';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = '15';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});

test('development環境 → 値があっても完全に無視してnull', () => {
  process.env.VERCEL_ENV = 'development';
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = '15';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});

test('VERCEL_ENV未設定 → 値があっても完全に無視してnull', () => {
  process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES = '15';
  assert.equal(getOwnerDeletionPreviewGraceMinutes(), null);
});
