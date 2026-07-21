// api/cases/archive.js
// GET /api/cases/archive?from=YYYY-MM-DD&to=YYYY-MM-DD
// アーカイブ(非表示)になった案件を日付範囲で検索する。
//
// 現時点では retentionDays が無制限のため自動アーカイブは発生せず、
// このエンドポイントを叩いても常に空配列が返る想定。将来 retentionDays に
// 有限値を設定した場合に備えて用意してある。
//
// 「先に全プランへ開放し、反応を見てから上位プラン限定に切り出す」方針
// (lib/featureCampaigns.js) に沿って、無料お試し中はプランを問わず利用可能。
// お試し終了後は restrictedToPlan のプランのみ利用可能にする。

import { requireAuth } from '../_auth';
import { searchArchivedCases } from '../../lib/cases';
import { canUseFeature, getCampaignStatus } from '../../lib/featureCampaigns';

const FEATURE_KEY = 'archiveSearch';

export default async function handler(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const campaign = getCampaignStatus(FEATURE_KEY);

  // TODO: アカウントごとのプラン判定を導入したら、ここを実際のプランに差し替える。
  // 現状はプラン自体が存在しないため 'basic' 固定だが、お試し期間中は
  // canUseFeature が常に true を返すため挙動には影響しない。
  const plan = 'basic';
  if (!canUseFeature(FEATURE_KEY, plan)) {
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
