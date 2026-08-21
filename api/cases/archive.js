// api/cases/archive.js
// GET /api/cases/archive?from=YYYY-MM-DD&to=YYYY-MM-DD
// アーカイブ(非表示)になった案件を日付範囲で検索する。全プラン開放。
//
// アーカイブは工程D-2で実際に発生するようになった（完了/失注へ確定した時点で
// プランの retention_days を案件へ焼き込み、期限が来たら日次のcronが非表示にする）。
// Stripeの Price metadata に retention_days を設定していないアカウントは
// 無期限扱いのままなので、その場合は従来どおり空配列が返る。
//
// 【工程P3でこのエンドポイントのプラン制限を外した理由】
// 「中身は見えないが確かにそこにあると分かる」状態を作り、アップグレードの動機に
// するため。一覧(件数・案件名・日付)はライトでも見えるが、詳細閲覧(GET /api/cases/{id})
// と複製(POST /api/cases の duplicateFrom)は lib/featureCampaigns.js の
// canUseFeature('archiveAccess', plan) でプラン制限する(該当ファイル参照)。
// 「一覧は見せて中身は見せない」という設計のため、この一覧が返すフィールドは
// toArchiveListItem() で厳格に絞る。cartItems・estimateMeta・memo等、中身が
// 推測できる情報を含めないこと。

import { requireAuth } from '../_auth';
import { searchArchivedCases } from '../../lib/cases';

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * アーカイブ一覧に出してよい形だけを取り出す。
 *
 * 【なぜ関数に切り出すか】searchArchivedCases() はcartItems・estimateMeta等を含む
 * 案件レコードをそのまま返す(lib/cases.jsの他のlist系関数と同じ流儀)。この一覧APIは
 * ライトでも見えるため、レスポンスに中身が乗らないよう、ここで明示的に絞る。将来
 * searchArchivedCases() を呼ぶエンドポイントが増えたときに、grepで「一覧に出して
 * よい形」をすぐ見つけられるようにするため、インラインのmap()ではなく名前を付けた。
 *
 * @param {object} record lib/cases.js の案件レコード
 */
export function toArchiveListItem(record) {
  return {
    id: record.id,
    customerName: record.customerName,
    status: record.status,
    archivedAt: record.archivedAt,
  };
}

export default async function handler(req, res) {
  // プラン制限を持たないため、limits/period は不要。requireAuth() で email だけ取る。
  const email = await requireAuth(req, res);
  if (!email) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from, to } = req.query;

  if (from && !DATE_FORMAT.test(from)) {
    return res.status(400).json({ error: '開始日はYYYY-MM-DD形式で指定してください' });
  }
  if (to && !DATE_FORMAT.test(to)) {
    return res.status(400).json({ error: '終了日はYYYY-MM-DD形式で指定してください' });
  }

  // from/toはYYYY-MM-DDのまま受け取るが、JST(UTC+9)固定で解釈する。
  // from → その日のJST 00:00:00.000、to → その日のJST 23:59:59.999。
  // ここをUTCの0時として解釈すると、cronの自動アーカイブ(api/cron/process-cases.js)
  // はJST 3:00に走り、archivedAtはその時点のDate.now()（UTC基準の絶対時刻）で
  // 記録されるため、JSTでの「その日」の一部(JST 0:00〜8:59分)がUTC解釈では
  // 前日側にずれてしまう。暗黙のローカルタイムゾーン(実行環境依存)にも
  // 依存しないよう、明示的なオフセット(+09:00)付きの文字列にしてからDateへ渡す。
  const fromDate = from ? new Date(`${from}T00:00:00.000+09:00`) : undefined;
  const toDate = to ? new Date(`${to}T23:59:59.999+09:00`) : undefined;

  if (fromDate && Number.isNaN(fromDate.getTime())) {
    return res.status(400).json({ error: '開始日に存在しない日付が指定されています' });
  }
  if (toDate && Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ error: '終了日に存在しない日付が指定されています' });
  }
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    return res.status(400).json({ error: '開始日は終了日より前の日付を指定してください' });
  }

  const range = { from: fromDate, to: toDate };

  const records = await searchArchivedCases(email, range);

  return res.status(200).json({ cases: records.map(toArchiveListItem) });
}
