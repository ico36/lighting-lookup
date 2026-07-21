// api/cases/archive.js
// GET /api/cases/archive?from=YYYY-MM-DD&to=YYYY-MM-DD
// アーカイブ(非表示)になった案件を日付範囲で検索する。
//
// 現時点では retentionDays が無制限のため自動アーカイブは発生せず、
// このエンドポイントを叩いても常に空配列が返る想定。将来 retentionDays に
// 有限値を設定した場合に備えて用意してある。

import { requireAuth } from '../_auth';
import { searchArchivedCases } from '../../lib/cases';

export default async function handler(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from, to } = req.query;
  const range = {
    from: from ? new Date(from) : undefined,
    to: to ? new Date(to) : undefined,
  };

  const cases = await searchArchivedCases(email, range);
  return res.status(200).json({ cases });
}
