// lib/statsViewers.js
// 経営統計ページ(stats.ma-system.co.jp)の閲覧許可リスト判定。
// lib/adminEmails.js(ADMIN_EMAILS)と同じ形だが、別の環境変数・別のリストにする
// (統計を見られる人に照明サーチの管理者権限まで渡さないため、ADMIN_EMAILSとは
// 意図的に混ぜない)。

function parseStatsViewerEmails() {
  return (process.env.STATS_VIEWER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isStatsViewerEmail(email) {
  return parseStatsViewerEmails().includes(String(email || '').trim().toLowerCase());
}

/**
 * 週次メール(lib/statsWeeklyEmail.js)の送信先一覧。重複は除く。
 * @returns {string[]}
 */
export function getStatsViewerEmails() {
  return [...new Set(parseStatsViewerEmails())];
}
