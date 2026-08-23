// api/cases/[id].js
// GET   /api/cases/{id}  ... 案件詳細(検索履歴・ステータス履歴・カート内容込み)を取得
// PATCH /api/cases/{id}  ... 以下のいずれかを指定して更新する(1回のリクエストにつき1種類)
//   { status }                       ... ステータスを変更（任意のステータス間で自由に遷移可能）
//   { cartAdd: {...} }                ... カートに器具を1点追加
//   { cartUpdate: { itemId, ... } }   ... カート内アイテムの単価・数量を更新
//   { cartReplace: { itemId, name, modelNumber, manufacturer, rawDetail, unitPrice } }
//                                      ... カート内アイテムを型番の再検索結果で差し替える
//   { cartRemove: { itemId } }        ... カートからアイテムを削除
//   { estimateMeta: {...} }           ... 見積書の付随情報（お客様名・工事場所・施工費・出張費・備考）を更新
//   { restoreImport: {...} }          ... ローカル保存したJSONファイルの内容で
//                                        customerName・memo・cartItems・estimateMetaを一括復元
//                                        （ステータスは変更しない）
//   { estimateFormSave: { customerName?, estimateMeta? } }
//                                      ... 見積書フォーム画面の「保存」ボタン用。案件名と
//                                        見積書の付随情報を1回のリクエストでまとめて更新する
//                                        （どちらか一方の省略可）。customerName・estimateMeta
//                                        を別々のリクエストで送ると、並列実行時に後勝ちで
//                                        片方の更新が消える恐れがあるため、まとめて1回で確定させる
//   { customerName }                  ... 案件名（案件一覧・案件詳細の表示名）を変更
//   { archive: true }                 ... 手動アーカイブ。status が完了/失注・キャンセルの
//                                        案件のみ可（それ以外は403 CASE_NOT_ARCHIVABLE）。
//                                        復元は実装しない。自動アーカイブ(cronによる
//                                        保持期間経過)と同じ archiveCase() を呼ぶ
// DELETE /api/cases/{id} ... 案件を完全に削除する（archiveとは異なり物理削除。取り消し不可）
//
// 発注ボタンなど承認済み以降でしか出せない操作は、フロント側で
// case.status === '承認済み' を見て判定する。

import { requireAuthWithPlan } from '../_auth';
import {
  STATUS,
  TERMINAL_STATUSES,
  getCase,
  updateCaseStatus,
  addCartItem,
  updateCartItem,
  replaceCartItem,
  removeCartItem,
  updateEstimateMeta,
  restoreCaseFromImport,
  updateCaseName,
  updateCaseNameAndEstimateMeta,
  deleteCase,
  archiveCase,
  listSearchesForCase,
  listStatusLogs,
} from '../../lib/cases';
import { canUseFeature } from '../../lib/featureCampaigns';
import { featureRestrictedBody } from '../../lib/responses';

const VALID_STATUSES = Object.values(STATUS);
const FEATURE_KEY = 'archiveAccess';

