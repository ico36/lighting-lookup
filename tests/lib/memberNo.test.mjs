// tests/lib/memberNo.test.mjs
// lib/memberNo.js の formatMemberNo()・assignMemberNoIfMissing() の単体テスト。
// Stripe/Redisはフェイク(tests/support/fakes/*.mjs)を使い、実ネットワークに出さない。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { formatMemberNo, assignMemberNoIfMissing, hasMemberNo } from '../../lib/memberNo.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
});

// getActiveSubscriptionWithItem()が要求する形(customers.list→subscriptions.list)に
// 合わせて、メールアドレスごとに決まったcustomerIdを返すように差し替える。
// 既定のfakeStripeはemailを無視して常に同じcus_testを返すため、複数メールを
// 扱うテスト(採番順の確認など)ではこちらで上書きする。
function wireCustomer(email, { customerId = `cus_${email}`, priceId = 'price_standard_test', status = 'active' } = {}) {
  fakeStripe.__setHandler('customers.list', async (params) => {
    if (params.email !== email) return { data: [] };
    return { data: [{ id: customerId }] };
  });
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.customer !== customerId) return { data: [] };
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      data: [{
        id: `sub_${customerId}`,
        customer: customerId,
        status,
        start_date: nowSec,
        items: { data: [{ id: `si_${customerId}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
      }],
    };
  });
  return customerId;
}

function wireNoSubscription() {
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));
}

test('formatMemberNo(): 正の整数をLS-000001形式に整形する', () => {
  assert.equal(formatMemberNo(1), 'LS-000001');
  assert.equal(formatMemberNo('42'), 'LS-000042');
  assert.equal(formatMemberNo(1000000), 'LS-1000000');
});

test('formatMemberNo(): 不正な値はnullを返す', () => {
  assert.equal(formatMemberNo(0), null);
  assert.equal(formatMemberNo(-1), null);
  assert.equal(formatMemberNo(null), null);
  assert.equal(formatMemberNo(undefined), null);
  assert.equal(formatMemberNo('abc'), null);
});

test('照明サーチの有効な契約が無ければ何もしない(KYノートのみ/未契約/解約済みを含む)', async () => {
  const email = 'no-sub@example.com';
  wireNoSubscription();

  const result = await assignMemberNoIfMissing(email);

  assert.equal(result, null);
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), null);
});

test('新規契約者に1から発番し、Redis・Stripeの両方に書き込む', async () => {
  const email = 'first@example.com';
  const customerId = wireCustomer(email);

  const result = await assignMemberNoIfMissing(email);

  assert.equal(result, '1');
  assert.equal(formatMemberNo(result), 'LS-000001');
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '1');
  assert.equal(fakeStripe.__peekCustomer(customerId).metadata.ls_member_no, '1');
});

test('2人目は2番になる(カウンターが引き継がれる)', async () => {
  const emailA = 'a@example.com';
  const emailB = 'b@example.com';

  wireCustomer(emailA);
  assert.equal(await assignMemberNoIfMissing(emailA), '1');

  wireCustomer(emailB);
  assert.equal(await assignMemberNoIfMissing(emailB), '2');
});

test('既に採番済みなら再度呼んでも同じ番号のまま、カウンターは増えない', async () => {
  const email = 'already@example.com';
  wireCustomer(email);

  const first = await assignMemberNoIfMissing(email);
  const second = await assignMemberNoIfMissing(email);

  assert.equal(first, '1');
  assert.equal(second, '1');
  assert.equal(await redis.get(redisKey('ls_member_no', 'counter')), 1);
});

test('Redisに番号が無くてもStripe側に写しが残っていれば、それを使ってRedisへ書き戻す(新規INCRしない)', async () => {
  const email = 'stripe-copy@example.com';
  const customerId = wireCustomer(email);
  fakeStripe.__seedCustomer(customerId, { metadata: { ls_member_no: '7' } });

  const result = await assignMemberNoIfMissing(email);

  assert.equal(result, '7');
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), '7');
  // 新規INCRが走っていないこと(カウンターキー自体が未作成のまま)
  assert.equal(await redis.get(redisKey('ls_member_no', 'counter')), null);
});

test('同じメールの処理が既に進行中(ロック中)なら何もせずnullを返す', async () => {
  const email = 'locked@example.com';
  wireCustomer(email);

  // 他の呼び出し(Webhook等)が既にロックを取得している状況を模す
  await redis.set(redisKey('ls_member_no', 'lock', email), '1', { nx: true, ex: 30 });

  const result = await assignMemberNoIfMissing(email);

  assert.equal(result, null);
  assert.equal(await redis.get(redisKey('ls_member_no', 'by_email', email)), null);
});

test('hasMemberNo(): 未採番ならfalse、採番後はtrueを返す。Stripeへは一切問い合わせない', async () => {
  const email = 'has-check@example.com';
  wireCustomer(email);

  assert.equal(await hasMemberNo(email), false);
  assert.deepEqual(fakeStripe.__getCallLog(), [], 'hasMemberNo()自体はStripeを呼ばないはず');

  await assignMemberNoIfMissing(email);
  fakeStripe.__reset(); // assignMemberNoIfMissing()分の呼び出しログをクリアしてから確認する
  wireCustomer(email);

  assert.equal(await hasMemberNo(email), true);
  assert.deepEqual(fakeStripe.__getCallLog(), []);
});

test('hasMemberNo(): 表記ゆれ(大文字・前後空白)でも同じキーを見る', async () => {
  const email = 'has-check-case@example.com';
  wireCustomer(email);
  await assignMemberNoIfMissing(email);

  assert.equal(await hasMemberNo('  Has-Check-Case@Example.com  '), true);
});

test('メールアドレスの大文字・前後空白を正規化してから処理する(表記ゆれで2つの番号が付かない)', async () => {
  const email = 'case-test@example.com';
  wireCustomer(email);

  const first = await assignMemberNoIfMissing(email);
  const second = await assignMemberNoIfMissing('  Case-Test@Example.com  ');

  assert.equal(first, '1');
  assert.equal(second, '1');
  assert.equal(await redis.get(redisKey('ls_member_no', 'counter')), 1);
});
