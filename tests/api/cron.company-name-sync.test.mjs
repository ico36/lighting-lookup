// tests/api/cron.company-name-sync.test.mjs
// api/cron/process-cases.js ステップ4(会員番号の採番・保険)に相乗りした、
// 自社情報の社名(company:{email}.name)をStripe顧客のcustomer.nameへ同期する
// 保険ステップのテスト。
//
// 【会員番号ステップと同じcandidatesを使う】このステップは会員番号採番(保険)が
// 既に列挙した照明サーチの有効な契約者(candidates)をそのまま使い回すため、
// Stripeへの追加往復は発生しない設計(api/cron/process-cases.js参照)。そのため
// wireActiveSubscriptions()はtests/api/cron.member-no.test.mjsの同名ヘルパーと
// ほぼ同じ形だが、customer.nameも差し込めるようにした専用版をこのファイルに
// 用意する(member-no側のテストファイルには手を入れない)。

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cron/process-cases.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeBlob from '../support/fakes/blob.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';

const CRON_SECRET = 'test-cron-secret';
const REAL_FETCH = globalThis.fetch;

beforeEach(() => {
  fakeStripe.__reset();
  fakeBlob.__reset();
  __resetFakeRedis();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  process.env.RESEND_API_KEY = 'test-resend-api-key';
  process.env.MAIL_FROM = '照明サーチ <noreply@example.com>';
  delete process.env.VERCEL_ENV;
  // ステップ5のウェルカムメール送信保険(lib/welcomeEmail.js)がResendへ実際に
  // 問い合わせないよう、globalThis.fetchをスタブする(このファイルの主題ではないが、
  // 候補として有効なサブスクを作る以上必ず経由するため)。
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'email_test' }) });
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function callCron() {
  const req = fakeReq(undefined, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

/**
 * @param {Array<{id: string, customerId: string, email: string, startDateSec?: number,
 *   priceId?: string, name?: string}>} entries
 */
function wireActiveSubscriptions(entries) {
  const byPrice = {};
  const emailToCustomerId = {};
  const nowSec = Math.floor(Date.now() / 1000);

  for (const e of entries) {
    const priceId = e.priceId || 'price_standard_test';
    const sub = {
      id: e.id,
      customer: { id: e.customerId, email: e.email, name: e.name ?? null, metadata: {} },
      status: 'active',
      start_date: e.startDateSec ?? nowSec,
      items: { data: [{ id: `si_${e.id}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
    };
    (byPrice[priceId] ||= []).push(sub);
    emailToCustomerId[e.email] = e.customerId;
  }

  fakeStripe.__setHandler('customers.list', async (params) => {
    const customerId = emailToCustomerId[params.email];
    return { data: customerId ? [{ id: customerId }] : [] };
  });

  // tests/api/cron.member-no.test.mjsのwireActiveSubscriptions()と同じ絞り込み方
  // (price指定/customer指定の両方に対応する。詳細はそちらのコメント参照)。
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.price) {
      const list = byPrice[params.price] || [];
      return { data: params.status ? list.filter((s) => s.status === params.status) : list };
    }
    if (params.customer) {
      const all = Object.values(byPrice).flat();
      return {
        data: all.filter((sub) => {
          const cid = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
          return cid === params.customer;
        }),
      };
    }
    return { data: [] };
  });
}

async function seedCompany(email, company) {
  await redis.set(redisKey('company', email), company);
}

// customers.update()は会員番号の採番(保険、{metadata: {...}}を送る)と自社情報の
// 社名同期(保険、{name: ...}を送る)の両方から呼ばれるため、fakeStripe.__getCallLog()
// (メソッド名の配列だけで引数を持たない)だけでは「社名同期のための呼び出しか」を
// 区別できない。paramsに`name`キーがあるかどうかで、社名同期の呼び出しだけを
// 記録する専用の差し替えをここで用意する。
function wireNameUpdateRecorder({ failForCustomerId } = {}) {
  const nameUpdateCalls = [];
  fakeStripe.__setHandler('customers.update', async (id, params) => {
    if (params && Object.prototype.hasOwnProperty.call(params, 'name')) {
      nameUpdateCalls.push({ id, name: params.name });
      if (failForCustomerId && id === failForCustomerId) {
        throw new Error(`fake stripe error: customers.update failed for ${id}`);
      }
    }
    const existing = fakeStripe.__peekCustomer(id) || { id, email: `${id}@example.com`, metadata: {} };
    const updated = { ...existing, ...params, metadata: { ...existing.metadata, ...(params?.metadata || {}) } };
    fakeStripe.__seedCustomer(id, updated);
    return updated;
  });
  return nameUpdateCalls;
}

test('社名とStripeの顧客名が違えば書き込む', async () => {
  wireActiveSubscriptions([
    { id: 'sub_a', customerId: 'cus_a', email: 'a@example.com', name: '旧社名株式会社' },
  ]);
  await seedCompany('a@example.com', { name: '新社名株式会社' });
  const nameUpdateCalls = wireNameUpdateRecorder();

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.companyNameSync.checked, 1);
  assert.equal(res.body.companyNameSync.synced, 1);
  assert.deepEqual(res.body.companyNameSync.errors, []);
  assert.deepEqual(nameUpdateCalls, [{ id: 'cus_a', name: '新社名株式会社' }]);
  assert.equal(fakeStripe.__peekCustomer('cus_a').name, '新社名株式会社');
});

test('社名とStripeの顧客名が同じなら書き込まない(2回目以降は何もしない状態になる)', async () => {
  wireActiveSubscriptions([
    { id: 'sub_b', customerId: 'cus_b', email: 'b@example.com', name: '同じ社名株式会社' },
  ]);
  await seedCompany('b@example.com', { name: '同じ社名株式会社' });
  const nameUpdateCalls = wireNameUpdateRecorder();

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.companyNameSync.checked, 1);
  assert.equal(res.body.companyNameSync.synced, 0);
  assert.deepEqual(nameUpdateCalls, [], '同じ社名なのに社名の書き込みが呼ばれている');
});

test('自社情報(company:{email})が無ければ書き込まない', async () => {
  wireActiveSubscriptions([
    { id: 'sub_c', customerId: 'cus_c', email: 'c@example.com', name: null },
  ]);
  // seedCompany()を呼ばない = company:{email}が存在しない状態
  const nameUpdateCalls = wireNameUpdateRecorder();

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.companyNameSync.checked, 1);
  assert.equal(res.body.companyNameSync.synced, 0);
  assert.deepEqual(nameUpdateCalls, []);
});

test('書き込み(customers.update)が失敗しても、他の契約者の処理・会員番号の採番は続く', async () => {
  const now = Math.floor(Date.now() / 1000);
  wireActiveSubscriptions([
    { id: 'sub_d1', customerId: 'cus_d1', email: 'd1@example.com', name: '旧社名1', startDateSec: now - 10 },
    { id: 'sub_d2', customerId: 'cus_d2', email: 'd2@example.com', name: '旧社名2', startDateSec: now - 5 },
  ]);
  await seedCompany('d1@example.com', { name: '新社名1' });
  await seedCompany('d2@example.com', { name: '新社名2' });
  // cus_d1への社名書き込みだけ失敗させる。会員番号の採番(cus_d1への
  // metadata更新)は別のparams({metadata: {...}}、nameキーを持たない)で
  // 呼ばれるため、wireNameUpdateRecorder()のfailForCustomerIdはそちらを
  // 巻き込まない。
  const nameUpdateCalls = wireNameUpdateRecorder({ failForCustomerId: 'cus_d1' });

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // d1は自社情報の同期に失敗しているが、エラーとして記録されるだけでcronは継続する
  assert.equal(res.body.companyNameSync.checked, 2);
  assert.equal(res.body.companyNameSync.synced, 1, 'd2の同期(成功するはず)が反映されていない');
  assert.equal(res.body.companyNameSync.errors.length, 1);
  assert.equal(res.body.companyNameSync.errors[0].email, 'd1@example.com');
  assert.deepEqual(
    nameUpdateCalls.map((c) => c.id),
    ['cus_d1', 'cus_d2'],
    '両方の社名書き込みが試みられていない'
  );

  // d2は正常に同期されている
  assert.equal(fakeStripe.__peekCustomer('cus_d2').name, '新社名2');

  // 会員番号の採番(保険)はd1の自社情報同期の失敗に関わらず両方とも処理される
  assert.equal(res.body.memberNo.checked, 2, 'd1の自社情報同期失敗で会員番号の処理まで止まっている');
  assert.deepEqual(res.body.memberNo.errors, []);
});
