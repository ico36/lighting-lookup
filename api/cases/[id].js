// api/cases/[id].js
// GET   /api/cases/{id}  ... 案件詳細(検索履歴・ステータス履歴・カート内容込み)を取得
// PATCH /api/cases/{id}  ... 以下のいずれかを指定して更新する(1回のリクエストにつき1種類)
//   { status }                       ... ステータスを変更(承認済み / 完了 / 失注・キャンセル 等)
//   { cartAdd: {...} }                ... カートに器具を1点追加
//   { cartUpdate: { itemId, ... } }   ... カート内アイテムの単価・数量を更新
//   { cartRemove: { itemId } }        ... カートからアイテムを削除
//
// 発注ボタンなど承認済み以降でしか出せない操作は、フロント側で
// case.status === '承認済み' を見て判定する。

import { requireAuth } from '../_auth';
import {
  STATUS,
  getCase,
  updateCaseStatus,
  addCartItem,
  updateCartItem,
  removeCartItem,
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
    const { status, cartAdd, cartUpdate, cartRemove } = req.body || {};

    try {
      if (status !== undefined) {
        if (!VALID_STATUSES.includes(status)) {
          return res.status(400).json({
            error: 'INVALID_STATUS',
            message: `status は ${VALID_STATUSES.join(' / ')} のいずれかである必要があります`,
          });
        }
        const updated = await updateCaseStatus(id, status, 'user');
        return res.status(200).json({ case: updated });
      }

      if (cartAdd) {
        const updated = await addCartItem(id, cartAdd);
        return res.status(200).json({ case: updated });
      }

      if (cartUpdate) {
        const { itemId, ...updates } = cartUpdate;
        if (!itemId) {
          return res.status(400).json({ error: 'itemIdが指定されていません' });
        }
        const updated = await updateCartItem(id, itemId, updates);
        return res.status(200).json({ case: updated });
      }

      if (cartRemove) {
        if (!cartRemove.itemId) {
          return res.status(400).json({ error: 'itemIdが指定されていません' });
        }
        const updated = await removeCartItem(id, cartRemove.itemId);
        return res.status(200).json({ case: updated });
      }

      return res.status(400).json({ error: 'INVALID_REQUEST', message: '更新内容が指定されていません' });
    } catch (err) {
      if (err.code === 'CART_ITEM_NOT_FOUND') {
        return res.status(404).json({ error: 'CART_ITEM_NOT_FOUND' });
      }
      console.error('[cases] 更新エラー:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }

  res.setHeader('Allow', ['GET', 'PATCH']);
  return res.status(405).json({ error: 'Method not allowed' });
}
