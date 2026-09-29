// lib/ownerDeletion.js
// 「解約から6か月後の自動削除」。api/cron/process-cases.js のステップ3から呼ばれる
// (Vercel HobbyプランのFunction数上限12/12のため、新規APIエンドポイントは作れない。
// 既存cronへ統合する)。
//
// 【全体の流れ(2パス)】
//   discoverAndScheduleOwnerDeletions() ... 新規解約オーナーの発見。company:*・tos:*を
//     SCANして全オーナーを列挙し、まだ owner-deletion:schedule に登録されていない
//     オーナーだけ Stripe状態を確認する(登録済みオーナーは問い合わせない＝
//     「以降は期日が来た人だけ確認し直す」という決定Fを満たし、毎日全員分の
//     Stripe往復が積み上がるのを防ぐ)。解約済み/顧客なしなら削除予定日を登録する。
//   processDueOwnerDeletions() ... 期日が来たオーナーの処理。削除直前にキャッシュを
//     通さずStripeへ直接、かつ同一メールの全顧客を再確認する(決定E)。
//       - 有効/支払い遅延中の契約が見つかった → 再契約とみなし予定を取り消す
//       - 契約終了時刻が更新されていた(再契約→再解約) → その時刻+6か月へ
//         予定日を書き直して先送りする(削除しない・取り消しもしない)
//       - それ以外(期日到来・解約継続) → 削除(ドライラン時は対象を記録するだけ)
//
// 【Redisキー】
//   owner-deletion:schedule ... ZSET。member=email, score=削除予定時刻(ms epoch)。
//     TTLなし(cases:open/cases:terminalと同じ設計。取り消し時にzrem、削除完了時にも
//     zremする)。起点・理由などのメタデータは別キーに永続化せず、登録・更新のたびに
//     console.logへ出す(cases:terminalも案件本体を読み直すだけで専用メタを
//     持たないのと同じ方針)。

import { redis, redisKey } from './redis';
import { isAdminEmail } from './adminEmails';
import {
  getSubscriptionStateCached,
  resolveOwnerDeletionRecheck,
  OWNER_STATUS,
} from './subscription';
import { deleteCase, visibleKey, activeKey, archivedKey } from './cases';
import { extractEmailFromCompanyKey } from './companyStats';
import { extractEmailFromTosKey } from './legalConsent';
import { del as deleteBlob } from '@vercel/blob';

export const OWNER_DELETION_SCHEDULE_KEY = redisKey('owner-deletion', 'schedule');

// 利用規約第6条「解約日から6か月」に合わせる。暦月で加算する(addCalendarMonthsJST()参照)。
export const OWNER_DELETION_RETENTION_MONTHS = 6;

// 1回のcron実行で実削除(ドライランでの対象記録を含む)まで進めるオーナー数の上限。
// 期日到来のオーナーがこれを超える日があっても、超過分は翌日以降のcronへ持ち越す
// (「取り消し」「先送り」の判定だけの軽い処理は上限に含めない。重いのは
// 案件・Blobまで含めた削除本体のため)。
export const MAX_OWNER_DELETIONS_PER_RUN = 10;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 解約から自動削除までのドライラン切り替え。'false'という文字列と厳密一致した
 * ときだけ実削除にする(CRON_SECRETの「falsyなら安全側」とは対称的に、
 * こちらは「明示的にfalseでなければ安全側」。未設定・'true'・誤字は全てドライラン)。
 * 本番でこの機能を有効化する初期値は必ずドライランにする(決定C)。
 */
export function isOwnerDeletionDryRun() {
  return process.env.OWNER_DELETION_DRY_RUN !== 'false';
}

/**
 * Preview環境限定の実機確認用の猶予期間短縮(分)。暦6か月では確認に半年待たされる
 * ため、Previewでだけ「契約終了(NO_CUSTOMERは検知時刻)＋N分」に短縮できる。
 *
 * 【VERCEL_ENV==='preview'のときだけ読む】production/development/未設定では
 * 値が入っていても完全に無視する(誤って本番用の環境変数に設定してしまっても
 * 本番の6か月保持には一切影響しない設計にするため)。
 * 【正の整数のみ】0・負数・小数・数字以外はすべて無視してnullを返す
 * (無視した場合のフォールバックはresolveOwnerDeletionTargetDate()の暦6か月)。
 *
 * @returns {number|null}
 */
