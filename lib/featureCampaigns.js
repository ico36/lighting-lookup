// lib/featureCampaigns.js
//
// 「先に全プランへ機能開放し、反応を見てから上位プラン限定に切り出す」
// という課金方針(Obsidian 2026-07-21ログ)に沿って、機能ごとの無料お試し
// 状況を一元管理する。
//
// endsAt が未確定の機能は null にしておく（終了時期未定のまま無期限で
// 全プランに開放中とみなす）。終了時期が決まったらここに日付を設定する
// だけで、期限後は restrictedToPlan のプランのみ利用可能になる。

export const FEATURE_CAMPAIGNS = {
  archiveSearch: {
    // アーカイブ済み案件の日付検索機能
    endsAt: null, // 終了時期は未定（決まり次第ここに日付を設定する）
    restrictedToPlan: 'premium',
    message: 'この機能は現在無料お試し期間中です。終了時期は未定です。',
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
 * 期限後は restrictedToPlan と一致するプランのみOK。
 */
export function canUseFeature(featureKey, plan) {
  const campaign = getCampaign(featureKey);
  if (!campaign) return true; // キャンペーン設定がない機能は常に利用可
  if (isCampaignActive(featureKey)) return true;
  return plan === campaign.restrictedToPlan;
}
