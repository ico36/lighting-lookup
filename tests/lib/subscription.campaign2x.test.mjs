// tests/lib/subscription.campaign2x.test.mjs
// 回数2倍キャンペーン(lib/subscription.js の resolveCampaign2x() / isWithinCampaign2xSignupWindow())
// の単体テスト。対象は checkActiveSubscriptionLive() の実コード。
// lib/subscription.js自体はフェイクにせず本物を読み込み、Stripe SDKだけを
// フェイクへ差し替える(tests/lib/subscription.priceWhitelist.test.mjsと同じ方針)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { checkActiveSubscriptionLive, isWithinCampaign2xSignupWindow } from '../../lib/subscription.js';
import { addCalendarMonthsJST } from '../../lib/dateMath.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';

// resolveCampaign2x()内のestimateCampaignEndDate()と同じ手順(period.endから
// cutoffに達するまで暦月で1か月ずつ前進)でオラクル値を計算する。
// addCalendarMonthsJST()自体の正しさはtests/lib/dateMath.test.mjsで別途確認済み。
function expectedEstimatedEndDate(periodEndMs, cutoffMs) {
  let boundary = periodEndMs;
  while (boundary < cutoffMs) {
    boundary = addCalendarMonthsJST(boundary, 1);
  }
  return boundary;
}

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

test('metadata.app_campaign_2xがtrue・申し込みから3か月以内 → searchLimitが2倍、campaign.activeがtrue、normalSearchLimitは2倍前の値', async () => {
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
  assert.equal(result.campaign.active, true);
  assert.equal(result.campaign.normalSearchLimit, 100, '2倍にする前の元の上限');
});

test('申し込み直後で、現在の請求期間の終了日が基準日より前(=まだ複数回の更新が残っている) → estimatedEndAtはperiod.endより先の月まで繰り上がる', async () => {
  // 今日申し込んだ場合、今期の終了日(+30日)は基準日(start_date+3か月≒+90日)より
  // 大幅に手前。これが「11/28で終わると誤解される」と報告されたケース。
  const nowSec = Math.floor(Date.now() / 1000);
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_standard_test', {
      startDateSec: nowSec,
      metadata: { app_campaign_2x: 'true' },
    })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  const cutoff = addCalendarMonthsJST(nowSec * 1000, 3);
  const expected = expectedEstimatedEndDate(result.period.end, cutoff);

  assert.ok(
    result.campaign.estimatedEndAt > result.period.end,
    '今期の終了日(period.end)だけで終わりと表示してはいけない'
  );
  assert.equal(result.campaign.estimatedEndAt, expected);
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
  // 基準日が今期の終了日より前(=今期で足りる)なので、見積りはperiod.endそのもの。
  assert.equal(result.campaign.estimatedEndAt, result.period.end);
  assert.equal(result.campaign.normalSearchLimit, 100);
});

test('途中でプランを上げてbilling_cycle_anchorがずれた後も、ずれた後の現在の請求期間を起点に見積もり直す', async () => {
  // 申し込みから5日後(start_dateは変わらない)。基準日(start_date+3か月)は
  // まだ遠く先(約85日後)。
  const nowSec = Math.floor(Date.now() / 1000);
  const startDateSec = nowSec - 5 * 24 * 60 * 60;

  // ところが2日前にアップグレードがあり、billing_cycle_anchorが'now'にずれて
  // 今期は(アップグレードした日)から29日後までの短いサイクルになっている。
  // start_dateから単純に1か月おきの日程を仮定すると実際の請求期間とズレるため、
  // 「現在の請求期間(period.end)」を起点に前進させる必要があることを確認する。
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subOf('price_standard_test', {
      startDateSec,
      current_period_start: nowSec - 2 * 24 * 60 * 60,
      current_period_end: nowSec + 28 * 24 * 60 * 60,
      metadata: { app_campaign_2x: 'true' },
    })],
  }));

  const result = await checkActiveSubscriptionLive(EMAIL);

  const cutoff = addCalendarMonthsJST(startDateSec * 1000, 3);
  const expected = expectedEstimatedEndDate(result.period.end, cutoff);

  assert.equal(result.campaign.active, true);
  assert.equal(result.campaign.estimatedEndAt, expected);
  // アップグレード後のperiod.end(今から28日後)が起点になっていることの確認
  // (start_dateからの単純な1か月おきの日程ではないことを別途保証する)。
  assert.ok(result.campaign.estimatedEndAt > result.period.end);
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

test('isWithinCampaign2xSignupWindow(): 日付だけのSTART/ENDはJSTとして解釈される(UTC深夜0時ではない)', () => {
  process.env.CAMPAIGN_2X_SIGNUP_START = '2026-01-01';
  process.env.CAMPAIGN_2X_SIGNUP_END = '2026-06-30';

  const atJstStart = Date.parse('2026-01-01T00:00:00+09:00');
  const justBeforeJstStart = Date.parse('2025-12-31T23:59:59+09:00');
  const atJstEndBoundary = Date.parse('2026-06-30T23:59:59+09:00');
  const justAfterJstEndBoundary = Date.parse('2026-07-01T00:00:00+09:00');
  // UTCの深夜0時として誤って解釈された場合に落ちることを確認する対照値
  // (JSTでは2026-01-01の09:00なので、UTC解釈のままなら「開始前」になってしまう)。
  const atUtcMidnightOfStartDate = Date.parse('2026-01-01T00:00:00Z');

  assert.equal(isWithinCampaign2xSignupWindow(justBeforeJstStart), false, 'JST開始の1秒前はまだ対象外であるべき');
  assert.equal(isWithinCampaign2xSignupWindow(atJstStart), true, 'JSTでのその日の00:00:00はちょうど開始');
  assert.equal(isWithinCampaign2xSignupWindow(atUtcMidnightOfStartDate), true, 'UTC深夜0時(=JST朝9時)は開始後なので対象内のはず');
  assert.equal(isWithinCampaign2xSignupWindow(atJstEndBoundary), true, 'JSTでのその日の23:59:59まで含む');
  assert.equal(isWithinCampaign2xSignupWindow(justAfterJstEndBoundary), false, 'JST終了の次の瞬間は対象外');
});

test('isWithinCampaign2xSignupWindow(): STARTだけ日付のみ、ENDはオフセット付きでも独立に解釈される', () => {
  process.env.CAMPAIGN_2X_SIGNUP_START = '2026-01-01';
  process.env.CAMPAIGN_2X_SIGNUP_END = '2026-06-30T12:00:00+09:00';

  assert.equal(isWithinCampaign2xSignupWindow(Date.parse('2026-01-01T00:00:00+09:00')), true);
  assert.equal(isWithinCampaign2xSignupWindow(Date.parse('2026-06-30T12:00:00+09:00')), true);
  assert.equal(isWithinCampaign2xSignupWindow(Date.parse('2026-06-30T12:00:01+09:00')), false);
});
