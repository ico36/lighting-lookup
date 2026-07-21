// api/cases/index.js
// GET  /api/cases  ... ログイン中アカウントの案件一覧(非アーカイブ)を取得
// POST /api/cases  ... 案件を新規作成

import { requireAuth } from '../_auth';
import { createCase, listVisibleCases } from '../../lib/cases';

export default async function handler(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  if (req.method === 'GET') {
    const cases = await listVisibleCases(email);
    return res.status(200).json({ cases });
  }

  if (req.method === 'POST') {
    try {
      const record = await createCase(email, req.body || {});
      return res.status(201).json({ case: record });
    } catch (err) {
      if (err.code === 'CASE_LIMIT_REACHED') {
        return res.status(403).json({
          error: 'CASE_LIMIT_REACHED',
          message: `保存できる案件数の上限(${err.limit}件)に達しています。不要な案件を失注・キャンセルにするか、上位プランをご検討ください。`,
        });
      }
      console.error('[cases] 作成エラー:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).json({ error: 'Method not allowed' });
}
