// api/cases/archive.js
// GET /api/cases/archive?from=YYYY-MM-DD&to=YYYY-MM-DD
// アーカイブ(非表示)になった案件を日付範囲で検索する。
//
// アーカイブは工程D-2で実際に発生するようになった（完了/失注へ確定した時点で
// プランの retention_days を案件へ焼き込み、期限が来たら日次のcronが非表示にする）。
// Stripeの Price metadata に retention_days を設定していないアカウントは
// 無期限扱いのままなので、その場合は従来どおり空配列が返る。
//
// 「先に全プランへ開放し、反応を見てから上位プラン限定に切り出す」方針
// (lib/featureCampaigns.js) に沿って、無料お試し中はプランを問わず利用可能。
// お試し終了後は restrictedToPlan のプランのみ利用可能にする。

import { requireAuthWithPlan } from '../_auth';
import { searchArchivedCases } from '../../lib/cases';
import { canUseFeature, getCampaignStatus } from '../../lib/featureCampaigns';

const FEATURE_KEY = 'archiveSearch';
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  // お試し期間終了後のプラン判定に limits.plan を使うため requireAuthWithPlan()
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return;
  const { email, limits } = auth;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const campaign = getCampaignStatus(FEATURE_KEY);

  // プランは Stripe の Price metadata の plan（lib/subscription.js が解決したもの）。
  // お試し期間中(FEATURE_CAMPAIGNS.archiveSearch.endsAt === null)は canUseFeature が
  // 常に true を返すため、現時点でこの値が判定結果を変えることはない。
  // 【endsAt を設定する前に確認すること】restrictedToPlan('premium')と、Stripeの
  // Price metadata に実際に設定されている plan の文字列が一致していないと、誰も
  // 条件を満たせなくなる。管理者('admin')と metadata未設定('unknown')の扱いも
  // 併せて決めること（現状はどちらも restrictedToPlan と一致しないため弾かれる）。
  if (!canUseFeature(FEATURE_KEY, limits.plan)) {
    return res.status(403).json({
      error: 'PREMIUM_ONLY',
      message: '無料お試し期間が終了したため、この機能は上位プランのみご利用いただけます。',
    });
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

  const cases = await searchArchivedCases(email, range);

  // campaign 情報を同梱し、フロント側で告知バナーを出せるようにする
  return res.status(200).json({ cases, campaign });
}
