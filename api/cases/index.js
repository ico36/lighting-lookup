// api/cases/index.js
// GET  /api/cases  ... ログイン中アカウントの案件一覧(非アーカイブ)を取得
// POST /api/cases  ... 案件を新規作成
//   body.draft === true の場合、customerName未設定の下書き案件を作成する
//   （カート機能で「対象の案件がまだ無い」ときの自動作成用）

import { requireAuthWithPlan } from '../_auth';
import { createCase, createDraftCase, listVisibleCases } from '../../lib/cases';
import { caseLimitExceededBody } from '../../lib/responses';

export default async function handler(req, res) {
  // 案件の保存件数上限(limits.caseLimit)が要るため requireAuthWithPlan() を使う
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return;
  const { email, limits } = auth;

  if (req.method === 'GET') {
    const cases = await listVisibleCases(email);
    return res.status(200).json({ cases });
  }

  if (req.method === 'POST') {
    try {
      // 下書き(カートからの自動作成)も保存件数のカウント対象なので、
      // caseLimit は両方の経路に必ず渡す（片方だけだと上限がすり抜ける）。
      const record = req.body?.draft
        ? await createDraftCase(email, { caseLimit: limits.caseLimit })
        : await createCase(email, req.body || {}, { caseLimit: limits.caseLimit });
      return res.status(201).json({ case: record });
    } catch (err) {
      if (err.code === 'CASE_LIMIT_REACHED') {
        // 時間で回復しないので429ではなく403。ボディの組み立ては lib/responses.js に
        // 集約してあり、ここでは手組みしない。文言はフロント側が limits から作る。
        return res
          .status(403)
          .json(caseLimitExceededBody({ plan: limits.plan, used: err.used, limit: err.limit }));
      }
      console.error('[cases] 作成エラー:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).json({ error: 'Method not allowed' });
}
