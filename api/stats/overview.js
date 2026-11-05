// api/stats/overview.js
// 経営統計ページ(stats.ma-system.co.jp)が表示する内容をまとめて返すGETエンドポイント。
// requireStatsAuth()で許可リスト(STATS_VIEWER_EMAILS)のメールアドレスだけがアクセス
// できる。都道府県別の現在値・削除待ち件数(lib/contractStats.js)、直近のスナップ
// ショットとの差分、推移の履歴(lib/statsSnapshots.js)をまとめて返す。
//
// 【Stripeへは一切問い合わせない】現在値・差分・履歴のいずれもRedisだけを読む
// (lib/contractStats.js・lib/statsSnapshots.jsのコメント参照)。
//
// 【直近のスナップショットは「今日」を除外しない】lib/statsWeeklyEmail.jsの
// 週次メール送信は同じ月曜の2回目実行で自分自身と比較しないよう今日を除外するが、
// このページは「直近の正式な集計からの変化」を見せるのが目的なので、今日(月曜の
// cron実行後)のスナップショットがあればそれを比較対象にする(除外しない)。

import { requireStatsAuth } from './_auth';
import { buildActiveContractPrefectureStats, getPendingDeletionCount } from '../../lib/contractStats';
import { getPreviousSnapshot, getSnapshotHistory, computeDiff } from '../../lib/statsSnapshots';

const HISTORY_LIMIT = 12; // 直近12週(約3か月)分

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = await requireStatsAuth(req, res);
  if (!email) return; // requireStatsAuth内で既に401/500レスポンス済み

  try {
    const [current, pendingDeletion, baseline, history] = await Promise.all([
      buildActiveContractPrefectureStats(),
      getPendingDeletionCount(),
      getPreviousSnapshot(),
      getSnapshotHistory(HISTORY_LIMIT),
    ]);

    const diff = computeDiff(current, baseline);

    return res.status(200).json({
      current,
      pendingDeletion,
      comparison: {
        baselineDate: baseline?.date || null,
        totalDelta: diff?.totalDelta ?? null,
        unregisteredDelta: diff?.unregisteredDelta ?? null,
        byPrefectureDelta: diff?.byPrefectureDelta ?? null,
      },
      history: history.map((h) => ({ date: h.date, total: h.total })),
    });
  } catch (err) {
    console.error('[stats-overview] 統計の取得に失敗しました:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
