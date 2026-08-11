// lib/quota.js
// 検索回数（api/analyze.js の1回の調査）のカウントと上限判定。
//
// 上限値そのものはこのファイルに持たない。Stripe の Price metadata から
// lib/subscription.js が解決した limits.searchLimit を呼び出し側が渡す
// （プランの数値をコードに書かない方針。lib/subscription.js の冒頭コメント参照）。
//
// 【カウンタのキー】redisKey('quota', email, String(period.start))
// 請求期間の開始時刻をキーに含めるため、期間が切り替わると自動的に新しいキー＝0から
// 数え直しになる（リセット処理や cron は不要）。逆に言うと「期間内のプラン変更では
// 使用済み回数が引き継がれる」＝上位プランへ変更しても、その期間にすでに使った回数は
// 消えない。これは仕様（同一期間内での上限リセット目的の乗り換えを防ぐ）。
//
// 【フェイルオープン】Redis が落ちている・タイムアウトしたときは
// 「数えない・ブロックしない」で通す。lib/subscription.js が Stripe 障害時に
// 有効扱いで通すのと同じ方針で、電気工事士が現場作業中に使うツールである以上、
// インフラの一時的な不調で作業を止める実害の方が大きいという判断。
//
// period が null（請求期間を取得できなかった）ときも同じくカウントしない。
// null になる4つのケースは lib/subscription.js の checkActiveSubscriptionLive() の
// コメントを参照。

import { redis, redisKey } from './redis';
import { isUnlimited } from './subscription';

// カウンタのTTLに足す猶予。請求期間の終了ちょうどで消すと、Stripe側の期間更新と
// こちらの時計のわずかなズレや、getSubscriptionStateCached() のキャッシュ（最大1時間）で
// 古い期間が返ってきた場合に、まだ参照されうるキーを先に消してしまう。
// 1週間残しておけば安全側で、期間が変わればキー自体が変わるので実害はない。
const COUNTER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function quotaKey(email, period) {
  // period.start はミリ秒エポックの数値。redisKey() は数値も受けるが、
  // 「キーの一部は文字列」という前提を崩さないようここで明示的に文字列化する。
  return redisKey('quota', email, String(period.start));
}

/**
 * カウントの対象になる状態か（＝有限の上限と請求期間がそろっているか）。
 * limits が壊れている（想定外の形）場合もカウント対象外＝通す側に倒す。
 */
function isCountable(limits, period) {
  if (!period || !Number.isFinite(period.start) || !Number.isFinite(period.end)) return false;
  if (!limits || !Number.isInteger(limits.searchLimit)) return false;
  if (isUnlimited(limits.searchLimit)) return false;
  return true;
}

/**
 * 検索1回分の枠を確保する。Anthropic を呼ぶ直前に呼び出すこと。
 *
 * 先にINCRしてから上限を超えていたらDECRで戻す（読んでから書くのではなく）。
 * サーバーレス関数は同じ利用者のリクエストが並行で走りうるため、
 * GET→比較→INCR の順だと同時実行で上限を超えて通ってしまう。
 * INCR の戻り値で判定すれば、並行しても「上限を超えた側だけが弾かれる」。
 *
 * @param {{email: string, limits: {plan: string, searchLimit: number}, period: {start: number, end: number} | null}} args
 * @returns {Promise<{allowed: boolean, counted: boolean, used?: number, limit?: number, resetAt?: number}>}
 *   counted が true のときだけ、処理が失敗した場合に releaseSearch() で戻す必要がある。
 */