export function getOwnerDeletionPreviewGraceMinutes() {
  if (process.env.VERCEL_ENV !== 'preview') return null;

  const raw = process.env.OWNER_DELETION_PREVIEW_GRACE_MINUTES;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null; // 負数(-)・小数(.)・数字以外を弾く

  const value = Number(trimmed);
  return value > 0 ? value : null; // 0は無視
}

/**
 * 削除予定日(ms epoch)を計算する。起点(originMs)は契約終了時刻、または
 * NO_CUSTOMER時は検知時刻。Preview環境でOWNER_DELETION_PREVIEW_GRACE_MINUTESが
 * 有効なときだけ暦6か月の代わりにその分数を使う(discoverAndScheduleOwnerDeletions()の
 * 新規登録、processDueOwnerDeletions()の先送り再計算の両方から呼ぶ)。
 */
function resolveOwnerDeletionTargetDate(originMs) {
  const previewGraceMinutes = getOwnerDeletionPreviewGraceMinutes();
  if (previewGraceMinutes !== null) {
    return originMs + previewGraceMinutes * 60 * 1000;
  }
  return addCalendarMonthsJST(originMs, OWNER_DELETION_RETENTION_MONTHS);
}

/**
 * 猶予期間短縮が有効なときだけ、cronの実行ごとに1回console.warnで通知する。
 * api/cron/process-cases.js のステップ3から1回だけ呼ぶ想定(discover/process側の
 * オーナーごとのループでは呼ばない。ログが人数分積み上がるのを避けるため)。
 */
export function warnIfOwnerDeletionPreviewGraceEnabled() {
  const previewGraceMinutes = getOwnerDeletionPreviewGraceMinutes();
  if (previewGraceMinutes !== null) {
    console.warn(
      `[ownerDeletion] Preview環境向けの猶予期間の短縮が有効です` +
        `(OWNER_DELETION_PREVIEW_GRACE_MINUTES=${previewGraceMinutes}分)。` +
        '本番環境ではこの環境変数を絶対に設定しないこと。'
    );
  }
}

/**
 * 指定した日時(ms epoch)に暦月を加算する。JST(UTC+9、日本にDSTは無いため固定
 * オフセットで正しい)の日付として計算する。月末を跨ぐ加算で、加算先の月に
 * 存在しない日になる場合(例: 8/31 + 6か月 → 平年の2月には31日が無い)は、
 * その月の末日に丸める(2/28、閏年なら2/29。JSのDate.setMonth()に任せると
 * 3月へ繰り上がってしまう既知の挙動を避けるため、末日を計算してから
 * Date.UTC()で組み立て直す)。
 *
 * @param {number} epochMs
 * @param {number} months
 * @returns {number} 加算後のms epoch
 */
export function addCalendarMonthsJST(epochMs, months) {
  const jst = new Date(epochMs + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth(); // 0-based
  const day = jst.getUTCDate();
  const hours = jst.getUTCHours();
  const minutes = jst.getUTCMinutes();
  const seconds = jst.getUTCSeconds();
  const ms = jst.getUTCMilliseconds();

  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  // 加算先の月の末日(翌月0日目=末日という常套手段)。dayがこれを超えるなら丸める。
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  const resultJstMs = Date.UTC(targetYear, targetMonth, clampedDay, hours, minutes, seconds, ms);
  return resultJstMs - JST_OFFSET_MS;
}

async function scanKeysByPrefix(matchPattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, { match: matchPattern, count: 100 });
    keys.push(...batch);
    cursor = nextCursor;
  } while (String(cursor) !== '0');
  return keys;
}

/**
 * 全利用者一覧の代わり。company:*とtos:*をSCANしてメールアドレスの和集合を返す。
 * company:未設定(会社情報保存前にログイン解約した等)でtos:だけ残っているオーナーも
 * 削除予定のスキャン対象に含めるため、company:*だけでなくtos:*も見る。
 */
export async function discoverOwnerEmails() {
  const [companyKeys, tosKeys] = await Promise.all([
    scanKeysByPrefix(redisKey('company', '*')),
    scanKeysByPrefix(redisKey('tos', '*')),
  ]);
  const emails = new Set([
    ...companyKeys.map(extractEmailFromCompanyKey),
    ...tosKeys.map(extractEmailFromTosKey),
  ]);
  return [...emails];
}

/**
 * Pass 3a: 新規に解約済み/顧客なしと判明したオーナーの削除予定日を登録する。
 * 既に owner-deletion:schedule に登録済みのオーナーはStripeに問い合わせない
 * (F: 以降は期日が来た人だけ確認し直す)。
 */
