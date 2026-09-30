// tests/lib/subscription.priceWhitelist.test.mjs
// 同じStripeアカウントに他製品(例: KYノート)のサブスク商品を追加した場合に、
// その製品だけを契約した顧客が照明サーチにログインできてしまわないための
// Price IDホワイトリスト(lib/subscription.js の getLightingSearchPriceIds())の回帰。
//
// 対象は getActiveSubscriptionWithItem()・checkActiveSubscriptionLive() の実コード。
// lib/subscription.js自体はフェイクにせず本物を読み込み、Stripe SDKと
// `./redis`(subcheckキャッシュ)だけをフェイクへ差し替える(tests/support/loader.mjs
// ルール1・2d-2)。checkActiveSubscriptionLive()はキャッシュを経由しないため
// (getSubscriptionStateCached()側が持つ)、__resetFakeRedis()は環境の初期化用。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getActiveSubscriptionWithItem,
  checkActiveSubscriptionLive,
} from '../../lib/subscription.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis } from '../support/fakes/redis.mjs';

const EMAIL = 'whitelist-test@example.com';

function subOf(priceId, overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: overrides.id || `sub_${priceId}`,
    customer: 'cus_test',
    status: overrides.status || 'active',
    current_period_start: nowSec,
    current_period_end: nowSec + 30 * 24 * 60 * 60,
    ended_at: overrides.ended_at ?? null,
    canceled_at: overrides.canceled_at ?? null,
    created: overrides.created ?? nowSec,
    items: { data: [{ id: `si_${priceId}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
  };
}

// KYノート等、照明サーチ以外の製品のPrice。metadata.planを持たせるかどうかを
// 呼び出し側で選べるようにする(2で「metadataの有無に関わらず弾かれる」ことを
// 確認するため)。selectPlanItem()はitems[].priceを直接見るので、
// fakes/stripe.mjsのprices.retrieveは経由しない。
function otherProductPrice(id, { withPlanMetadata = false } = {}) {
  return {
    id,
    unit_amount: 0,
    currency: 'jpy',
    metadata: withPlanMetadata
      ? { plan: 'ky_basic', search_limit: '999', case_limit: '999', retention_days: '999' }
      : {},
    product: { id: 'prod_kynote', name: 'KYノート' },
  };
}

function subWithOtherProductPrice(priceId, { withPlanMetadata = false, ...overrides } = {}) {
  return {
    ...subOf('_unused', overrides),
    id: overrides.id || `sub_${priceId}`,
    items: { data: [{ id: `si_${priceId}`, price: otherProductPrice(priceId, { withPlanMetadata }) }] },
  };
}

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
});

test('KYノートのみ契約(metadata.planなし) → 照明サーチはactive:falseで解約済み扱い、lastPlanLimitsもnull', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subWithOtherProductPrice('price_kynote_test')],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.customerFound, true);
  assert.equal(result.active, false);
  assert.equal(result.status, 'canceled');
  assert.equal(result.lastPlanLimits, null);
});

test('KYノートのみ契約(metadata.planあり) → metadataの中身に関わらず照明サーチはactive:false', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subWithOtherProductPrice('price_kynote_with_plan_test', { withPlanMetadata: true })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.active, false);
  assert.equal(result.status, 'canceled');
  assert.equal(result.lastPlanLimits, null);
});

test('照明サーチ＋KYノート両方契約、KYノートの方が後から契約(配列先頭) → 照明サーチ側のPriceが選ばれる', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [
      // Stripeは作成日時降順で返すため、後から契約したKYノートが先頭に来る想定を再現する。
      subWithOtherProductPrice('price_kynote_with_plan_test', { withPlanMetadata: true, id: 'sub_kynote' }),
      subOf('price_standard_test', { id: 'sub_lighting' }),
    ],
  }));

  const { subscription, item } = await getActiveSubscriptionWithItem(EMAIL);

  assert.equal(subscription.id, 'sub_lighting');
  assert.equal(item.price.metadata.plan, 'standard');
});

test('対象外サブスクが10件以上あり、照明サーチの契約がその後ろにある顧客でも正しく検出される(limit:100)', async () => {
  const otherSubs = Array.from({ length: 12 }, (_, i) =>
    subWithOtherProductPrice(`price_other_${i}`, { withPlanMetadata: true, id: `sub_other_${i}` })
  );
  const lightingSub = subOf('price_pro_test', { id: 'sub_lighting' });
  let capturedLimit = null;

  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    capturedLimit = params.limit;
    // 実際のStripe API同様、limitを超えた分は返さない(旧limit:10のままなら
    // 13件目=照明サーチの契約が切り捨てられ、このテストが検出できる)。
    return { data: [...otherSubs, lightingSub].slice(0, params.limit) };
  });

  const { subscription } = await getActiveSubscriptionWithItem(EMAIL);

  assert.equal(capturedLimit, 100);
  assert.ok(subscription, '照明サーチの契約が見つかりませんでした(limitが小さすぎる可能性があります)');
  assert.equal(subscription.id, 'sub_lighting');
});

test('既存の照明サーチ3プラン単体契約は従来通りactive:true(回帰)', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_pro_test')],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.active, true);
  assert.equal(result.limits.plan, 'pro');
});

test('KYノートだけ解約済み、照明サーチは契約したことが無い → lastPlanLimitsはnull(KYノートの解約履歴を拾わない)', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [
      subWithOtherProductPrice('price_kynote_with_plan_test', {
        withPlanMetadata: true,
        id: 'sub_kynote_canceled',
        status: 'canceled',
        ended_at: Math.floor(Date.now() / 1000) - 1000,
      }),
    ],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.status, 'canceled');
  assert.equal(result.lastPlanLimits, null);
});

test('照明サーチのPrice ID環境変数が1つでも欠けると例外を投げる(fail-closed、全部許可に倒れない)', async () => {
  delete process.env.STRIPE_PRICE_ID_PRO;

  await assert.rejects(
    () => getActiveSubscriptionWithItem(EMAIL),
    /STRIPE_PRICE_ID_PRO/
  );
});
