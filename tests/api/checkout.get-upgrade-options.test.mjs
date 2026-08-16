// tests/api/checkout.get-upgrade-options.test.mjs
// handleGetUpgradeOptions（api/checkout.jsのaction:'get-upgrade-options'）の回帰。
// E-5で触る経路（fetchCouponState()の可否・couponSentの流れ・並列性）に絞る。
// 402支払い失敗系などは対象外（範囲は「変更範囲に絞った回帰」で合意済み）。
//
// STRIPE_COUPON_ID未設定・coupons.retrieve失敗（フェイルオープン）の2件は、
// isEarlyBirdCouponAvailable()自体の対象外（呼び出し側 fetchCouponState() の
// 責務）なのでここに置く。純粋な判定分岐（valid:false・枠切れ）は
// tests/lib/isEarlyBirdCouponAvailable.test.mjs 側。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/checkout.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeAuth from '../support/fakes/auth.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { verifyUpgradeQuote } from '../../lib/upgradeQuote.js';

const EMAIL = 'tester@example.com';

beforeEach(() => {
  fakeStripe.__reset();
  fakeAuth.__reset();
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.STRIPE_COUPON_ID = 'coupon_test';
});

async function callGetUpgradeOptions() {
  const req = fakeReq({ action: 'get-upgrade-options' });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

test('配線確認: フェイクauth(light)経由でstandard/proの候補が返る', async () => {
  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.currentPlan, 'light');
  assert.equal(res.body.contactOnly, false);
  assert.deepEqual(res.body.options.map((o) => o.plan), ['standard', 'pro']);
});

test('クーポン利用可能（正常系）: discountsが適用され、quoteのcouponSentもtrue', async () => {
  // beforeEach の既定（fakeStripe.__reset() 後のdefault coupon）は
  // valid: true / times_redeemed: 3 / max_redemptions: 10 なので available:true。
  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200);
  const standard = res.body.options.find((o) => o.plan === 'standard');
  assert.equal(standard.couponApplied, true);

  const verified = verifyUpgradeQuote(standard.quote, EMAIL);
  assert.equal(verified.ok, true);
  assert.equal(verified.quote.couponSent, true);
});

test('STRIPE_COUPON_ID 未設定 → available:false相当。discounts無し・couponSent:falseで確定額と一致', async () => {
  delete process.env.STRIPE_COUPON_ID;

  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200);
  // 確認ステップの表示情報も出ない（早期割引の存在に一切触れない）
  assert.deepEqual(res.body.coupon, { percentOff: null, durationInMonths: null });

  const standard = res.body.options.find((o) => o.plan === 'standard');
  assert.equal(standard.couponApplied, false);
  // coupons.retrieve すら呼ばれていないこと（未設定なら即return、往復を増やさない）
  assert.ok(!fakeStripe.__getCallLog().includes('coupons.retrieve'));

  const verified = verifyUpgradeQuote(standard.quote, EMAIL);
  assert.equal(verified.ok, true);
  assert.equal(verified.quote.couponSent, false);
});

test('coupons.retrieve が例外を投げる → フェイルオープンでdiscountsは適用されたまま', async () => {
  fakeStripe.__setHandler('coupons.retrieve', async () => {
    throw new Error('fake: Stripe一時障害');
  });

  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  // 障害で取得できなかったので表示文言は出せない（percentOff/durationInMonthsはnull）が、
  // 適用自体（available）はフェイルオープンでtrueのまま。
  assert.deepEqual(res.body.coupon, { percentOff: null, durationInMonths: null });

  const standard = res.body.options.find((o) => o.plan === 'standard');
  assert.equal(standard.couponApplied, true);

  const verified = verifyUpgradeQuote(standard.quote, EMAIL);
  assert.equal(verified.ok, true);
  assert.equal(verified.quote.couponSent, true);
});

test('並列性: 対象プラン(light→standard/pro)の候補間・候補内が直列化していない', async () => {
  const res = await callGetUpgradeOptions();

  assert.equal(res.statusCode, 200);
  const maxConcurrent = fakeStripe.__getMaxConcurrent();
  console.log('[measured] maxConcurrent =', maxConcurrent);
  console.log('[measured] callLog =', fakeStripe.__getCallLog());

  // 実測値(工程E-5導入後): 4。
  //   customers.list → subscriptions.list（getActiveSubscriptionWithItem、直列）
  //   → currentPricePromise(prices.retrieve) と fetchCouponState()の
  //     coupons.retrieve が並行（最大2、currentPricePromiseが先に発火するため
  //     couponState待ちの間に解決し切ってしまい、後続の波と重ならない）
  //   → 対象2プラン(standard/pro)×(prices.retrieve + createPreview)の4本が並行（最大4）
  // 「>= 4」を閾値にする。候補間だけ直列化すると2、候補内まで直列化すると1に
  // 下がるので、いずれの後退も検出できる（このリポジトリで過去に「並列性のテストが
  // 並列を検出できていなかった」問題を踏んでいるため、下限を明示的に固定する）。
  assert.ok(
    maxConcurrent >= 4,
    `並列実行が後退している疑いがあります。期待: 4以上, 実測: ${maxConcurrent}`
  );
});
