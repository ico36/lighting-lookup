// lib/statsWeeklyEmail.js
// 経営統計の週次レポート。日次cron(api/cron/process-cases.js)の中からJST月曜日
// だけ実行される想定で、以下をまとめて行う:
//   1. 現在の都道府県別の有効契約数(lib/contractStats.js)と削除待ち件数を集計
//   2. 直近のスナップショット(今日は除外)との差分を計算(初回は差分なし)
//   3. 今日のスナップショットを保存(同じ日付なら上書き。副作用が無いため毎回行う)
//   4. STATS_VIEWER_EMAILSの全員へ、1件ずつ個別にテキストメールを送る
//
// 【同じ月曜に2回動いても二重送信しない】送信(4)の直前だけ、
// stats:weekly-email:sent:{date} をSETNXで確保できたときに限って実行する。
// 集計・スナップショット保存(1〜3)は冪等(上書きで実害が無い)なので、この印の
// 対象にしない(送信だけを守る)。既に送信済みの日に再度cronが走った場合も、
// 1〜3は実行してスナップショットを最新化する。
//
// 【失敗時の扱い】集計自体(Stripe/Redisの問い合わせ)が失敗した場合は送信も保存も
// 行わない(呼び出し側のcronが結果をログに残す)。個々の宛先への送信失敗は、
// 他の宛先への送信や呼び出し元の処理を止めない(宛先ごとにtry/catch)。

import { redis, redisKey } from './redis';
import { isJstMonday, jstDateOnlyString } from './dateMath';
import { PREFECTURES } from './prefectures';
import { buildActiveContractPrefectureStats, getPendingDeletionCount } from './contractStats';
import { saveWeeklySnapshot, getPreviousSnapshot, computeDiff } from './statsSnapshots';
import { getStatsViewerEmails } from './statsViewers';

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;
const WEEKLY_STATS_EMAIL_SUBJECT = '【経営統計】週次レポート';
const STATS_APP_URL = 'https://stats.ma-system.co.jp/';

function weeklyEmailSentKey(dateStr) {
  return redisKey('stats', 'weekly-email', 'sent', dateStr);
}

function formatDelta(delta) {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `${delta}`;
  return '±0';
}

function buildWeeklyStatsEmailText({ dateStr, current, pendingDeletion, diff, previousDate }) {
  const prefectureLines = PREFECTURES
    .filter((prefecture) => current.byPrefecture[prefecture])
    .map((prefecture) => {
      const count = current.byPrefecture[prefecture];
      if (!diff) return `${prefecture} ${count}件`;
      return `${prefecture} ${count}件(${formatDelta(diff.byPrefectureDelta[prefecture] || 0)})`;
    })
    .join('\n');

  const totalDeltaText = diff
    ? `（先週(${previousDate})から${formatDelta(diff.totalDelta)}）`
    : '（初回のため増減なし）';

  return `経営統計の週次レポートです（${dateStr}時点）。

■ 都道府県別の契約数（北から順。0件の都道府県は省略）
${prefectureLines || '（該当する契約がまだありません）'}

■ 合計
有効な契約：${current.total}件${totalDeltaText}
都道府県未登録：${current.unregistered}件
解約済み・削除待ち：${pendingDeletion}件

統計ページ：${STATS_APP_URL}（ログインが必要です）

――――――――――
エムエーシステム株式会社`;
}

async function sendWeeklyStatsEmail({ to, ...textParams }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        subject: WEEKLY_STATS_EMAIL_SUBJECT,
        text: buildWeeklyStatsEmailText(textParams),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error('[statsWeeklyEmail] Resendへのリクエストに失敗しました:', err.name, err.message);
    throw new Error('週次レポートの送信に失敗しました(リクエストエラー)');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch (e) {
      // Resendが非JSONを返した場合はステータスのみで組み立てる
    }
    console.error('[statsWeeklyEmail] Resendがエラーを返しました:', response.status, detail?.name, detail?.message);
    throw new Error(`週次レポートの送信に失敗しました(status: ${response.status})`);
  }
}

/**
 * 日次cronから呼ぶ。JST月曜でなければ何もしない。
 *
 * @param {{now?: number}} [options]
 * @returns {Promise<{
 *   ran: boolean,
 *   skippedReason?: 'not_monday' | 'already_sent_today',
 *   recipients: { succeeded: string[], failed: Array<{to: string, message: string}> },
 *   errors: Array<{step: string, message: string}>
 * }>}
 */
export async function runWeeklyStatsEmail({ now = Date.now() } = {}) {
  const result = { ran: false, recipients: { succeeded: [], failed: [] }, errors: [] };

  if (!isJstMonday(now)) {
    result.skippedReason = 'not_monday';
    return result;
  }

  const dateStr = jstDateOnlyString(now);

  let current;
  let pendingDeletion;
  try {
    current = await buildActiveContractPrefectureStats();
    pendingDeletion = await getPendingDeletionCount();
  } catch (err) {
    console.error('[statsWeeklyEmail] 集計に失敗しました:', err);
    result.errors.push({ step: 'aggregate', message: err.message });
    return result;
  }

  const previous = await getPreviousSnapshot(dateStr);
  const diff = computeDiff(current, previous);

  try {
    await saveWeeklySnapshot(dateStr, { ...current, pendingDeletion, capturedAt: now });
  } catch (err) {
    console.error('[statsWeeklyEmail] スナップショットの保存に失敗しました:', err);
    result.errors.push({ step: 'save-snapshot', message: err.message });
    // 保存に失敗しても、今日分の送信自体は試みる価値がある(レポート自体は届けたい)ため続行する。
  }

  result.ran = true;

  // 送信だけを送信済みの印で守る(ファイル冒頭のコメント参照)。
  const claimed = await redis.set(weeklyEmailSentKey(dateStr), '1', { nx: true });
  if (!claimed) {
    result.skippedReason = 'already_sent_today';
    return result;
  }

  const recipients = getStatsViewerEmails();
  for (const to of recipients) {
    try {
      await sendWeeklyStatsEmail({
        to,
        dateStr,
        current,
        pendingDeletion,
        diff,
        previousDate: previous?.date || null,
      });
      result.recipients.succeeded.push(to);
    } catch (err) {
      result.recipients.failed.push({ to, message: err.message });
    }
  }

  return result;
}
