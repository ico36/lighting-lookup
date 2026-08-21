// api/cases/index.js
// GET  /api/cases  ... ログイン中アカウントの案件一覧(非アーカイブ)を取得
// POST /api/cases  ... 案件を新規作成
//   body.draft === true の場合、customerName未設定の下書き案件を作成する
//   （カート機能で「対象の案件がまだ無い」ときの自動作成用）
//   body.duplicateFrom === '<caseId>' の場合、その案件を複製した新規案件を作成する
//   （アーカイブ済み案件の「この内容で新しい案件を作る」用）

import { requireAuthWithPlan } from '../_auth';
import { createCase, createDraftCase, duplicateCase, getCase, listVisibleCases } from '../../lib/cases';
import { caseLimitExceededBody, featureRestrictedBody } from '../../lib/responses';
import { canUseFeature } from '../../lib/featureCampaigns';

const FEATURE_KEY = 'archiveAccess';

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
    // duplicateFromは値がそのままRedisキー構築(lib/redis.jsのredisKey())に渡り、
    // 文字列以外・空文字だと未整形の例外(500)に化けてしまう。draftのような
    // 「値が何であれ実害の無い真偽フラグ」とは違い実質的な入力なので、
    // 分岐に入る前に明示的に検証して400で弾く。
    if (
      req.body?.duplicateFrom !== undefined &&
      (typeof req.body.duplicateFrom !== 'string' || !req.body.duplicateFrom)
    ) {
      return res.status(400).json({
        error: 'INVALID_REQUEST',
        message: 'duplicateFromの形式が正しくありません',
      });
    }

    // 複製元がアーカイブ済み案件のときだけプラン制限する(工程P3)。存在しない/
    // 他人の案件はここでは弾かず、duplicateCase() 側の既存のCASE_NOT_FOUND(404)に
    // 委ねる(このガードで区別すると「そのIDは存在する」情報が漏れるため)。
    // duplicateCase() も内部で同じ id を getCase() し直すが、複製実行前にプラン判定
    // したいこと・判定ロジックをAPI層に閉じたいことを優先し、二重取得を許容する。
    if (req.body?.duplicateFrom) {
      const source = await getCase(req.body.duplicateFrom);
      if (
        source &&
        source.email === email &&
        Number.isFinite(source.archivedAt) &&
        !canUseFeature(FEATURE_KEY, limits.plan)
      ) {
        return res.status(403).json(featureRestrictedBody({ featureKey: FEATURE_KEY }));
      }
    }

    try {
      // 下書き(カートからの自動作成)・複製のどちらも保存件数のカウント対象なので、
      // caseLimit は3経路すべてに必ず渡す（渡し忘れると上限がすり抜ける）。
      // duplicateFrom と draft が両方来た場合は duplicateFrom を優先する
      // （フロントから同時に送る想定はないが、複製の方がより具体的な指示のため）。
      const record = req.body?.duplicateFrom
        ? await duplicateCase(req.body.duplicateFrom, email, { caseLimit: limits.caseLimit })
        : req.body?.draft
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
      if (err.code === 'CASE_NOT_FOUND') {
        // 複製元が存在しない/他人の案件のどちらも同じ404に倒す。他人の案件だけ
        // 403にすると「そのIDは存在する」という情報が漏れるため区別しない
        // （api/cases/[id].js の既存の404と同じ考え方・同じレスポンス形状）。
        return res.status(404).json({ error: 'CASE_NOT_FOUND' });
      }
      console.error('[cases] 作成エラー:', err);
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).json({ error: 'Method not allowed' });
}
