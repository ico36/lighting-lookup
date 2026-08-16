// tests/api/checkout.update-plan.test.mjs
// handleUpdatePlan（api/checkout.jsのaction:'update-plan'）の回帰。
// E-5で触るのは「quote.couponSent は true なのに、確定時にはクーポンを用意できない」
// 409(coupon_unavailable)分岐のみ（範囲は「変更範囲に絞った回帰」で合意済み）。
// この分岐は quote.couponSent のチェック直後、getActiveSubscriptionWithItem() や
// readQuota() に届く前に return するため、Stripeのサブスク取得・Redisは
// フェイクせずに検証できる。402支払い失敗系など他の分岐は対象外。
//
// この分岐自体は既存コード（api/checkout.js:396-406）で、isEarlyBirdCouponAvailable()
// の実装有無に関係なく今すでに動く。ここでのテストはE-5実装前から green のはずで、
// 「E-5導入後もこの安全弁を壊していない」ことを確認する回帰として使う。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/checkout.js';
import * as fakeAuth from '../support/fakes/auth.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { createUpgradeQuote } from '../../lib/upgradeQuote.js';

const EMAIL = 'tester@example.com';

beforeEach(() => {
  fakeAuth.__reset();
  fakeAuth.__setAuth({ email: EMAIL });
  process.env.SESSION_SECRET = 'test-session-secret';
});

test('couponSent: true な quote で確定時にクーポンが用意できない → 409 coupon_unavailable', async () => {
  // 見積り時点ではクーポンを渡せていた(couponSent: true)のに、確定時には
  // STRIPE_COUPON_ID が解決できない状況を再現する。
  delete process.env.STRIPE_COUPON_ID;

  const quote = createUpgradeQuote({
    email: EMAIL,
    fromPriceId: 'price_light_test',
    toPriceId: 'price_standard_test',
    toPlan: 'standard',
    amountDue: 4400,
    currency: 'jpy',
    couponSent: true,
    couponApplied: true,
  });

  const req = fakeReq({ action: 'update-plan', quote });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 409, `409を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'coupon_unavailable');
});

test('couponSent: false な quote は同じ状況でも通過する（比較対照）', async () => {
  // 上のテストが「couponSentを見ている」ことの対照実験。couponSent:falseなら
  // STRIPE_COUPON_ID の有無に関わらずこの409分岐には入らない
  // （このあとStripeのサブスク取得に進むため、フェイクStripeを用意していない
  // このテストでは別の理由で失敗するはずだが、409ではないことだけを見る）。
  delete process.env.STRIPE_COUPON_ID;

  const quote = createUpgradeQuote({
    email: EMAIL,
    fromPriceId: 'price_light_test',
    toPriceId: 'price_standard_test',
    toPlan: 'standard',
    amountDue: 8800,
    currency: 'jpy',
    couponSent: false,
    couponApplied: false,
  });

  const req = fakeReq({ action: 'update-plan', quote });
  const res = fakeRes();

  await handler(req, res);

  assert.notEqual(res.body?.error, 'coupon_unavailable');
});
