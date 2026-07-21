// api/cases/[id].js
// GET   /api/cases/{id}  ... 案件詳細(検索履歴・ステータス履歴込み)を取得
// PATCH /api/cases/{id}  ... ステータスを変更(承認済み / 完了 / 失注・キャンセル 等)
//
// 発注ボタンなど承認済み以降でしか出せない操作は、フロント側で
// case.status === '承認済み' を見て判定する。

import { requireAuth } from '../_auth';
import {
  STATUS,
  getCase,
  updateCaseStatus,
  listSearchesForCase,
  listStatusLogs,
} from '../../lib/cases';

const VALID_STATUSES = Object.values(STATUS);

export default async function handler(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  const { id } = req.query;
  const record = await getCase(id);
  if (!record || record.email !== email) {
    return res.status(404).json({ error: 'CASE_NOT_FOUND' });
  }

  if (req.method === 'GET') {
    const [searches, logs] = await Promise.all([
      listSearchesForCase(id),
      listStatusLogs(id),
    ]);
    return res.status(200).json({ case: record, searches, logs });
  }

  if (req.method === 'PATCH') {
    const { status } = req.body || {};
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: 'INVALID_STATUS',
        message: `status は ${VALID_STATUSES.join(' / ')} のいずれかである必要があります`,
      });
    }
    const updated = await updateCaseStatus(id, status, 'user');
    return res.status(200).json({ case: updated });
  }

  res.setHeader('Allow', ['GET', 'PATCH']);
  return res.status(405).json({ error: 'Method not allowed' });
}
