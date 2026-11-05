// tests/api/stats._auth.test.mjs
// api/stats/_auth.js の単体テスト。STATS_SESSION_SECRETでの署名・検証、
// 許可リスト(STATS_VIEWER_EMAILS)の再確認、STATS_SESSION_SECRET未設定時の
// fail-closed、および本体(api/_auth.js)との鍵の分離(クロス検証)を対象にする。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  createStatsSessionToken,
  verifyStatsSessionToken,
  requireStatsAuth,
} from '../../api/stats/_auth.js';
import { verifySessionToken } from '../../api/_auth.js';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';

const EMAIL = 'shibata@example.com';

beforeEach(() => {
  process.env.STATS_SESSION_SECRET = 'stats-secret';
  process.env.SESSION_SECRET = 'main-secret';
  process.env.STATS_VIEWER_EMAILS = EMAIL;
  delete process.env.ADMIN_EMAILS;
});

test('createStatsSessionToken()で発行したトークンをverifyStatsSessionToken()で検証するとemailが返る', () => {
  const token = createStatsSessionToken(EMAIL);
  assert.equal(verifyStatsSessionToken(token), EMAIL);
});

test('STATS_SESSION_SECRET未設定ならcreateStatsSessionToken()は例外を投げる', () => {
  delete process.env.STATS_SESSION_SECRET;
  assert.throws(() => createStatsSessionToken(EMAIL));
});

test('STATS_SESSION_SECRET未設定ならverifyStatsSessionToken()はnull(fail-closed)', () => {
  const token = createStatsSessionToken(EMAIL);
  delete process.env.STATS_SESSION_SECRET;
  assert.equal(verifyStatsSessionToken(token), null);
});

test('有効期限切れのトークンはnull', () => {
  const originalNow = Date.now;
  Date.now = () => 1_000_000_000_000; // 固定の過去時刻で発行
  const token = createStatsSessionToken(EMAIL);
  Date.now = () => 1_000_000_000_000 + 31 * 24 * 60 * 60 * 1000; // 31日後
  const result = verifyStatsSessionToken(token);
  Date.now = originalNow;
  assert.equal(result, null);
});

test('署名が改ざんされたトークンはnull', () => {
  const token = createStatsSessionToken(EMAIL);
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const [email, expiresAt] = decoded.split(':');
  const tampered = Buffer.from(`${email}:${expiresAt}:0000000000000000000000000000000000000000000000000000000000000000`).toString('base64url');
  assert.equal(verifyStatsSessionToken(tampered), null);
});

test('壊れたトークン(base64url化できない・パーツ数が違う)はnull', () => {
  assert.equal(verifyStatsSessionToken(''), null);
  assert.equal(verifyStatsSessionToken(null), null);
  assert.equal(verifyStatsSessionToken(Buffer.from('a:b').toString('base64url')), null);
});

// --- 本体(api/_auth.js)との鍵の分離 ---

test('統計用トークンは本体のverifySessionToken()では無効になる(別の鍵で署名しているため)', () => {
  const statsToken = createStatsSessionToken(EMAIL);
  assert.equal(verifySessionToken(statsToken), null);
});

test('本体形式のトークンはverifyStatsSessionToken()では無効になる(別の鍵で署名しているため)', () => {
  // api/login.js のcreateSessionToken()と同じ形式(SESSION_SECRET署名)を手動で組み立てる。
  const expiresAt = Date.now() + 1000 * 60 * 60;
  const payload = `${EMAIL}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('hex');
  const mainToken = Buffer.from(`${payload}:${signature}`).toString('base64url');

  assert.equal(verifyStatsSessionToken(mainToken), null);
});

// --- requireStatsAuth() ---

async function callRequireStatsAuth(overrides = {}) {
  const req = fakeReq(undefined, { method: 'GET', ...overrides });
  const res = fakeRes();
  const email = await requireStatsAuth(req, res);
  return { email, res };
}

test('requireStatsAuth(): 有効なトークン・許可リストに含まれるメールならemailを返す', async () => {
  const token = createStatsSessionToken(EMAIL);
  const { email, res } = await callRequireStatsAuth({ headers: { authorization: `Bearer ${token}` } });

  assert.equal(email, EMAIL);
  assert.equal(res.statusCode, null, 'まだレスポンスを返していないはず');
});

test('requireStatsAuth(): トークンは有効でも許可リスト(STATS_VIEWER_EMAILS)に無ければ401', async () => {
  const token = createStatsSessionToken(EMAIL);
  process.env.STATS_VIEWER_EMAILS = 'other@example.com'; // 発行後にリストから外れた想定

  const { email, res } = await callRequireStatsAuth({ headers: { authorization: `Bearer ${token}` } });

  assert.equal(email, null);
  assert.equal(res.statusCode, 401);
});

test('requireStatsAuth(): トークンが無い・不正なら401', async () => {
  const { email, res } = await callRequireStatsAuth({ headers: { authorization: 'Bearer invalid' } });
  assert.equal(email, null);
  assert.equal(res.statusCode, 401);
});

test('requireStatsAuth(): STATS_SESSION_SECRET未設定なら、トークンの有効性を問わず500', async () => {
  const token = createStatsSessionToken(EMAIL);
  delete process.env.STATS_SESSION_SECRET;

  const { email, res } = await callRequireStatsAuth({ headers: { authorization: `Bearer ${token}` } });

  assert.equal(email, null);
  assert.equal(res.statusCode, 500);
});
