// tests/api/cron.member-no.test.mjs
// api/cron/process-cases.js ステップ4(会員番号の採番・保険)のテスト。
// Webhook/ログイン時フォールバックが両方届かなかった場合の保険として、照明サーチの
// 3Price×LIVE_STATUSES(active/trialing)の有効なサブスクをStart_date昇順で走査し、
// 未採番またはStripe写しとずれているものだけ発番・修復する挙動を、既存のcron系
// テストと同じフェイク(fakeStripe・フェイクRedis)で検証する。
//
// 【customers.list/subscriptions.listの差し替えについて】assignMemberNoIfMissing()が
// 内部で呼ぶgetActiveSubscriptionWithItem()(customer: 絞り込みのsubscriptions.list)と、
// このステップ自体が呼ぶ候補列挙(price: 絞り込みのsubscriptions.list)は同じフェイクの
// メソッドを共有するため、wireActiveSubscriptions()で両方の呼び方(price指定/customer指定)
// に同じ元データから一貫した結果を返すようにしている。
//
// 【ページング】フェイクのsubscriptions.list().autoPagingToArray()は、本物のStripe
// SDKのようにページを分けず、handlerの戻り値(.data)をそのまま返すだけ
// (tests/support/fakes/stripe.mjs参照)。100件超の実ページングはフェイクでは
// 再現しないが、production側がautoPagingToArray()を正しく呼んでいることは、
// 下の全テストが(このメソッド経由でなければ候補が1件も取れず全滅するため)
// 間接的に検証している。

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
 *   priceId?: string, customerAsObject?: boolean, status?: string, metadata?: object}>} entries
 */
function wireActiveSubscriptions(entries) {
  const byPrice = {};
  const emailToCustomerId = {};

  for (const e of entries) {
    const priceId = e.priceId || 'price_standard_test';
    const customerAsObject = e.customerAsObject !== false;
    const status = e.status || 'active';
    const sub = {
      id: e.id,
      customer: customerAsObject ? { id: e.customerId, email: e.email, metadata: e.metadata || {} } : e.customerId,
      status,
      start_date: e.startDateSec,
      items: { data: [{ id: `si_${e.id}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
    };
    (byPrice[priceId] ||= []).push(sub);
    if (e.email) emailToCustomerId[e.email] = e.customerId;
    if (e.metadata) fakeStripe.__seedCustomer(e.customerId, { email: e.email, metadata: e.metadata });
  }

  fakeStripe.__setHandler('customers.list', async (params) => {
    const customerId = emailToCustomerId[params.email];
    return { data: customerId ? [{ id: customerId }] : [] };
  });

  // price指定(このステップ自体の候補列挙): statusも絞り込む(LIVE_STATUSESの
  // 各値で別々に問い合わせてくるため、ここで絞らないと同じ実体が重複して
  // 候補に入ってしまう)。
  // customer指定(assignMemberNoIfMissing内部のgetActiveSubscriptionWithItem):
  // status:'all'で来るため絞り込まない。
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

test('trialingのサブスクも候補になる(LIVE_STATUSESに合わせる)', async () => {
  const now = Math.floor(Date.now() / 1000);
  wireActiveSubscriptions([
    { id: 'sub_trial', customerId: 'cus_trial', email: 'trial@example.com', startDateSec: now, status: 'trialing' },
  ]);

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.memberNo.checked, 1);
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', 'trial@example.com')), '1');
});

test('RedisとStripe写しの両方に番号があり一致していれば、assignMemberNoIfMissing()のStripe往復をスキップする', async () => {
  const now = Math.floor(Date.now() / 1000);
  const email = 'synced@example.com';
  await redis.set(redisKey('ls_member_no', 'by_email', email), '42');
  wireActiveSubscriptions([
    { id: 'sub_synced', customerId: 'cus_synced', email, startDateSec: now, metadata: { ls_member_no: '42' } },
  ]);

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.memberNo.checked, 1);
  const calls = fakeStripe.__getCallLog();
  assert.ok(!calls.includes('customers.retrieve'), 'customers.retrieveが呼ばれている(スキップできていない)');
  assert.ok(!calls.includes('customers.update'), 'customers.updateが呼ばれている(スキップできていない)');
});

test('RedisとStripe写しが食い違っていれば、assignMemberNoIfMissing()を呼んでStripe側を書き直す', async () => {
  const now = Math.floor(Date.now() / 1000);
  const email = 'drifted@example.com';
  await redis.set(redisKey('ls_member_no', 'by_email', email), '7');
  wireActiveSubscriptions([
    // Stripe側の写しが古い値のまま(手動編集・過去の失敗等を想定)
    { id: 'sub_drift', customerId: 'cus_drift', email, startDateSec: now, metadata: { ls_member_no: '999' } },
  ]);

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fakeStripe.__peekCustomer('cus_drift').metadata.ls_member_no, '7', 'Redisの値(正)でStripe側が書き直されること');
});
