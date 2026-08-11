// lib/responses.js
// プラン上限に達したときのエラーレスポンスボディを組み立てる。
//
// 【なぜ1箇所に集めるか】
// 検索回数(工程C)では api/analyze.js が429のボディを手組みしており、
// quotaFromReservation() を通っていなかったため、成功時の quota には
// unlimited / remaining があるのに429の quota には無い、という形の食い違いが
// 生まれた。フロント側はその差を吸収する分岐を持つ羽目になっている。
// 上限系のボディはこのファイルの関数だけが組み立て、ハンドラ側では手組みしない。
//
// quota オブジェクト自体の形は lib/quota.js の buildQuota() が唯一の出所。
// ここはその外側の封筒（error コード・利用者向けメッセージ）だけを担当する。

import { quotaFromReservation } from './quota';

/**
 * 検索回数が上限に達したときの429ボディ。
 *
 * 【message はフォールバック】ブラウザはこの文言を表示しない。public/index.html の
 * 429ハンドラは quota だけを取り込み、renderQuota() が quota.used / limit / resetAt
 * から「検索回数が上限に達しました（2/2回）。次回のリセットは9月11日です。」を
 * 組み立てて専用領域に出す。ここの固定文言は、回数を組み立てられない場合や
 * ブラウザ以外からエンドポイントを叩いたときに、コードだけが返る状態を避けるためのもの。
 *
 * quota.resetAt はミリ秒エポックのまま返す（日付の整形はフロント側の責務。
 * 端末のタイムゾーン設定に関わらずJSTで表示するため、public/index.html の
 * formatQuotaResetDate() で Asia/Tokyo 固定にしている）。
 *
 * @param {object} reservation reserveSearch() の戻り値（allowed: false のもの）
 * @param {{plan: string}} limits requireAuthWithPlan() が返す limits
 */
export function quotaExceededBody(reservation, limits) {
  return {
    error: 'quota_exceeded',
    message: '検索回数が上限に達しました。',
    quota: quotaFromReservation(reservation, limits),
  };
}
