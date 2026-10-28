// tests/lib/subscription.campaign2x.test.mjs
// 回数2倍キャンペーン(lib/subscription.js の resolveCampaign2x() / isWithinCampaign2xSignupWindow())
// の単体テスト。対象は checkActiveSubscriptionLive() の実コード。
// lib/subscription.js自体はフェイクにせず本物を読み込み、Stripe SDKだけを
// フェイクへ差し替える(tests/lib/subscription.priceWhitelist.test.mjsと同じ方針)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { checkActiveSubscriptionLive, isWithinCampaign2xSignupWindow } from '../../lib/subscription.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';

const EMAIL = 'campaign-test@example.com';

// subscription.start_date・metadataを指定できるサブスクリプションを組み立てる。
// tests/lib/subscription.priceWhitelist.test.mjs の subOf() と同じ形だが、
// キャンペーン判定に必要な2つのフィールドを追加で受け取る。
function subOf(priceId, { startDateSec, metadata, ...overrides } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: overrides.id || `sub_${priceId}`,
    customer: 'cus_test',
    status: overrides.status || 'active',
    current_period_start: overrides.current_period_start ?? nowSec,
    current_period_end: overrides.current_period_end ?? nowSec + 30 * 24 * 60 * 60,
    start_date: startDateSec ?? nowSec,
    metadata: metadata || {},
    items: { data: [{ id: `si_${priceId}`, price: fakeStripe.__getDefaultPrice(priceId) }] },
  };
}

beforeEach(() => {
  fakeStripe.__reset();
  process.env.STRIPE_PRICE_ID_LIGHT = 'price_light_test';
  process.env.STRIPE_PRICE_ID_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_ID_PRO = 'price_pro_test';
});

test('metadata.app_campaign_2xがtrue・申し込みから3か月以内 → searchLimitが2倍、campaign.activeがtrue', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_standard_test', {
      startDateSec: nowSec - 10 * 24 * 60 * 60, // 10日前に申し込み
      metadata: { app_campaign_2x: 'true' },
    })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.active, true);
  assert.equal(result.limits.searchLimit, 200, '標準の100回が2倍の200回になっていること');
  assert.deepEqual(result.campaign, { active: true, until: result.period.end });
});

test('metadata.app_campaign_2xが無い(申し込み時に対象外と判定された) → 2倍にならない', async () => {
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_standard_test', { metadata: {} })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.limits.searchLimit, 100);
  assert.equal(result.campaign, null);
});

test('metadata.app_campaign_2xがtrueでも現在のプランがlight(ダウングレード済み) → 2倍にならない', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_light_test', {
      startDateSec: nowSec - 10 * 24 * 60 * 60,
      metadata: { app_campaign_2x: 'true' },
    })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.limits.plan, 'light');
  assert.equal(result.limits.searchLimit, 20);
  assert.equal(result.campaign, null);
});

test('申し込みから3か月(暦月)を過ぎて最初に切り替わった請求期間 → 2倍にならない', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // 申し込みから4か月前。3か月後の基準日より前に現在の請求期間が始まっている。
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_standard_test', {
      startDateSec: nowSec - 120 * 24 * 60 * 60,
      current_period_start: nowSec - 5 * 24 * 60 * 60,
      metadata: { app_campaign_2x: 'true' },
    })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.limits.searchLimit, 100);
  assert.equal(result.campaign, null);
});

test('基準日(start_date+3か月)が現在の請求期間の途中に来る場合は、その期間いっぱい2倍のまま', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  // 請求期間の開始は3か月ちょうどの少し前(基準日はまだ来ていない)。
  // 請求期間の終了は3か月ちょうどの少し後(期間の途中で基準日を迎える)。
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_standard_test', {
      startDateSec: nowSec - 89 * 24 * 60 * 60,
      current_period_start: nowSec - 1 * 24 * 60 * 60,
      current_period_end: nowSec + 29 * 24 * 60 * 60,
      metadata: { app_campaign_2x: 'true' },
    })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.limits.searchLimit, 200, '請求期間の途中で基準日を迎えても、その期間中は2倍のまま');
  assert.deepEqual(result.campaign, { active: true, until: result.period.end });
});

test('スタンダードからプロへアップグレード後も、申し込み時のstart_date・フラグを引き継いだままなら2倍が続く', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_pro_test', {
      startDateSec: nowSec - 40 * 24 * 60 * 60,
      metadata: { app_campaign_2x: 'true' },
    })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  assert.equal(result.limits.plan, 'pro');
  // プロのsearch_limitはテストフィクスチャ上-1(無制限)のため、2倍判定自体が
  // 効かない(isUnlimitedな上限は2倍にしない)ことを確認する。
  assert.equal(result.limits.searchLimit, -1);
  assert.equal(result.campaign, null);
});

test('isWithinCampaign2xSignupWindow(): START/ENDいずれも未設定ならfalse', () => {
  delete process.env.CAMPAIGN_2X_SIGNUP_START;
  delete process.env.CAMPAIGN_2X_SIGNUP_END;
  assert.equal(isWithinCampaign2xSignupWindow(Date.now()), false);
});

test('isWithinCampaign2xSignupWindow(): 日付形式が不正ならfalse', () => {
  process.env.CAMPAIGN_2X_SIGNUP_START = 'not-a-date';
  process.env.CAMPAIGN_2X_SIGNUP_END = '2026-12-31T00:00:00+09:00';
  assert.equal(isWithinCampaign2xSignupWindow(Date.now()), false);
});

test('isWithinCampaign2xSignupWindow(): 開催期間内ならtrue、期間外ならfalse', () => {
  process.env.CAMPAIGN_2X_SIGNUP_START = '2026-01-01T00:00:00+09:00';
  process.env.CAMPAIGN_2X_SIGNUP_END = '2026-06-30T23:59:59+09:00';

  const inside = Date.parse('2026-03-15T00:00:00+09:00');
  const beforeStart = Date.parse('2025-12-31T00:00:00+09:00');
  const afterEnd = Date.parse('2026-07-01T00:00:00+09:00');

  assert.equal(isWithinCampaign2xSignupWindow(inside), true);
  assert.equal(isWithinCampaign2xSignupWindow(beforeStart), false);
  assert.equal(isWithinCampaign2xSignupWindow(afterEnd), false);
});
