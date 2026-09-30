// tests/api/auth.requireAuth.test.mjs
// api/_auth.js の requireAuth()/authenticate() 自体の回帰。
//
// checkout.js・api/cases/*.js は tests/support/loader.mjs で `./_auth`(`../_auth`)を
// フェイクへ差し替えているため、requireAuth()の実コード(セッション検証→
// getSubscriptionStateCached()経由のStripe再チェック)を実際のフェイクStripe相手に
// 検証できるのはこのファイルだけ。api/_auth.js自体はどの差し替えルールにも
// 該当しないため、ここでは本物を読み込む。
//
// 目的: 照明サーチのPrice ID環境変数(STRIPE_PRICE_ID_LIGHT/STANDARD/PRO、
// lib/subscription.jsのgetLightingSearchPriceIds())が1つでも欠けたとき、
// セッション再チェック(getSubscriptionStateCached())は既存のフェイルオープン
// 機構(Stripe障害時に一時的に有効とみなす)にそのまま乗ってログイン済みユーザーを
// 通すが、必ずconsole.errorでログに残ること(気づけることが目的)を固定する。

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { requireAuth } from '../../api/_auth.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';

const EMAIL = 'auth-test@example.com';
const SESSION_SECRET = 'test-session-secret';

// api/login.js の createSessionToken() と同じ組み立て方(exportされていないため複製)。
function makeToken(email, { expiresInMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const expiresAt = Date.now() + expiresInMs;
  const payload = `${email}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

function reqWithToken(token) {
  return fakeReq(undefined, { headers: { authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  delete process.env.ADMIN_EMAILS;
});

test('正常系: 照明サーチの契約者はrequireAuthが通る', async () => {
  const res = fakeRes();
  const email = await requireAuth(reqWithToken(makeToken(EMAIL)), res);

  assert.equal(email, EMAIL);
  assert.equal(res.statusCode, null);
});

test('Price ID環境変数が1つ欠けていても、セッション再チェックはフェイルオープンで通り、console.errorに残る', async () => {
  delete process.env.STRIPE_PRICE_ID_STANDARD; // 3つのうち1つを欠如させる

  const errorMock = mock.method(console, 'error', () => {});
  try {
    const res = fakeRes();
    const email = await requireAuth(reqWithToken(makeToken(EMAIL)), res);

    // フェイルオープン: ログイン済みセッションは通す(401/500を返さない)。
    assert.equal(email, EMAIL);
    assert.equal(res.statusCode, null);

    // 気づけることが目的: 必ずconsole.errorに残す。
    assert.ok(errorMock.mock.calls.length > 0, 'console.errorが呼ばれていません');
    const loggedMissingVar = errorMock.mock.calls.some((call) =>
      call.arguments.some((arg) => String(arg).includes('STRIPE_PRICE_ID_STANDARD'))
    );
    assert.ok(loggedMissingVar, '欠けている環境変数名がログに含まれていません');
  } finally {
    errorMock.mock.restore();
  }
});