export async function reserveSearch({ email, limits, period }) {
  if (!isCountable(limits, period)) {
    // 無制限プラン・管理者・請求期間なし。数えないしブロックもしない。
    return { allowed: true, counted: false };
  }

  const limit = limits.searchLimit;
  const key = quotaKey(email, period);

  let used;
  try {
    used = await redis.incr(key);
  } catch (err) {
    console.warn('[quota] カウンタの更新に失敗しました。この検索は数えずに通します:', err);
    return { allowed: true, counted: false };
  }

  if (used === 1) {
    // 期間内で最初の1回のときだけ有効期限を設定する。毎回設定すると
    // 「請求期間より後まで残り続ける」ことはないが、無駄な往復が増えるため。
    try {
      await redis.pexpireat(key, period.end + COUNTER_GRACE_MS);
    } catch (err) {
      // 有効期限が付かなかったキーはRedisに残り続けるが、期間が変わればキー名自体が
      // 変わるので上限判定は正しく動く。ゴミが残るだけなのでwarnにとどめる。
      console.warn('[quota] カウンタの有効期限設定に失敗しました（キーが残り続けます）:', err);
    }
  }

  if (used > limit) {
    // 上限超過。確保できなかったので自分が増やした分を戻す。
    try {
      await redis.decr(key);
    } catch (err) {
      // 戻せなくてもカウンタが1多いまま次の期間で消えるだけ。上限判定の結果
      // （＝ブロックする）は変えない。ここでフェイルオープンにすると、Redisが
      // 半端に動いているときに上限を超えて通ってしまう。
      console.warn('[quota] 超過分のカウンタ復元に失敗しました:', err);
    }
    return { allowed: false, counted: false, used: limit, limit, resetAt: period.end };
  }

  return { allowed: true, counted: true, used, limit, resetAt: period.end };
}

/**
 * 確保した枠を返す。Anthropic 呼び出しなどが失敗して検索が成立しなかったときに呼ぶ。
 * reserveSearch() が counted: false を返していたときは何もしない
 * （そもそも数えていないので戻す対象がない）。
 *
 * @param {{email: string, period: {start: number, end: number} | null, counted: boolean}} args
 */
export async function releaseSearch({ email, period, counted }) {
  if (!counted) return;
  if (!period || !Number.isFinite(period.start)) return;

  const key = quotaKey(email, period);

  try {
    const remaining = await redis.decr(key);
    if (remaining < 0) {
      // 想定外（二重解放や期間切り替わり直後のずれ）。負の値のまま残すと
      // 上限まで数える回数が増えてしまうので0に戻す。
      await redis.incr(key);
    }
  } catch (err) {
    // 戻せなかった＝利用者の残り回数が1回分減ったままになる。現場を止めるほどでは
    // ないのでログのみ。呼び出し側（エラー処理中）に例外を伝播させない。
    console.warn('[quota] カウンタの復元に失敗しました:', err);
  }
}

/**
 * 現在の使用状況を読むだけ（カウントは増やさない）。ログイン直後や画面復帰時に
 * 「残り○回」を表示するために使う。
 *
 * @param {{email: string, limits: {plan: string, searchLimit: number}, period: {start: number, end: number} | null}} args
 * @returns {Promise<{plan: string, unlimited: boolean, used?: number, limit?: number, remaining?: number, resetAt?: number}>}
 *   unlimited: true のときは回数を返さない（表示しない）。
 */
export async function readQuota({ email, limits, period }) {
  const plan = typeof limits?.plan === 'string' ? limits.plan : 'unknown';

  if (!isCountable(limits, period)) {
    return { plan, unlimited: true };
  }

  const limit = limits.searchLimit;

  let used;
  try {
    const raw = await redis.get(quotaKey(email, period));
    used = Number(raw);
    if (!Number.isFinite(used) || used < 0) used = 0;
  } catch (err) {
    // 読めないだけなら「残り回数の表示を出さない」に倒す（reserveSearch() 側の
    // フェイルオープンと同じで、利用者をブロックはしない）。
    console.warn('[quota] 使用状況の読み取りに失敗しました:', err);
    return { plan, unlimited: true };
  }

  return {
    plan,
    unlimited: false,
    used: Math.min(used, limit),
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: period.end,
  };
}

/**
 * reserveSearch() の戻り値を、APIレスポンスに載せる quota オブジェクトに変換する。
 * フロント（public/index.html）は readQuota() の戻り値と同じ形を期待しているので、
 * 検索成功時のレスポンスもこの関数を通して形をそろえる。
 *
 * counted: false（無制限・期間なし・Redis障害）のときは unlimited: true になり、
 * フロントは残り回数の表示を出さない。
 */
export function quotaFromReservation(reservation, limits) {
  const plan = typeof limits?.plan === 'string' ? limits.plan : 'unknown';

  if (!reservation?.counted) {
    return { plan, unlimited: true };
  }

  return {
    plan,
    unlimited: false,
    used: reservation.used,
    limit: reservation.limit,
    remaining: Math.max(0, reservation.limit - reservation.used),
    resetAt: reservation.resetAt,
  };
}