export default async function handler(req, res) {
  // 完了/失注へのステータス変更時に、そのときのプランの保持期間(limits.retentionDays)を
  // 案件へ焼き込むため requireAuthWithPlan() を使う
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return;
  const { email, limits } = auth;

  const { id } = req.query;
  const record = await getCase(id);
  if (!record || record.email !== email) {
    return res.status(404).json({ error: 'CASE_NOT_FOUND' });
  }

  if (req.method === 'GET') {
    // アーカイブ済み案件の詳細閲覧はプラン制限の対象(工程P3)。判定は record.archivedAt
    // の有無で行う(public/index.htmlのisArchived判定と同じ基準)。通常案件は
    // このガードを通らない。
    if (Number.isFinite(record.archivedAt) && !canUseFeature(FEATURE_KEY, limits.plan)) {
      return res.status(403).json(featureRestrictedBody({ featureKey: FEATURE_KEY }));
    }

    const [searches, logs] = await Promise.all([
      listSearchesForCase(id),
      listStatusLogs(id),
    ]);
    return res.status(200).json({ case: record, searches, logs });
  }

  if (req.method === 'PATCH') {
    // 【P3-2とは別件】アーカイブ済み案件への書き込みは全プラン共通で不可にする。
    // これはプラン制限ではなく、全ユーザーに共通する担保漏れの修正。
    // 「アーカイブ済みは閲覧専用」はpublic/index.htmlのisArchived判定でボタンを
    // 出さないことでしか担保されておらず、API を直接叩けばプラン・契約状況を問わず
    // status変更・カート操作・見積り情報の書き換えが素通りしていた
    // (lib/cases.jsの各更新関数はarchivedAtを一切参照していない)。アーカイブは
    // 全プランで永久保持・復元不可の方針のため、書き込みを閉じても「編集し直す」
    // 手段は元から存在せず(複製して新しい案件を作るのが唯一の経路)実害は無い。
    if (Number.isFinite(record.archivedAt)) {
      return res.status(403).json({
        error: 'CASE_ARCHIVED',
        message: 'この案件はアーカイブ済みのため編集できません。',
      });
    }

    const { status, cartAdd, cartUpdate, cartReplace, cartRemove, estimateMeta, restoreImport, estimateFormSave, customerName, archive } = req.body || {};

    try {
      if (status !== undefined) {
        if (!VALID_STATUSES.includes(status)) {
          return res.status(400).json({
            error: 'INVALID_STATUS',
            message: `status は ${VALID_STATUSES.join(' / ')} のいずれかである必要があります`,
          });
        }
        // 完了/失注へ確定する場合、updateCaseStatus() が retentionDays を焼き込む。
        // 差し戻し(それ以外のステータス)のときは焼き込み済みの値がクリアされ、
        // 再確定時にそのときのプランで書き直される。
        const updated = await updateCaseStatus(id, status, 'user', {
          retentionDays: limits.retentionDays,
        });
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

      if (cartReplace) {
        const { itemId, ...patch } = cartReplace;
        if (!itemId) {
          return res.status(400).json({ error: 'itemIdが指定されていません' });
        }
        const updated = await replaceCartItem(id, itemId, patch);
        return res.status(200).json({ case: updated });
      }

      if (cartRemove) {
        if (!cartRemove.itemId) {
          return res.status(400).json({ error: 'itemIdが指定されていません' });
        }
        const updated = await removeCartItem(id, cartRemove.itemId);
        return res.status(200).json({ case: updated });
      }

      if (estimateMeta) {
        const updated = await updateEstimateMeta(id, estimateMeta);
        return res.status(200).json({ case: updated });
      }

      if (restoreImport) {
        const updated = await restoreCaseFromImport(id, restoreImport);
        return res.status(200).json({ case: updated });
      }

      if (estimateFormSave) {
        const { customerName: formCustomerName, estimateMeta: formEstimateMeta } = estimateFormSave;
        // 両方省略はクライアント側の不具合の兆候(何も更新するもの無しでこの
        // アクションを送る意味が無い)なので、他の分岐(cartUpdate等のitemId必須
        // チェック)と同じく400で弾く。updateCaseNameAndEstimateMeta()自体は
        // 両方省略でも壊れない(recordを素通りさせるだけ)が、ここでは呼び出し側の
        // 誤りに気づけるようにする。
        if (formCustomerName === undefined && formEstimateMeta === undefined) {
          return res.status(400).json({
            error: 'INVALID_REQUEST',
            message: 'customerNameとestimateMetaのどちらも指定されていません',
          });
        }
        const updated = await updateCaseNameAndEstimateMeta(id, {
          customerName: formCustomerName,
          estimateMeta: formEstimateMeta,
        });
        return res.status(200).json({ case: updated });
      }

      if (customerName !== undefined) {
        const updated = await updateCaseName(id, customerName);
        return res.status(200).json({ case: updated });
      }

      // 手動アーカイブ。最後に置くのは、status等と同時に送られた場合にこの分岐が
      // 他の更新を食ってしまわないため(この分岐より前のif群がすべて先勝ちする)。
      // 「既にアーカイブ済みの案件への手動アーカイブ」は、この分岐に来る前に
      // このPATCHブロック冒頭にある CASE_ARCHIVED ガード(全action共通、record.archivedAt
      // の有無を見て403を返す)で弾かれるため、ここでは二重アーカイブのチェックを
      // しない(判定を2箇所に分散させない)。
      if (archive) {
        if (!TERMINAL_STATUSES.includes(record.status)) {
          return res.status(403).json({
            error: 'CASE_NOT_ARCHIVABLE',
            message: 'アーカイブできるのは「完了」または「失注・キャンセル」の案件のみです。',
          });
        }
        const updated = await archiveCase(id);
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

  if (req.method === 'DELETE') {
    try {
      await deleteCase(id);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[cases] 削除エラー:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }

  res.setHeader('Allow', ['GET', 'PATCH', 'DELETE']);
  return res.status(405).json({ error: 'Method not allowed' });
}
