// api/stats/_auth.js
// 経営統計ページ(stats.ma-system.co.jp)専用のセッション検証。
// ファイル名を _auth.js のように先頭にアンダースコアを付けておくと、Vercelが
// これ自体を独立したAPIエンドポイントとして公開しないため安全(api/_auth.jsと同じ命名規則)。
//
// 【照明サーチ本体のapi/_auth.jsとは別実装にしている理由】
//   - 署名鍵が別(STATS_SESSION_SECRET。本体のSESSION_SECRETは再利用しない)。
//     統計用トークンが本体で通ったり、本体のトークンが統計で通ったりしないように
//     するため(別々のテストで固定している)。
//   - 本体のauthenticate()はgetSubscriptionStateCached()でStripeへ再チェックするが、
//     統計ビューアはStripe契約を持たないため不要(呼んでも無駄な問い合わせになる)。
//     ここではisStatsViewerEmail()(環境変数の文字列比較のみ)だけを見る。
//
// 【STATS_SESSION_SECRET未設定時の扱い】fail-closed。トークンの発行・検証の
// どちらも、未設定なら「失敗」側に倒す(api/cron/process-cases.jsのCRON_SECRET
// チェックと同じ考え方)。

import crypto from 'crypto';
import { isStatsViewerEmail } from '../../lib/statsViewers';

const STATS_SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // 30日(本体と同じ長さ)

/**
 * email + 有効期限をSTATS_SESSION_SECRETで署名したトークンを発行する。
 * STATS_SESSION_SECRET未設定時は例外を投げる(呼び出し側で500にする)。
 */
export function createStatsSessionToken(email) {
  if (!process.env.STATS_SESSION_SECRET) {
    throw new Error('STATS_SESSION_SECRET が未設定です');
  }
  const expiresAt = Date.now() + STATS_SESSION_DURATION_SECONDS * 1000;
  const payload = `${email}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', process.env.STATS_SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

/**
 * トークンを検証し、有効なら email を返す。無効・STATS_SESSION_SECRET未設定なら null。
 */
export function verifyStatsSessionToken(token) {
  if (!process.env.STATS_SESSION_SECRET) return null;
  if (!token || typeof token !== 'string') return null;

  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }

  const parts = decoded.split(':');
  if (parts.length !== 3) return null;

  const [email, expiresAtStr, signature] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!email || !expiresAt || !signature) return null;

  if (Date.now() > expiresAt) return null;

  const payload = `${email}:${expiresAtStr}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.STATS_SESSION_SECRET)
    .update(payload)
    .digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return null;
  }

  return email;
}

/**
 * リクエストからトークンを取り出して検証し、許可リスト(STATS_VIEWER_EMAILS)にも
 * 含まれていることを確認する。無効なら401(STATS_SESSION_SECRET未設定なら500)を
 * 返してnullを返す。
 *
 *   import { requireStatsAuth } from './_auth';
 *
 *   export default async function handler(req, res) {
 *     const email = await requireStatsAuth(req, res);
 *     if (!email) return; // 既に401/500レスポンス済み
 *     ...
 *   }
 */
export async function requireStatsAuth(req, res) {
  if (!process.env.STATS_SESSION_SECRET) {
    console.error('[stats-auth] STATS_SESSION_SECRET が未設定のため、リクエストを拒否しました');
    res.status(500).json({ error: '統計ページの設定が完了していません' });
    return null;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  const email = verifyStatsSessionToken(token);
  if (!email || !isStatsViewerEmail(email)) {
    res.status(401).json({ error: 'ログインが必要です' });
    return null;
  }

  return email;
}
