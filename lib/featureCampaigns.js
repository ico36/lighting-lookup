// lib/featureCampaigns.js
//
// 「先に全プランへ機能開放し、反応を見てから上位プラン限定に切り出す」
// という課金方針(Obsidian 2026-07-21ログ)に沿って、機能ごとの無料お試し
// 状況を一元管理する。
//
// 【endsAtの意味づけ(fail-closed)】endsAt: null = キャンペーンなし =
// allowedPlans による制限が常に有効。期間限定で全プランへ試験開放したい
// ときだけ、未来の日付を endsAt に設定する。
//
// 以前は逆(endsAt: null = 無期限で全プラン開放、設定して初めて絞られる)の
// 意味づけだった。しかしこれだと「設定を忘れる」という最も起こりやすい
// 事故が、最も緩い側(誰も締め出されない)に倒れてしまう。実際に
// archiveSearch(現archiveAccess)を restrictedToPlan: 'premium' で作った際、
// Stripeのplan値と一致しない値を入れたままendsAtも未設定にしていたため、
// 「一致しないから全員締め出される」はずが「endsAt未設定だから全員通る」に
// なり、設計ミスが無害に隠れたまま気づかれなかった。この向きを反転し、
// 書き忘れ・設定忘れが制限のかかる側に倒れるようにしている。
//
// プラン名の文字列は lib/subscription.js の定数から取る（'admin' や 'unknown' を
// ここで直接書くと、向こうを変えたときに黙ってバイパスが効かなくなる）。

import { ADMIN_PLAN_LIMITS, DEFAULT_PLAN_LIMITS } from './subscription';

export const FEATURE_CAMPAIGNS = {
  archiveAccess: {
    // アーカイブ済み案件の詳細閲覧・複製(工程P3)。一覧の日付検索自体は
    // 全プラン開放で、対象は「詳細を開く」「複製する」の2操作。
    endsAt: null, // キャンペーンなし。allowedPlansの制限が常に有効
    // 単一プランの完全一致ではなく、許可プランの集合で持つ(api/checkout.jsの
    // UPGRADE_PATHSと同じ流儀)。「スタンダード以上」を表現するのに、コードに
    // プラン順位表を持ち込まずに済む。
    allowedPlans: ['standard', 'pro'],
    message: 'この機能は現在、無料お試し期間中です。お試し期間終了後は上位プラン限定機能となります(終了時期は未定です)。',
  },
};

export function getCampaign(featureKey) {
  return FEATURE_CAMPAIGNS[featureKey] || null;
}

/**
 * endsAt(ISO日付文字列等)を渡し、それより前(=キャンペーン期間内)かどうかだけを
 * 見る純粋関数。endsAtが無い(null/undefined)場合はfalse(=キャンペーンなし)を返す。
 * isCampaignActive()から判定の核だけを切り出したもの。isPlanAllowed()と同じ理由
 * (FEATURE_CAMPAIGNSの実データを動かさずに「未来のendsAtを渡したときの挙動」を
 * 直接テストできるようにするため)で分けている。
 */
export function isWithinCampaignWindow(endsAt) {
  if (!endsAt) return false;
  return Date.now() < new Date(endsAt).getTime();
}

export function isCampaignActive(featureKey) {
  const campaign = getCampaign(featureKey);
  if (!campaign) return false;
  return isWithinCampaignWindow(campaign.endsAt);
}

/**
 * フロント側のバナー表示に使う情報をまとめて返す。
 * 例: { active: false, endsAt: null, allowedPlans: ['standard', 'pro'], message: '...' }
 */
export function getCampaignStatus(featureKey) {
  const campaign = getCampaign(featureKey);
  if (!campaign) return null;

  return {
    active: isCampaignActive(featureKey),
    endsAt: campaign.endsAt,
    allowedPlans: campaign.allowedPlans,
    message: campaign.message,
  };
}

/**
 * plan が allowedPlans に含まれるかどうかだけを見る純粋関数。キャンペーンの有効期限
 * (isCampaignActive)やadmin/unknownのフェイルオープンとは無関係な、この判定の核だけを
 * 切り出してある。canUseFeature()を経由せずに直接テストできるようにするため
 * (isEarlyBirdCouponAvailable()と同じ「判定の核を純粋関数として切り出す」方針)。
 */
export function isPlanAllowed(plan, allowedPlans) {
  return allowedPlans.includes(plan);
}

/**
 * そのプランでこの機能を使えるかどうかを判定する。
 * endsAtに未来の日付が設定されていて、まだその期限前(=期間限定キャンペーン中)なら
 * 全プランOK。それ以外(endsAt未設定、または期限を過ぎた)は allowedPlans に
 * 含まれるプランのみOK。ただし下記2つは常にOK。
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
 * allowedPlans に含まれるかどうかだけで判定する。
 */
export function canUseFeature(featureKey, plan) {
  const campaign = getCampaign(featureKey);
  if (!campaign) return true; // キャンペーン設定がない機能は常に利用可
  if (isCampaignActive(featureKey)) return true;
  if (plan === ADMIN_PLAN_LIMITS.plan) return true;
  if (plan === DEFAULT_PLAN_LIMITS.plan) return true;
  return isPlanAllowed(plan, campaign.allowedPlans);
}
