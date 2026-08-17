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

// 【Stripeへの依存について】lib/cases.js が UNLIMITED / isUnlimited() のために
// lib/subscription.js を読むため、このcronもStripeクライアントの生成を巻き込む
// （subscription.js はトップレベルで Stripe() を生成し、キーが無いと構築時点で落ちる）。
// D-2ではステップ1で所有者のプランを実際に引くので、この依存は意図的なものになった。
// ステップ2(自動アーカイブ)はプランを引かない。理由は下のコメント参照。
import {
  STATUS,
  GLOBAL_OPEN_KEY,
  GLOBAL_TERMINAL_KEY,
  getCase,
  updateCaseStatus,
  archiveCase,
} from '../../lib/cases';
import { AUTO_LOSE_GRACE_DAYS, DAY_MS } from '../../lib/planLimits';
import { isUnlimited, getSubscriptionStateCached } from '../../lib/subscription';
import { redis } from '../../lib/redis';

export default async function handler(req, res) {
  // CRON_SECRET が未設定/空文字だと、比較対象の期待値が文字列
  // "Bearer undefined" に固定され、その文字列を送れば誰でも通ってしまう。
  // 環境変数が消えたときに「認証なし」側へ倒れるのを避けるため、
  // secret が無ければ比較する前に必ず401にする。
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[cron/process-cases] CRON_SECRET が未設定のため、リクエストを拒否しました');
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const now = Date.now();
  const results = {
    autoLost: [],
    deferred: [],   // プランを引けず、自動失注を次回に見送った案件
    archived: [],
    pruned: [],     // 実体が無いのにZSETに残っていた残骸（掃除した）
    // 「保持期間が不明」と「無期限で期限が来ない」は意味が違うので分けて数える。
    // noRetention は焼き込み(D-2)導入前に確定した案件の残数＝移行状況の指標で、
    // 時間とともに減っていくはずのもの。unlimited は無制限プランの正常な状態で、
    // ずっと残り続けるのが正しい。同じ数字に混ぜると前者の異常を後者が覆い隠す。
    skipped: { noRetention: 0, unlimited: 0 },
    errors: [],
  };

  // --- 1. 自動失注化 -------------------------------------------------
  // 失注・キャンセルは終了ステータスなので、ここでも retentionDays の焼き込みが要る。
  // 焼き込む値は所有者のプラン由来だが、対象は「30日動きがない案件」で日次では数件
  // （多くの日は0件）。所有者ごとにまとめて1回だけ引けば、Stripeへの往復はほぼ発生
  // しない(getSubscriptionStateCached はRedisに1時間キャッシュする)。
  // ステップ2でプランを引かない理由とは条件が違う（詳細はステップ2のコメント参照）。
  const loseThreshold = now - AUTO_LOSE_GRACE_DAYS * DAY_MS;
  const openCandidates = await redis.zrange(GLOBAL_OPEN_KEY, 0, loseThreshold, {
    byScore: true,
  });

  // 所有者ごとにグルーピング（同じ所有者で複数件あってもプラン取得は1回）
  const byOwner = new Map();
  for (const caseId of openCandidates) {
    try {
      const record = await getCase(caseId);
      if (!record) {
        // 案件の実体が無いのにZSETに残っている＝不整合の残骸。deleteCase()は
        // 両方消すので通常は発生しないが、途中で失敗した場合などに残りうる。
        // 放置すると毎回getCaseされ続けるので、ここで掃除する。
        await redis.zrem(GLOBAL_OPEN_KEY, caseId);
        results.pruned.push(caseId);
        continue;
      }
      if (!byOwner.has(record.email)) byOwner.set(record.email, []);
      byOwner.get(record.email).push(caseId);
    } catch (err) {
      console.error('[cron/process-cases] auto-lose lookup failed', caseId, err);
      results.errors.push({ caseId, step: 'auto-lose', message: err.message });
    }
  }

  for (const [email, caseIds] of byOwner) {
    let retentionDays;
    try {
      const { limits, degraded } = await getSubscriptionStateCached(email);
      if (degraded) {
        // Stripeに聞けなかっただけで、本当に無制限とは限らない。ここで既定値(-1)を
        // 焼き込むと「二度とアーカイブされない案件」が恒久的に残るため、ステータス
        // 変更ごと見送って次回のcronに回す（案件は開いたままなので実害はない）。
        console.warn(
          `[cron/process-cases] ${email} のプランを取得できなかったため、` +
            `自動失注を見送りました（対象 ${caseIds.length} 件）。次回のcronで再試行します。`
        );
        results.deferred.push(...caseIds);
        continue;
      }
      retentionDays = limits.retentionDays;
    } catch (err) {
      console.error('[cron/process-cases] plan lookup failed', email, err);
      results.errors.push({ email, step: 'plan-lookup', message: err.message });
      results.deferred.push(...caseIds);
      continue;
    }

    for (const caseId of caseIds) {
      try {
        await updateCaseStatus(caseId, STATUS.LOST, 'auto', { retentionDays });
        results.autoLost.push(caseId);
      } catch (err) {
        console.error('[cron/process-cases] auto-lose failed', caseId, err);
        results.errors.push({ caseId, step: 'auto-lose', message: err.message });
      }
    }
  }

  // --- 2. 自動アーカイブ化 -------------------------------------------
  // 【ここでは絶対にプランを引かない】ステップ1と扱いが違う理由:
  //   ステップ1の対象は「30日動きがない案件」で日次では数件（多くの日は0件）。
  //   ステップ2の対象は全アカウントにまたがり、しかも保持期間が切れた案件が同じ日に
  //   まとまって期限を迎えることがある（同じ日に完了した案件は同じ日に期限が来る）。
  //   ここで所有者を引くと、その日の対象件数に比例して問い合わせが増える。
  //   加えて「完了にした時点のプランの保持期間」で判定したいので、後からプランを
  //   変更しても確定済み案件の期限は動かさない。判定材料は案件へ焼き込んだ
  //   retentionDays だけにする。
  //
  // cases:terminal のスコアはアーカイブ予定時刻(statusUpdatedAt + retentionDays日)
  // なので、zrange(0, now) で期限が来たものだけが返る。無期限の案件と保持期間が
  // 不明な案件はそもそも登録されない。
  //
  // ただしD-2より前に確定した案件は、スコアが statusUpdatedAt（旧仕様）のまま
  // 入っている。新しい意味では「とっくに期限到来」と解釈されて毎回候補に挙がるが、
  // retentionDays を持たないので下の noRetention で弾かれる。ここが唯一の防壁。
  const terminalCandidates = await redis.zrange(GLOBAL_TERMINAL_KEY, 0, now, {
    byScore: true,
  });

  for (const caseId of terminalCandidates) {
    try {
      const record = await getCase(caseId);
      // 実体が消えている（物理削除済みなど）ZSETの残骸。ステップ1と同じく掃除する
      if (!record) {
        await redis.zrem(GLOBAL_TERMINAL_KEY, caseId);
        results.pruned.push(caseId);
        continue;
      }

      const { retentionDays } = record;

      // retentionDays を持たない案件はアーカイブ対象外。ここを「値が無い＝0日」と
      // 解釈すると完了/失注の案件が一斉に非表示になる。フィールドを持つのは
      // 焼き込み導入後に完了/失注へ遷移した案件だけで、それ以前の既存案件と、
      // 焼き込みを入れる前のデプロイで確定した案件はすべて undefined になる。
      // フォールバック値は入れず、明示的にスキップする。
      if (!Number.isInteger(retentionDays)) {
        results.skipped.noRetention++;
        continue;
      }

      // -1 は無制限。期限が来ないので何もしない。
      // （スコアの計算対象外なので通常はZSETに入っていないが、旧スコアのまま残って
      //   いる案件が無期限で再確定された場合などに備えてここでも弾く）
      if (isUnlimited(retentionDays)) {
        results.skipped.unlimited++;
        continue;
      }

      // 安全網。スコアは書き込み時点の予定時刻なので、焼き込んだ retentionDays を
      // あとから変えた場合や、旧スコアのまま残っている案件では実際の期限とズレうる。
      // レコード側を正としてもう一度判定する（スコアはあくまで走査を絞るための索引）。
      // statusUpdatedAt は完了/失注に確定した時刻。
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
