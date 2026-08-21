// tests/lib/canUseFeature.test.mjs
// lib/featureCampaigns.js の isPlanAllowed()・canUseFeature() の分岐網羅(工程P3-1)。
//
// 【isPlanAllowed()とcanUseFeature()でテストを分けている理由】
// FEATURE_CAMPAIGNS.archiveSearch は endsAt: null (お試し中)のままなので、
// canUseFeature('archiveSearch', 'light') を直接呼んでも isCampaignActive() が
// 先に true を返し、常に true になってしまう(=「lightが弾かれる」経路を通らない)。
// endsAt を過去日付にする変更はP3-2の対象で、ここでは先取りしない。
//
// そのため、allowedPlans による絞り込みそのもの(「lightはfalse、standard/proはtrue」
// という今回の本題)は、キャンペーンの有効期限と無関係な純粋関数 isPlanAllowed() を
// 直接呼んで確認する。渡す allowedPlans は実際に FEATURE_CAMPAIGNS.archiveSearch から
// 読んだ本番設定そのものにし、モック値を使わない(モジュール側の FEATURE_CAMPAIGNS を
// mutateしてテストするアプローチも検討したが、テストファイル間で共有されるモジュール
// 状態を書き換えると実行順序に依存する汚染が起きるため避けた)。
//
// canUseFeature() 側は、endsAtの状態に関わらず今すぐ検証できる分岐
// (キャンペーンactive中は全プランtrue／admin・unknownのフェイルオープン／
// 未知のfeatureKeyで例外にならない)だけを見る。endsAt後に実際に403が返ることの
// 確認はP3-2で tests/api/ 側の統合テストとして書く。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canUseFeature,
  isPlanAllowed,
  FEATURE_CAMPAIGNS,
} from '../../lib/featureCampaigns.js';
import { ADMIN_PLAN_LIMITS, DEFAULT_PLAN_LIMITS } from '../../lib/subscription.js';

const archiveAllowedPlans = FEATURE_CAMPAIGNS.archiveSearch.allowedPlans;

test('isPlanAllowed(): light は許可プランに含まれない(現行のarchiveSearch設定)', () => {
  assert.equal(isPlanAllowed('light', archiveAllowedPlans), false);
});

test('isPlanAllowed(): standard / pro は許可プランに含まれる(現行のarchiveSearch設定)', () => {
  assert.equal(isPlanAllowed('standard', archiveAllowedPlans), true);
  assert.equal(isPlanAllowed('pro', archiveAllowedPlans), true);
});

test('isPlanAllowed(): allowedPlansが空配列なら常にfalse', () => {
  assert.equal(isPlanAllowed('pro', []), false);
});

test('canUseFeature(): 未知のfeatureKey(キャンペーン設定が無い機能)は常にtrueで、例外にならない', () => {
  assert.doesNotThrow(() => canUseFeature('no-such-feature-key', 'light'));
  assert.equal(canUseFeature('no-such-feature-key', 'light'), true);
});

test('canUseFeature(): archiveSearchはendsAtがnull(お試し中)の間はプランに関わらずtrue', () => {
  assert.equal(canUseFeature('archiveSearch', 'light'), true);
  assert.equal(canUseFeature('archiveSearch', 'standard'), true);
  assert.equal(canUseFeature('archiveSearch', 'pro'), true);
});

test('canUseFeature(): admin は許可プランに含まれていなくても常にtrue', () => {
  assert.equal(canUseFeature('archiveSearch', ADMIN_PLAN_LIMITS.plan), true);
});

test('canUseFeature(): unknown(metadata未設定・Stripe障害時のフェイルオープン)は常にtrue', () => {
  assert.equal(canUseFeature('archiveSearch', DEFAULT_PLAN_LIMITS.plan), true);
});