export async function discoverAndScheduleOwnerDeletions() {
  const results = { scheduled: [], errors: [] };

  const [emails, alreadyScheduled] = await Promise.all([
    discoverOwnerEmails(),
    redis.zrange(OWNER_DELETION_SCHEDULE_KEY, 0, -1),
  ]);
  const scheduledSet = new Set(alreadyScheduled);

  for (const email of emails) {
    if (isAdminEmail(email)) continue;
    if (scheduledSet.has(email)) continue;

    try {
      const state = await getSubscriptionStateCached(email);
      if (state.degraded) continue; // UNKNOWN: 何もしない(要件5)

      if (state.status === OWNER_STATUS.CANCELED || state.status === OWNER_STATUS.NO_CUSTOMER) {
        // ended_atが取れない(NO_CUSTOMER、またはCANCELEDでも最後の契約候補が
        // 無い)場合は、検知した今の時刻を起点にする(要件4)。
        const origin = state.endedAt ?? Date.now();
        const deleteAt = resolveOwnerDeletionTargetDate(origin);
        await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: deleteAt, member: email });
        results.scheduled.push({ email, deleteAt });
        console.log(
          `[ownerDeletion] ${email} の削除予定を登録しました` +
            `(status=${state.status}, 起点=${new Date(origin).toISOString()}, ` +
            `予定日=${new Date(deleteAt).toISOString()})`
        );
      }
      // ACTIVE/ADMIN/PAST_DUE: 未登録オーナーなので取り消す予定も無く、何もしない。
    } catch (err) {
      console.error(`[ownerDeletion] ${email} の状態確認に失敗しました:`, err);
      results.errors.push({ email, step: 'discover', message: err.message });
    }
  }

  return results;
}

/**
 * 削除対象の中身を集める(読み取りのみ、副作用なし)。ドライラン・実削除の両方が
 * この関数の結果を使う(ドライランはログ・レスポンスに出すだけ、実削除は
 * executeOwnerDeletion()に渡す)。
 */
export async function collectOwnerDeletionTargets(email) {
  const [visibleIds, activeIds, archivedIds, company, tosConsent] = await Promise.all([
    redis.zrange(visibleKey(email), 0, -1),
    redis.zrange(activeKey(email), 0, -1),
    redis.zrange(archivedKey(email), 0, -1),
    redis.get(redisKey('company', email)),
    redis.get(redisKey('tos', email)),
  ]);

  const caseIds = [...new Set([...visibleIds, ...activeIds, ...archivedIds])];
  const logoUrl =
    company && typeof company === 'object' && typeof company.logoUrl === 'string' && company.logoUrl.trim() !== ''
      ? company.logoUrl.trim()
      : null;

  return { email, caseIds, hasCompany: !!company, hasTos: !!tosConsent, logoUrl };
}

/**
 * 実削除本体。Blobロゴ→案件→索引/company/tosの順で消す。
 *
 * 【Blob失敗の扱い(要確認①の合意)】Blobはcompanyを消す前に削除を試みる。
 * 失敗してもRedis側の削除は続行する(email・logoUrlをconsole.errorとエラー配列に
 * 残す。company削除後はlogoUrlが失われ再試行できないため、ここがログに残す
 * 最後の機会)。Blobだけの失敗であれば呼び出し側は owner-deletion:schedule を
 * zremしてよい(手作業でBlobを消す前提)。
 *
 * 【案件削除の冪等性】deleteCase()がCASE_NOT_FOUNDを投げた場合は「既に削除済み」
 * として成功扱いにする。前日の実行が案件削除まで終えた後にRedis側で失敗し、
 * 予定が残ったまま翌日再試行されるケースで、二重削除エラーにならないようにするため。
 *
 * @returns {Promise<Array<object>>} 発生したエラーの一覧(空なら全て成功)
 */
export async function executeOwnerDeletion(email, targets) {
  const errors = [];

  if (targets.logoUrl) {
    try {
      await deleteBlob(targets.logoUrl);
    } catch (err) {
      console.error(
        `[ownerDeletion] ${email} のロゴ削除に失敗しました(logoUrl=${targets.logoUrl}):`,
        err
      );
      errors.push({ email, step: 'blob-logo', logoUrl: targets.logoUrl, message: err.message });
    }
  }

  for (const caseId of targets.caseIds) {
    try {
      await deleteCase(caseId);
    } catch (err) {
      if (err.code === 'CASE_NOT_FOUND') continue; // 既に削除済み(再試行時の冪等性)
      console.error(`[ownerDeletion] ${email} の案件削除に失敗しました:`, caseId, err);
      errors.push({ email, step: 'case', caseId, message: err.message });
    }
  }

  try {
    await redis.del(visibleKey(email), activeKey(email), archivedKey(email));
    await redis.del(redisKey('company', email));
    await redis.del(redisKey('tos', email));
  } catch (err) {
    console.error(`[ownerDeletion] ${email} の索引/company/tos削除に失敗しました:`, err);
    errors.push({ email, step: 'redis-cleanup', message: err.message });
  }

  return errors;
}

