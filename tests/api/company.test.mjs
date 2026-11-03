// tests/api/company.test.mjs
// api/company.js のPOST(自社情報の保存)が、保存成功後にStripe顧客の
// customer.name にも社名を書き込むことを検証する。
//
// 【前提】requireAuthWithPlan()が返す{email, limits}はフェイク(tests/support/fakes/
// auth.mjs)へ差し替え済み(tests/support/loader.mjsにapi/company.js用のルールを追加)。
// company:{email}の読み書きもフェイクRedis(tests/support/fakes/redis.mjs)に差し替え
// 済みで、Stripeの契約解決(getActiveSubscriptionWithItem())はlib/subscription.jsの
// 本物のロジックをフェイクStripe(tests/support/fakes/stripe.mjs)の上で動かす
// (tests/lib/memberNo.test.mjsと同じ方式)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/company.js';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { __setAuth, __reset as __resetAuth } from '../support/fakes/auth.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';
import * as fakeStripe from '../support/fakes/stripe.mjs';

const EMAIL = 'company-tester@example.com';

beforeEach(() => {
  __resetFakeRedis();
  __resetAuth();
  fakeStripe.__reset();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  __setAuth({ email: EMAIL, limits: { plan: 'light', searchLimit: 20, caseLimit: 5, retentionDays: 30 } });
});

function validCompanyBody(overrides = {}) {
  return {
    name: '株式会社テスト工業',
    tel: '03-1234-5678',
    license: '東京都知事許可(般-6)第12345号',
    logoUrl: '',
    postalCode: '1234567',
    prefecture: '東京都',
    addressLine: '中央区1-1-1',
    ...overrides,
  };
}

// fakes/stripe.mjsの既定(customers.list→cus_test、subscriptions.list→
// price_light_testのactiveなサブスク1件)をそのまま使えば「照明サーチの有効な
// 契約者」の状態になる。KYノートのみ・契約なしのテストだけ個別に差し替える。

test('有効な照明サーチ契約者が社名を保存 → customers.updateが呼ばれ、nameが一致する', async () => {
  const req = fakeReq(validCompanyBody(), { method: 'POST' });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.company.name, '株式会社テスト工業');
  assert.ok(fakeStripe.__getCallLog().includes('customers.update'), 'customers.updateが呼ばれていない');
  assert.equal(fakeStripe.__peekCustomer('cus_test').name, '株式会社テスト工業');
});

test('管理者(limits.plan === "admin")は何もしない(customers.updateが呼ばれない)', async () => {
  __setAuth({ limits: { plan: 'admin', searchLimit: -1, caseLimit: -1, retentionDays: -1 } });

  const req = fakeReq(validCompanyBody(), { method: 'POST' });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(!fakeStripe.__getCallLog().includes('customers.update'), '管理者なのにcustomers.updateが呼ばれている');
  // 管理者はStripe顧客を持たないため、getActiveSubscriptionWithItem()自体も
  // 呼ばれない(不要なStripe往復を避ける設計)。customers.list/subscriptions.list
  // いずれも呼び出しログに出ないはず。
  assert.deepEqual(fakeStripe.__getCallLog(), [], '管理者なのにStripeへ問い合わせている');
});

test('KYノートのみの契約(照明サーチのPriceを含まない) → customers.updateが呼ばれない', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [
      {
        id: 'sub_kynote',
        customer: 'cus_test',
        status: 'active',
        items: { data: [{ id: 'si_kynote', price: { id: 'price_kynote_test' } }] },
      },
    ],
  }));

  const req = fakeReq(validCompanyBody(), { method: 'POST' });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(!fakeStripe.__getCallLog().includes('customers.update'), 'KYノートのみなのにcustomers.updateが呼ばれている');
});

test('Stripe顧客が見つからない(customerId無し) → customers.updateが呼ばれない', async () => {
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  const req = fakeReq(validCompanyBody(), { method: 'POST' });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(!fakeStripe.__getCallLog().includes('customers.update'));
});

test('customers.updateが失敗しても200を返し、自社情報(Redis)は保存されている', async () => {
  fakeStripe.__setHandler('customers.update', async () => {
    throw new Error('fake stripe error: customers.update failed');
  });

  const req = fakeReq(validCompanyBody(), { method: 'POST' });
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200, 'Stripeへの同期失敗が自社情報の保存結果に影響している');
  assert.equal(res.body.success, true);
  assert.equal(res.body.company.name, '株式会社テスト工業');

  const saved = await redis.get(redisKey('company', EMAIL));
  assert.equal(saved.name, '株式会社テスト工業', 'customers.update失敗時に自社情報(Redis)が保存されていない');
});
