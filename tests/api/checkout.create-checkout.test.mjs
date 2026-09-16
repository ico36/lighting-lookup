// tests/api/checkout.create-checkout.test.mjs
// 新規申し込み導線(api/checkout.jsのaction:'create-checkout'/'get-signup-plans')の回帰。
// 対象はプランのホワイトリスト検証、クーポンのプラン別ゲート、既存顧客の解決、
// 二重契約防止、ADMIN_EMAILSロックのVERCEL_ENV分岐に絞る(範囲は合意済み)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/checkout.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';

function parseSessionParams(url) {
  const query = new URL(url).searchParams;
  return JSON.parse(query.get('params'));
}

beforeEach(() => {
  fakeStripe.__reset();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.STRIPE_COUPON_ID = 'coupon_test';
  delete process.env.VERCEL_ENV;
  delete process.env.ADMIN_EMAILS;
});

async function callCreateCheckout(body) {
  const req = fakeReq({ action: 'create-checkout', email: 'new-user@example.com', plan: 'light', ...body });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

// customers.list を「該当メールの顧客なし」に固定するヘルパー。
// 既定(fakes/stripe.mjs)は常に cus_test を返すため、新規申し込みのテストでは
// 明示的に上書きしないと「既存顧客あり」経路に紛れ込む。
function noExistingCustomer() {
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));
}

test('plan のホワイトリスト検証: light/standard/pro以外は400 invalid_plan で、Stripeへ問い合わせない', async () => {
  noExistingCustomer();
  const res = await callCreateCheckout({ plan: 'enterprise' });

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_plan');
  assert.ok(!fakeStripe.__getCallLog().includes('customers.list'));
});

test('light プラン: 早期割引が利用可能でもクーポンを付けない', async () => {
  noExistingCustomer();
  // beforeEach 後の既定クーポンは valid:true / times_redeemed:3 / max_redemptions:10 → available:true
  const res = await callCreateCheckout({ plan: 'light' });

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const params = parseSessionParams(res.body.url);
  assert.equal(params.discounts, undefined);
  // ライトはクーポン対象外の方針なので、coupons.retrieve 自体を呼ぶ必要が無い
  assert.ok(!fakeStripe.__getCallLog().includes('coupons.retrieve'));
});

test('standard プラン: 早期割引の枠切れならクーポンを付けない', async () => {
  noExistingCustomer();
  fakeStripe.__setHandler('coupons.retrieve', async () => ({
    valid: true,
    percent_off: 50,
    duration_in_months: 6,
    max_redemptions: 10,
    times_redeemed: 10, // 枠切れ
  }));

  const res = await callCreateCheckout({ plan: 'standard' });

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const params = parseSessionParams(res.body.url);
  assert.equal(params.discounts, undefined);
});

test('standard プラン: 早期割引が利用可能ならクーポンを付ける', async () => {
  noExistingCustomer();
  const res = await callCreateCheckout({ plan: 'standard' });

  assert.equal(res.statusCode, 200);
  const params = parseSessionParams(res.body.url);
  assert.deepEqual(params.discounts, [{ coupon: 'coupon_test' }]);
});

test('既存顧客が見つかる場合は customer を渡し、customer_email は渡さない', async () => {
  fakeStripe.__setHandler('customers.list', async () => ({ data: [{ id: 'cus_existing' }] }));
  fakeStripe.__setHandler('subscriptions.list', async () => ({ data: [] })); // 有効な契約は無し

  const res = await callCreateCheckout({ plan: 'light' });

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const params = parseSessionParams(res.body.url);
  assert.equal(params.customer, 'cus_existing');
  assert.equal(params.customer_email, undefined);
});

test('既存顧客が見つからない場合は customer_email を渡す（新規Customerを作らせる）', async () => {
  noExistingCustomer();

  const res = await callCreateCheckout({ plan: 'light' });

  assert.equal(res.statusCode, 200);
  const params = parseSessionParams(res.body.url);
  assert.equal(params.customer_email, 'new-user@example.com');
  assert.equal(params.customer, undefined);
  // 顧客が無い時点で有効な契約もあり得ないので、subscriptions.list を呼ぶ必要が無い
  assert.ok(!fakeStripe.__getCallLog().includes('subscriptions.list'));
});

test('既存顧客に有効なサブスクがある場合はCheckoutを作らず409', async () => {
  // 既定(fakes/stripe.mjs)の customers.list / subscriptions.list がそのまま
  // 「顧客あり・有効なサブスクあり」を返す
  const res = await callCreateCheckout({ plan: 'standard' });

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'already_subscribed');
  assert.ok(!fakeStripe.__getCallLog().includes('checkout.sessions.create'));
});

test('本番ロック: VERCEL_ENV=production かつ管理者以外は403', async () => {
  process.env.VERCEL_ENV = 'production';
  noExistingCustomer();

  const res = await callCreateCheckout({ plan: 'light' });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'signup_locked');
  assert.ok(!fakeStripe.__getCallLog().includes('customers.list'));
});

test('本番ロック: VERCEL_ENV=production でも管理者アドレスなら通す', async () => {
  process.env.VERCEL_ENV = 'production';
  process.env.ADMIN_EMAILS = 'new-user@example.com';
  noExistingCustomer();

  const res = await callCreateCheckout({ plan: 'light' });

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('本番ロックはVERCEL_ENVがproduction以外(Preview/未定義)のときは効かない', async () => {
  process.env.VERCEL_ENV = 'preview';
  noExistingCustomer();

  const res = await callCreateCheckout({ plan: 'light' });

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
});

test('配線確認: get-signup-plans はライトのcouponEligibleがfalse、standard/proはクーポン状態に従う', async () => {
  const req = fakeReq({ action: 'get-signup-plans' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.signupLocked, false);
  assert.deepEqual(res.body.plans.map((p) => p.plan), ['light', 'standard', 'pro']);

  const light = res.body.plans.find((p) => p.plan === 'light');
  const standard = res.body.plans.find((p) => p.plan === 'standard');
  assert.equal(light.couponEligible, false);
  assert.equal(standard.couponEligible, true); // 既定のfakeクーポンはavailable:true
});

test('get-signup-plans: VERCEL_ENV=production ではsignupLocked:trueを返し、pricesを取得しない', async () => {
  process.env.VERCEL_ENV = 'production';

  const req = fakeReq({ action: 'get-signup-plans' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.signupLocked, true);
  assert.deepEqual(res.body.plans, []);
  assert.ok(!fakeStripe.__getCallLog().includes('prices.retrieve'));
  assert.ok(!fakeStripe.__getCallLog().includes('coupons.retrieve'));
});

test('get-signup-plans: VERCEL_ENVがproduction以外(Preview/未定義)ではsignupLocked:false', async () => {
  process.env.VERCEL_ENV = 'preview';

  const req = fakeReq({ action: 'get-signup-plans' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, `200を期待したが実際は ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.signupLocked, false);
  assert.deepEqual(res.body.plans.map((p) => p.plan), ['light', 'standard', 'pro']);
});
