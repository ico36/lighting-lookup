// api/cases/archive.js
// GET /api/cases/archive?from=YYYY-MM-DD&to=YYYY-MM-DD
// アーカイブ(非表示)になった案件を日付範囲で検索する。
//
// アーカイブは工程D-2で実際に発生するようになった（完了/失注へ確定した時点で
// プランの retention_days を案件へ焼き込み、期限が来たら日次のcronが非表示にする）。
// Stripeの Price metadata に retention_days を設定していないアカウントは
// 無期限扱いのままなので、その場合は従来どおり空配列が返る。
//
// 「先に全プランへ開放し、反応を見てから上位プラン限定に切り出す」方針
// (lib/featureCampaigns.js) に沿って、無料お試し中はプランを問わず利用可能。
// お試し終了後は restrictedToPlan のプランのみ利用可能にする。

import { requireAuthWithPlan } from '../_auth';
import { searchArchivedCases } from '../../lib/cases';
import { canUseFeature, getCampaignStatus } from '../../lib/featureCampaigns';

const FEATURE_KEY = 'archiveSearch';

export default async function handler(req, res) {
  // お試し期間終了後のプラン判定に limits.plan を使うため requireAuthWithPlan()
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return;
  const { email, limits } = auth;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const campaign = getCampaignStatus(FEATURE_KEY);

  // プランは Stripe の Price metadata の plan（lib/subscription.js が解決したもの）。
  // お試し期間中(FEATURE_CAMPAIGNS.archiveSearch.endsAt === null)は canUseFeature が
  // 常に true を返すため、現時点でこの値が判定結果を変えることはない。
  // 【endsAt を設定する前に確認すること】restrictedToPlan('premium')と、Stripeの
  // Price metadata に実際に設定されている plan の文字列が一致していないと、誰も
  // 条件を満たせなくなる。管理者('admin')と metadata未設定('unknown')の扱いも
  // 併せて決めること（現状はどちらも restrictedToPlan と一致しないため弾かれる）。
  if (!canUseFeature(FEATURE_KEY, limits.plan)) {
    return res.status(403).json({
      error: 'PREMIUM_ONLY',
      message: '無料お試し期間が終了したため、この機能は上位プランのみご利用いただけます。',
    });
  }

  const { from, to } = req.query;
  const range = {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };

  const cases = await searchArchivedCases(email, range);

  // campaign 情報を同梱し、フロント側で告知バナーを出せるようにする
  return res.status(200).json({ cases, campaign });
}
