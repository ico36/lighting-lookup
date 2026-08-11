// api/cron/process-cases.js
// 日次で実行するバッチ処理。
//   1. 承認待ち/承認済みのまま AUTO_LOSE_GRACE_DAYS 日動きがない案件を
//      自動的に「失注・キャンセル」にする
//   2. 完了/失注・キャンセルになってから retentionDays 日を超えた案件を
//      自動的にアーカイブ(非表示)にする
//
// 【2で見るのは案件に焼き込まれた retentionDays だけ】所有者のプランは引かない。
// 走査対象は全アカウントの完了/失注案件なので、ここでプランを引くと案件数だけ
// Stripe/Redisへの問い合わせが発生する。また「完了にした時点のプランの保持期間」で
// 判定したいので、あとからプランを変更しても既に確定した案件の期限は動かさない。
// 焼き込みは lib/cases.js のステータス変更時に行う。
//
// vercel.json の crons 設定で毎日1回叩く。Vercel Cron以外からの
// 呼び出しは CRON_SECRET で拒否する（Vercel環境変数への追加が必要）。

import {
  STATUS,
  GLOBAL_OPEN_KEY,
  GLOBAL_TERMINAL_KEY,
  getCase,
  updateCaseStatus,
  archiveCase,
} from '../../lib/cases';
import { AUTO_LOSE_GRACE_DAYS } from '../../lib/planLimits';
import { isUnlimited } from '../../lib/subscription';
import { redis } from '../../lib/redis';

const DAY_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const now = Date.now();
  const results = { autoLost: [], archived: [], skipped: 0, errors: [] };

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
  // 保持期間は案件ごとに異なる（完了/失注にした時点のプランの retention_days を
  // 焼き込んである）ため、ZSETのスコアで一律に絞り込むことができない。完了/失注の
  // 案件を全件走査し、1件ずつ自分の retentionDays と突き合わせる。
  // 利用者が数名規模で完了案件も多くないため全件走査で足りる。件数が増えて重く
  // なった場合は、焼き込み時に「アーカイブ予定時刻」をスコアにした別のZSETを
  // 持たせる方が素直（保持期間ごとにキーを分ける必要がなくなる）。
  const terminalCandidates = await redis.zrange(GLOBAL_TERMINAL_KEY, 0, now, {
    byScore: true,
  });

  for (const caseId of terminalCandidates) {
    try {
      const record = await getCase(caseId);
      // 実体が消えている（物理削除済みなど）ものはZSETの残骸なので触らない
      if (!record) continue;

      const { retentionDays } = record;

      // retentionDays を持たない案件はアーカイブ対象外。ここを「値が無い＝0日」と
      // 解釈すると完了/失注の案件が一斉に非表示になる。フィールドを持つのは
      // 焼き込み導入後に完了/失注へ遷移した案件だけで、それ以前の既存案件と、
      // 焼き込みを入れる前のデプロイで確定した案件はすべて undefined になる。
      // フォールバック値は入れず、明示的にスキップする。
      if (!Number.isInteger(retentionDays)) {
        results.skipped++;
        continue;
      }

      // -1 は無制限。期限が来ないので何もしない。
      if (isUnlimited(retentionDays)) {
        results.skipped++;
        continue;
      }

      // statusUpdatedAt は完了/失注に確定した時刻（GLOBAL_TERMINAL_KEY のスコアと同じ）
      if (record.statusUpdatedAt > now - retentionDays * DAY_MS) continue;

      await archiveCase(caseId);
      results.archived.push(caseId);
    } catch (err) {
      console.error('[cron/process-cases] auto-archive failed', caseId, err);
      results.errors.push({ caseId, step: 'auto-archive', message: err.message });
    }
  }

  return res.status(200).json(results);
}
