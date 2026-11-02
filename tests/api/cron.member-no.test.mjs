// tests/api/cron.member-no.test.mjs
// api/cron/process-cases.js ステップ4(会員番号の採番・保険)のテスト。
// Webhook/ログイン時フォールバックが両方届かなかった場合の保険として、照明サーチの
// 3PriceのアクティブなサブスクをStart_date昇順で走査し、未採番のものだけ発番する
// 挙動を、既存のcron系テストと同じフェイク(fakeStripe・フェイクRedis)で検証する。
//
// 【customers.list/subscriptions.listの差し替えについて】assignMemberNoIfMissing()が
// 内部で呼ぶgetActiveSubscriptionWithItem()(customer: 絞り込みのsubscriptions.list)と、
// このステップ自体が呼ぶ候補列挙(price: 絞り込みのsubscriptions.list)は同じフェイクの
// メソッドを共有するため、wireActiveSubscriptions()で両方の呼び方(price指定/customer指定)
// に同じ元データから一貫した結果を返すようにしている。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cron/process-cases.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeBlob from '../support/fakes/blob.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';

const CRON_SECRET = 'test-cron-secret';

beforeEach(() => {
  fakeStripe.__reset();
  fakeBlob.__reset();
  __resetFakeRedis();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
  delete process.env.VERCEL_ENV;
  // 会員番号の対象データが無い既定状態では、ステップ3(owner-deletion)はcompany:*/tos:*が
  // 空なのでStripeへ問い合わせない。customers.list/subscriptions.listは
  // wireActiveSubscriptions()で都度上書きする。
});

async function callCron() {
  const req = fakeReq(undefined, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

/**
 * @param {Array<{id: string, customerId: string, email: string, startDateSec: number,
 *   priceId?: string, customerAsObject?: boolean}>} entries
 */
function wireActiveSubscriptions(entries) {
  const byPrice = {};
  const emailToCustomerId = {};

  for (const e of entries) {
    const priceId = e.priceId || 'price_standard_test';
    const customerAsObject = e.customerAsObject !== false;
    const sub = {
      id: e.id,
      customer: customerAsObject ? { id: e.customerId, email: e.email } : e.customerId,
      status: 'active',
      start_date: e.startDateSec,
      items: { data: [{ id: `si_${e.id}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
    };
    (byPrice[priceId] ||= []).push(sub);
    if (e.email) emailToCustomerId[e.email] = e.customerId;
  }

  fakeStripe.__setHandler('customers.list', async (params) => {
    const customerId = emailToCustomerId[params.email];
    return { data: customerId ? [{ id: customerId }] : [] };
  });

  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.price) return { data: byPrice[params.price] || [] };
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

test('対象のサブスクが無ければ何も採番せず、エラーも出ない', async () => {
  wireActiveSubscriptions([]);

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.memberNo.checked, 0);
  assert.deepEqual(res.body.memberNo.errors, []);
});

test('start_date昇順で採番する(Priceが別でも申し込み順が優先される)', async () => {
  const now = Math.floor(Date.now() / 1000);
  wireActiveSubscriptions([
    { id: 'sub_later', customerId: 'cus_later', email: 'later@example.com', startDateSec: now - 10, priceId: 'price_light_test' },
    { id: 'sub_earlier', customerId: 'cus_earlier', email: 'earlier@example.com', startDateSec: now - 1000, priceId: 'price_standard_test' },
  ]);

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.memberNo.checked, 2);
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', 'earlier@example.com')), '1');
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', 'later@example.com')), '2');
});

test('customerがexpandされず文字列のままでも、customers.retrieve()でemailを解決して採番する', async () => {
  const now = Math.floor(Date.now() / 1000);
  wireActiveSubscriptions([
    { id: 'sub_x', customerId: 'cus_x', email: 'string-customer@example.com', startDateSec: now, customerAsObject: false },
  ]);
  fakeStripe.__setHandler('customers.retrieve', async (id) => ({ id, email: 'string-customer@example.com', metadata: {} }));

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.memberNo.checked, 1);
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', 'string-customer@example.com')), '1');
});

test('既に採番済みの顧客は番号を変えない(冪等)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const email = 'already@example.com';
  await redis.set(redisKey('ls_member_no', 'by_email', email), '5');
  wireActiveSubscriptions([
    { id: 'sub_already', customerId: 'cus_already', email, startDateSec: now },
  ]);

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '5');
});

test('同じ顧客が複数Priceにまたがって出てきても1回しか処理しない', async () => {
  const now = Math.floor(Date.now() / 1000);
  wireActiveSubscriptions([
    { id: 'sub_dup_1', customerId: 'cus_dup', email: 'dup@example.com', startDateSec: now, priceId: 'price_light_test' },
    { id: 'sub_dup_2', customerId: 'cus_dup', email: 'dup@example.com', startDateSec: now, priceId: 'price_standard_test' },
  ]);

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.memberNo.checked, 1);
});
