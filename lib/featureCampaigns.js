// lib/featureCampaigns.js
//
// 「先に全プランへ機能開放し、反応を見てから上位プラン限定に切り出す」
// という課金方針(Obsidian 2026-07-21ログ)に沿って、機能ごとの無料お試し
// 状況を一元管理する。
//
// endsAt が未確定の機能は null にしておく（終了時期未定のまま無期限で
// 全プランに開放中とみなす）。終了時期が決まったらここに日付を設定する
// だけで、期限後は restrictedToPlan のプランのみ利用可能になる。
//
// プラン名の文字列は lib/subscription.js の定数から取る（'admin' や 'unknown' を
// ここで直接書くと、向こうを変えたときに黙ってバイパスが効かなくなる）。

import { ADMIN_PLAN_LIMITS, DEFAULT_PLAN_LIMITS } from './subscription';

export const FEATURE_CAMPAIGNS = {
  archiveSearch: {
    // アーカイブ済み案件の日付検索機能
    endsAt: null, // 終了時期は未定（決まり次第ここに日付を設定する）
    restrictedToPlan: 'premium',
    message: 'この機能は現在、無料お試し期間中です。お試し期間終了後は上位プラン限定機能となります(終了時期は未定です)。',
  },
};

export function getCampaign(featureKey) {
  return FEATURE_CAMPAIGNS[featureKey] || null;
}

export function isCampaignActive(featureKey) {
  const campaign = getCampaign(featureKey);
  if (!campaign) return false;
  if (!campaign.endsAt) return true; // 終了時期未定 = 無期限で有効中
  return Date.now() < new Date(campaign.endsAt).getTime();
}

/**
 * フロント側のバナー表示に使う情報をまとめて返す。
 * 例: { active: true, endsAt: null, restrictedToPlan: 'premium', message: '...' }
 */
export function getCampaignStatus(featureKey) {
  const campaign = getCampaign(featureKey);
  if (!campaign) return null;

  return {
    active: isCampaignActive(featureKey),
    endsAt: campaign.endsAt,
    restrictedToPlan: campaign.restrictedToPlan,
    message: campaign.message,
  };
}

/**
 * 期限後にそのプランでこの機能を使えるかどうかを判定する。
 * キャンペーン中(active=true)は全プランOK。
 * 期限後は restrictedToPlan と一致するプランのみOK。ただし下記2つは常にOK。
 *
 * 【管理者('admin')】ADMIN_EMAILS はStripeのサブスク確認もログインのレート制限も
 * バイパスする設計（api/login.js / lib/subscription.js）。そもそもStripe顧客を持たず
 * 契約Priceが無いので、プラン限定機能から締め出されるのは筋が通らない。
 *
 * 【metadata未設定('unknown')】理由は2つある。
 *   1. Price に metadata を設定していない既存契約者を締め出さない。
 *      DEFAULT_PLAN_LIMITS が上限を全て無制限にしているのと同じ思想で、metadataを
 *      設定するまでは今までどおり動き、設定した時点で制限が効き始める形にする。
 *      ここだけ制限側に倒すと、その移行方針と逆向きになる。
 *   2. Stripe障害時のフェイルオープン経路(getSubscriptionStateCached の catch)も
 *      DEFAULT_PLAN_LIMITS を返すため plan は 'unknown' になる。障害中に機能を
 *      失わせないため、この場合も通す。
 *
 * どちらも「そのプランだから使える」ではなく「制限してよいと確信できないから通す」
 * という判断。プラン名そのものが確定している light/standard/pro などは従来どおり
 * restrictedToPlan との一致だけで判定する。
 */
export function canUseFeature(featureKey, plan) {
  const campaign = getCampaign(featureKey);
  if (!campaign) return true; // キャンペーン設定がない機能は常に利用可
  if (isCampaignActive(featureKey)) return true;
  if (plan === ADMIN_PLAN_LIMITS.plan) return true;
  if (plan === DEFAULT_PLAN_LIMITS.plan) return true;
  return plan === campaign.restrictedToPlan;
}