/**
 * Pass 3b: 期日(score<=now)が来たオーナーを処理する。1回の呼び出しで最大
 * MAX_OWNER_DELETIONS_PER_RUN人まで(超過分は翌日以降のcronに残す。
 * owner-deletion:scheduleのscoreは変更しないので、翌日も同じ人がscore昇順の
 * 先頭付近に来て優先的に処理される)。
 *
 * @param {{now?: number}} options
 */
export async function processDueOwnerDeletions({ now = Date.now() } = {}) {
  const results = { canceled: [], postponed: [], deleted: [], dryRunTargets: [], errors: [] };
  const dryRun = isOwnerDeletionDryRun();

  const dueEmails = (
    await redis.zrange(OWNER_DELETION_SCHEDULE_KEY, 0, now, { byScore: true })
  ).slice(0, MAX_OWNER_DELETIONS_PER_RUN);

  for (const email of dueEmails) {
    let recheck;
    try {
      recheck = await resolveOwnerDeletionRecheck(email);
    } catch (err) {
      // Stripe障害等。予定は変更せず翌日再試行(要件5と同じ「statusが分からなければ何もしない」方針)。
      console.error(`[ownerDeletion] ${email} の削除直前の再確認に失敗しました:`, err);
      results.errors.push({ email, step: 'recheck', message: err.message });
      continue;
    }

    if (recheck.hasLiveOrPastDue) {
      // 再契約済み(または支払い遅延中で契約継続中)。削除を取り消す。
      await redis.zrem(OWNER_DELETION_SCHEDULE_KEY, email);
      results.canceled.push(email);
      console.log(`[ownerDeletion] ${email} は再契約が確認できたため削除予定を取り消しました`);
      continue;
    }

    if (recheck.latestEndedAt !== null) {
      // 「解約→予定登録→再契約→再解約」で契約終了日が更新されているケースに
      // 対応する。最新のended_atから予定日を計算し直し、まだ未来なら先送りする
      // (削除しない・取り消しもしない)。
      const recomputedDeleteAt = resolveOwnerDeletionTargetDate(recheck.latestEndedAt);
      if (recomputedDeleteAt > now) {
        await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: recomputedDeleteAt, member: email });
        results.postponed.push({ email, newDeleteAt: recomputedDeleteAt });
        console.log(
          `[ownerDeletion] ${email} は契約終了日が更新されていたため削除予定を先送りしました` +
            `(新しい予定日=${new Date(recomputedDeleteAt).toISOString()})`
        );
        continue;
      }
    }

    const targets = await collectOwnerDeletionTargets(email);

    if (dryRun) {
      const entry = {
        email,
        caseCount: targets.caseIds.length,
        caseIds: targets.caseIds,
        hasCompany: targets.hasCompany,
        hasTos: targets.hasTos,
        logoUrl: targets.logoUrl,
      };
      results.dryRunTargets.push(entry);
      console.log(
        `[ownerDeletion] (dry-run) ${email} は削除対象: 案件${targets.caseIds.length}件, ` +
          `company=${targets.hasCompany}, tos=${targets.hasTos}, logo=${targets.logoUrl ? 'あり' : 'なし'}`
      );
      continue;
    }

    const execErrors = await executeOwnerDeletion(email, targets);
    results.errors.push(...execErrors);

    // Blob単体の失敗は続行してよい(要確認①の合意)。Redis側(case/redis-cleanup)の
    // 失敗が1つでもあれば、予定を残して翌日再試行する。
    const hasNonBlobFailure = execErrors.some((e) => e.step !== 'blob-logo');
    if (hasNonBlobFailure) {
      console.error(`[ownerDeletion] ${email} の削除が一部失敗したため、予定を残して翌日再試行します`);
      continue;
    }

    await redis.zrem(OWNER_DELETION_SCHEDULE_KEY, email);
    results.deleted.push(email);
    console.log(`[ownerDeletion] ${email} のデータを削除しました(案件${targets.caseIds.length}件)`);
  }

  return results;
}
