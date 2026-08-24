// tests/api/checkout.upgrade-proration-params.test.mjs
// アップグレード時の「サイクルリセット＋満額請求」方針(billing_cycle_anchor: 'now' +
// proration_behavior: 'none')が、プレビュー(get-upgrade-options)と確定(update-plan)の
// 両方に正しく渡っていることを固定する。
//
// 【ネストの深さが非対称なのは意図的】api/checkout.js冒頭のコメントにある通り、Stripeの
// invoices.createPreviewとsubscriptions.updateは、日割り関連パラメータの受け取り方が
// 非対称になっている。プレビュー側はsubscription_detailsオブジェクトの中、更新側は
// トップレベル。揃えて書き間違えると片方に効かず提示額と請求額がズレる、という
// 既知の地雷がbilling_cycle_anchor/proration_behaviorにも同様に当てはまるため、
// このテストではプレビュー側の2値がsubscription_details「の中」にあること「だけ」
// でなく、トップレベルには存在しない(ネスト位置を間違えて両方に置いていないか)ことも
// 確認する。Stripeは知らないパラメータを黙って無視するため、ネストの深さを間違えると
// 値そのものは正しく見えるのに実際には効かず、日割りが復活する。
//
// 【この2値が未検証だった経緯】8/23の実機確認で、アップグレードのプレビュー額が
// 日割りのように見える金額(スタンダード239円・プロ5739円)になっているのが見つかり、
// 「サイクルリセット＋満額請求の方針がコード上崩れているのでは」という疑いから
// 調査に入った。最終的な原因はStripeの顧客残高(−4,161円のクレジット)が請求書に
// 一律で差し引かれていただけで、コード側は方針どおりだったが、この2値を固定する
// テストが1件も無かったため、まず「コード側の疑い」を検討せざるを得ず、
// 切り分けに時間がかかった。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/checkout.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeAuth from '../support/fakes/auth.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { createUpgradeQuote } from '../../lib/upgradeQuote.js';

const EMAIL = 'tester@example.com';

beforeEach(() => {
  fakeStripe.__reset();
  fakeAuth.__reset();
  fakeAuth.__setAuth({ email: EMAIL });
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.STRIPE_COUPON_ID = 'coupon_test';
});

test("get-upgrade-options: invoices.createPreviewのsubscription_detailsにbilling_cycle_anchor: 'now'とproration_behavior: 'none'が渡り、トップレベルには無い", async () => {
  const capturedPreviewParams = [];
  // 元のdefaultPreview()の金額計算は使わない(この差し替えで失われる)。今回の主眼は
  // 引数の固定であり金額計算は既存のcheckout.get-upgrade-options.test.mjs側の
  // 責務のため、レスポンスは200を通すための最小限の固定値にする。
  fakeStripe.__setHandler('invoices.createPreview', async (params) => {
    capturedPreviewParams.push(params);
    return {
      amount_due: 1000,
      currency: 'jpy',
      total_discount_amounts: [],
      lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 } }] },
    };
  });

  const req = fakeReq({ action: 'get-upgrade-options' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  // light→standard/proの2候補ぶん、invoices.createPreviewが2回呼ばれるはず。
  assert.equal(capturedPreviewParams.length, 2, `invoices.createPreviewの呼び出し回数が想定と異なる(${capturedPreviewParams.length}回)`);

  for (const params of capturedPreviewParams) {
    assert.equal(
      params.subscription_details?.billing_cycle_anchor,
      'now',
      'subscription_details.billing_cycle_anchorが\'now\'ではない'
    );
    assert.equal(
      params.subscription_details?.proration_behavior,
      'none',
      'subscription_details.proration_behaviorが\'none\'ではない'
    );
    // ネストの深さを間違えて両方に置いていないか(トップレベルには無いこと)の確認。
    // Stripeは知らないパラメータを黙って無視するため、間違えて置いても一見動いて見える。
    assert.equal(params.billing_cycle_anchor, undefined, 'billing_cycle_anchorがトップレベルにも存在する(ネスト位置の誤り)');
    assert.equal(params.proration_behavior, undefined, 'proration_behaviorがトップレベルにも存在する(ネスト位置の誤り)');
  }
});

test("update-plan: subscriptions.updateのトップレベルにbilling_cycle_anchor: 'now'とproration_behavior: 'none'が渡る", async () => {
  const capturedUpdateParams = [];
  fakeStripe.__setHandler('subscriptions.update', async (subscriptionId, params) => {
    capturedUpdateParams.push(params);
    return {};
  });

  const quote = createUpgradeQuote({
    email: EMAIL,
    fromPriceId: 'price_light_test',
    toPriceId: 'price_standard_test',
    toPlan: 'standard',
    amountDue: 4400,
    currency: 'jpy',
    couponSent: false,
    couponApplied: false,
  });

  const req = fakeReq({ action: 'update-plan', quote });
  const res = fakeRes();
  await handler(req, res);

  // 最終的なレスポンス(200まで到達するか)は検証しない。stripe.subscriptions.update()の
  // 呼び出し時点でcapturedUpdateParamsへの記録は完了しており、この後getSubscriptionStateCached()・
  // readQuota()がフルにモックされていないため別の理由で失敗しうるが、それは今回の
  // 検証対象外(checkout.update-plan.test.mjsの「比較対照」テストと同じ考え方)。
  assert.equal(capturedUpdateParams.length, 1, `subscriptions.updateの呼び出し回数が想定と異なる(${capturedUpdateParams.length}回)`);

  const params = capturedUpdateParams[0];
  assert.equal(params.billing_cycle_anchor, 'now', "billing_cycle_anchorが'now'ではない");
  assert.equal(params.proration_behavior, 'none', "proration_behaviorが'none'ではない");
});
