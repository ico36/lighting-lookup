// tests/lib/buildPrefectureStats.test.mjs
// lib/companyStats.js の buildPrefectureStats() は Redis に依存しない純粋関数として
// 切り出してあるため、redis.scan()/redis.mget() の結果を直接組み立てて渡すだけでテストできる。
// 対象は管理者除外・未登録の計上・0件の県の省略・Preview接頭辞の剥がしの4点。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildPrefectureStats, extractEmailFromCompanyKey } from '../../lib/companyStats.js';

beforeEach(() => {
  delete process.env.ADMIN_EMAILS;
});

test('extractEmailFromCompanyKey(): company:{email}からメールアドレスを取り出す', () => {
  assert.equal(extractEmailFromCompanyKey('company:foo@example.com'), 'foo@example.com');
});

test('extractEmailFromCompanyKey(): preview:接頭辞を剥がしてからメールアドレスを取り出す', () => {
  assert.equal(extractEmailFromCompanyKey('preview:company:foo@example.com'), 'foo@example.com');
});

test('buildPrefectureStats(): 都道府県ごとに件数を集計する', () => {
  const keys = ['company:a@example.com', 'company:b@example.com', 'company:c@example.com'];
  const values = [
    { name: 'A社', prefecture: '東京都' },
    { name: 'B社', prefecture: '東京都' },
    { name: 'C社', prefecture: '大阪府' },
  ];

  const result = buildPrefectureStats(keys, values);

  assert.equal(result.total, 3);
  assert.equal(result.unregistered, 0);
  assert.deepEqual(result.byPrefecture, { '東京都': 2, '大阪府': 1 });
});

test('buildPrefectureStats(): ADMIN_EMAILSに含まれるアカウントは集計から除外する', () => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const keys = ['company:admin@example.com', 'company:user@example.com'];
  const values = [
    { name: '管理者', prefecture: '東京都' },
    { name: '一般ユーザー', prefecture: '東京都' },
  ];

  const result = buildPrefectureStats(keys, values);

  assert.equal(result.total, 1, '管理者を除いた件数のみ数える');
  assert.deepEqual(result.byPrefecture, { '東京都': 1 });
});

test('buildPrefectureStats(): prefectureが無いアカウントは「未登録」に計上し、都道府県別には出さない', () => {
  const keys = ['company:a@example.com', 'company:b@example.com'];
  const values = [
    { name: 'A社', prefecture: '東京都' },
    { name: 'B社' }, // 住所必須化前に登録した既存アカウント相当(prefectureキー自体が無い)
  ];

  const result = buildPrefectureStats(keys, values);

  assert.equal(result.total, 2);
  assert.equal(result.unregistered, 1);
  assert.deepEqual(result.byPrefecture, { '東京都': 1 });
});

test('buildPrefectureStats(): 0件の都道府県はbyPrefectureに出てこない', () => {
  const keys = ['company:a@example.com'];
  const values = [{ name: 'A社', prefecture: '沖縄県' }];

  const result = buildPrefectureStats(keys, values);

  assert.deepEqual(Object.keys(result.byPrefecture), ['沖縄県']);
  assert.equal('北海道' in result.byPrefecture, false);
});

test('buildPrefectureStats(): byPrefectureのキー順はlib/prefectures.jsの47件の並び(北から)に従う', () => {
  const keys = ['company:a@example.com', 'company:b@example.com', 'company:c@example.com'];
  const values = [
    { name: 'A社', prefecture: '沖縄県' },
    { name: 'B社', prefecture: '北海道' },
    { name: 'C社', prefecture: '東京都' },
  ];

  const result = buildPrefectureStats(keys, values);

  assert.deepEqual(Object.keys(result.byPrefecture), ['北海道', '東京都', '沖縄県']);
});

test('buildPrefectureStats(): preview:接頭辞付きキーでも管理者除外・集計が正しく動く', () => {
  process.env.ADMIN_EMAILS = 'admin@example.com';
  const keys = ['preview:company:admin@example.com', 'preview:company:user@example.com'];
  const values = [
    { name: '管理者', prefecture: '東京都' },
    { name: '一般ユーザー', prefecture: '福岡県' },
  ];

  const result = buildPrefectureStats(keys, values);

  assert.equal(result.total, 1);
  assert.deepEqual(result.byPrefecture, { '福岡県': 1 });
});

test('buildPrefectureStats(): 値がnull(scan後・mget前に削除された等)のキーは無視する', () => {
  const keys = ['company:a@example.com', 'company:deleted@example.com'];
  const values = [{ name: 'A社', prefecture: '東京都' }, null];

  const result = buildPrefectureStats(keys, values);

  assert.equal(result.total, 1);
  assert.deepEqual(result.byPrefecture, { '東京都': 1 });
});

test('buildPrefectureStats(): 値がJSON文字列(mgetがパースをあきらめた場合)でも正しく集計する', () => {
  const keys = ['company:a@example.com'];
  const values = [JSON.stringify({ name: 'A社', prefecture: '東京都' })];

  const result = buildPrefectureStats(keys, values);

  assert.equal(result.total, 1);
  assert.deepEqual(result.byPrefecture, { '東京都': 1 });
});

test('buildPrefectureStats(): 値が壊れたJSON文字列ならJSON.parseに失敗し、集計対象から無視する', () => {
  const keys = ['company:a@example.com', 'company:broken@example.com'];
  const values = [{ name: 'A社', prefecture: '東京都' }, 'これはJSONではない文字列'];

  const result = buildPrefectureStats(keys, values);

  assert.equal(result.total, 1, '壊れた値はtotalにも数えない');
  assert.deepEqual(result.byPrefecture, { '東京都': 1 });
});
