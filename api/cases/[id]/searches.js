// api/cases/[id]/searches.js
// POST /api/cases/{id}/searches ... 型番検索結果を案件に紐づけて保存する

import { requireAuth } from '../../_auth';
import { getCase, addSearchToCase } from '../../../lib/cases';

export default async function handler(req, res) {
  const email = requireAuth(req, res);
  if (!email) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  const record = await getCase(id);
  if (!record || record.email !== email) {
    return res.status(404).json({ error: 'CASE_NOT_FOUND' });
  }

  const { model, manufacturer, name, status, note } = req.body || {};
  if (!model) {
    return res.status(400).json({ error: '型番が指定されていません' });
  }

  await addSearchToCase(id, {
    model,
    manufacturer: manufacturer || '',
    name: name || '',
    status: status || '',
    note: note || '',
  });

  return res.status(201).json({ success: true });
}
