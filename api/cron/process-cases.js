// api/cron/process-cases.js
// 日次で実行するバッチ処理。
//   1. 承認待ち/承認済みのまま AUTO_LOSE_GRACE_DAYS 日動きがない案件を
//      自動的に「失注・キャンセル」にする
//   2. 完了/失注・キャンセルになってから retentionDays 日を超えた案件を
//      自動的にアーカイブ(非表示)にする
//      （現状 retentionDays は無制限のため、実質2は動作しない）
//
// vercel.json の crons 設定で毎日1回叩く。Vercel Cron以外からの
// 呼び出しは CRON_SECRET で拒否する（Vercel環境変数への追加が必要）。

import {
  STATUS,
  GLOBAL_OPEN_KEY,
  GLOBAL_TERMINAL_KEY,
  updateCaseStatus,
  archiveCase,
} from '../../lib/cases';
import { CASE_LIMITS, AUTO_LOSE_GRACE_DAYS } from '../../lib/planLimits';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const now = Date.now();
  const results = { autoLost: [], archived: [], errors: [] };

  // --- 1. 自動失注化 -------------------------------------------------
  const loseThreshold = now - AUTO_LOSE_GRACE_DAYS * DAY_MS;
  const openCandidates = await redis.zrange(GLOBAL_OPEN_KEY, 0, loseThreshold, {
    byScore: true,
  });

  for (const caseId of openCandidates) {
    try {
      await updateCaseStatus(caseId, STATUS.LOST, 'auto');
      results.autoLost.push(caseId);
    } catch (err) {
      console.error('[cron/process-cases] auto-lose failed', caseId, err);
      results.errors.push({ caseId, step: 'auto-lose', message: err.message });
    }
  }

  // --- 2. 自動アーカイブ化 -------------------------------------------
  if (Number.isFinite(CASE_LIMITS.retentionDays)) {
    const terminalThreshold = now - CASE_LIMITS.retentionDays * DAY_MS;
    const terminalCandidates = await redis.zrange(GLOBAL_TERMINAL_KEY, 0, terminalThreshold, {
      byScore: true,
    });

    for (const caseId of terminalCandidates) {
      try {
        await archiveCase(caseId);
        results.archived.push(caseId);
      } catch (err) {
        console.error('[cron/process-cases] auto-archive failed', caseId, err);
        results.errors.push({ caseId, step: 'auto-archive', message: err.message });
      }
    }
  }

  return res.status(200).json(results);
}
