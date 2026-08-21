// tests/lib/canUseFeature.test.mjs
// lib/featureCampaigns.js の isWithinCampaignWindow()・isPlanAllowed()・
// canUseFeature() の分岐網羅(工程P3-1・P3-2でのendsAt反転を反映)。
//
// 【endsAtの意味づけがfail-closedに反転したことについて】
// endsAt: null は「無期限で全プラン開放」ではなく「キャンペーンなし
// (=allowedPlansの制限が常に有効)」を意味するようになった。そのため、
// FEATURE_CAMPAIGNS.archiveAccess は endsAt: null のままでも、実際の本番設定
// (allowedPlans: ['standard', 'pro'])どおり canUseFeature('archiveAccess', 'light')
// が false になる。これが今回の反転の効果そのものなので、以前のように
// 「endsAtがnullの間はcanUseFeature()側で検証できない」という制約はもう無い。
// isPlanAllowed()を別立てで直接テストする理由も本来は薄れているが、
// 「判定の核を純粋関数として切り出す」方針(isEarlyBirdCouponAvailable()と同じ)
// 自体は変わらないため、両方のレベルでテストを残す。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canUseFeature,
  isPlanAllowed,
  isWithinCampaignWindow,
  FEATURE_CAMPAIGNS,
} from '../../lib/featureCampaigns.js';
import { ADMIN_PLAN_LIMITS, DEFAULT_PLAN_LIMITS } from '../../lib/subscription.js';

const archiveAllowedPlans = FEATURE_CAMPAIGNS.archiveAccess.allowedPlans;

// ----- isWithinCampaignWindow(endsAt) -----
// 反転の判断そのものを固定する箇所なので、未来・過去・null/undefinedの3系統を
// 落とさず見る。

test('isWithinCampaignWindow(): 未来の日付ならtrue(キャンペーン期間内)', () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isWithinCampaignWindow(future), true);
});

test('isWithinCampaignWindow(): 過去の日付ならfalse(キャンペーン終了)', () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isWithinCampaignWindow(past), false);
});

test('isWithinCampaignWindow(): null/undefinedはどちらもfalse(キャンペーンなし)', () => {
  assert.equal(isWithinCampaignWindow(null), false);
  assert.equal(isWithinCampaignWindow(undefined), false);
});

// ----- isPlanAllowed(plan, allowedPlans) -----

test('isPlanAllowed(): light は許可プランに含まれない(現行のarchiveAccess設定)', () => {
  assert.equal(isPlanAllowed('light', archiveAllowedPlans), false);
});

test('isPlanAllowed(): standard / pro は許可プランに含まれる(現行のarchiveAccess設定)', () => {
  assert.equal(isPlanAllowed('standard', archiveAllowedPlans), true);
  assert.equal(isPlanAllowed('pro', archiveAllowedPlans), true);
});

test('isPlanAllowed(): allowedPlansが空配列なら常にfalse', () => {
  assert.equal(isPlanAllowed('pro', []), false);
});

// ----- canUseFeature(featureKey, plan) -----

test('canUseFeature(): 未知のfeatureKey(キャンペーン設定が無い機能)は常にtrueで、例外にならない', () => {
  assert.doesNotThrow(() => canUseFeature('no-such-feature-key', 'light'));
  assert.equal(canUseFeature('no-such-feature-key', 'light'), true);
});

// 【今回の要】endsAt反転により、archiveAccessはendsAt: nullのままでも
// 「キャンペーンなし=制限が常に有効」になる。ここでlightがfalseになることが、
// このセッションで直した本題(書き忘れ・設定忘れが緩い側に倒れる問題)の効果そのもの。
test('canUseFeature(): archiveAccessはendsAt: null(キャンペーンなし)のため、allowedPlansに無いlightはfalse', () => {
  assert.equal(canUseFeature('archiveAccess', 'light'), false);
});

test('canUseFeature(): archiveAccessはendsAt: null(キャンペーンなし)でも、allowedPlansにあるstandard/proはtrue', () => {
  assert.equal(canUseFeature('archiveAccess', 'standard'), true);
  assert.equal(canUseFeature('archiveAccess', 'pro'), true);
});

test('canUseFeature(): admin は許可プランに含まれていなくても常にtrue', () => {
  assert.equal(canUseFeature('archiveAccess', ADMIN_PLAN_LIMITS.plan), true);
});

test('canUseFeature(): unknown(metadata未設定・Stripe障害時のフェイルオープン)は常にtrue', () => {
  assert.equal(canUseFeature('archiveAccess', DEFAULT_PLAN_LIMITS.plan), true);
});
