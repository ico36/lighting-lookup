// tests/lib/isEarlyBirdCouponAvailable.test.mjs
// lib/subscription.js の isEarlyBirdCouponAvailable(coupon) の分岐網羅。
//
// 【設計】この関数は純粋な判定のみで、Stripeへの問い合わせは行わない。呼び出し側
// （api/checkout.js の fetchCouponState()）が既に取得済みの coupon オブジェクトを
// 引数で受け取るだけなので、ここではStripeのフェイクは一切使わずプレーンな
// オブジェクトを渡して確認する。
//
// 【未設定・障害時のテストはここに無い】STRIPE_COUPON_ID未設定・retrieve失敗
// （Stripe障害でのフェイルオープン）は「取得できたかどうか」の話で、この純粋関数の
// 対象外（呼び出し側 fetchCouponState() の責務）。この2件は
// tests/api/checkout.get-upgrade-options.test.mjs 側に置く。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEarlyBirdCouponAvailable } from '../../lib/subscription.js';

test('valid: false → false', () => {
  const available = isEarlyBirdCouponAvailable({
    valid: false,
    max_redemptions: 10,
    times_redeemed: 3,
  });
  assert.equal(available, false);
});

test('times_redeemed が max_redemptions 以上 → false（枠切れ）', () => {
  const available = isEarlyBirdCouponAvailable({
    valid: true,
    max_redemptions: 10,
    times_redeemed: 10,
  });
  assert.equal(available, false);
});

test('正常系: valid かつ枠に余裕がある → true', () => {
  const available = isEarlyBirdCouponAvailable({
    valid: true,
    max_redemptions: 10,
    times_redeemed: 3,
  });
  assert.equal(available, true);
});

test('正常系: max_redemptions が無い（無制限クーポン）→ true', () => {
  const available = isEarlyBirdCouponAvailable({
    valid: true,
    max_redemptions: null,
    times_redeemed: 9999,
  });
  assert.equal(available, true);
});
