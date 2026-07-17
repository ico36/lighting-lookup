// api/_auth.js
// login.jsが発行したセッショントークンを検証する共通ヘルパー
// ファイル名を _auth.js のように先頭にアンダースコアを付けておくと、
// Vercelがこれ自体を独立したAPIエンドポイントとして公開しないため安全です。

import crypto from 'crypto';

/**
 * トークンを検証し、有効なら email を返す。無効なら null を返す。
 */
export function verifySessionToken(token) {
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

  // 有効期限チェック
  if (Date.now() > expiresAt) return null;

  // 署名チェック（login.js発行時と同じ計算をして一致するか確認）
  const payload = `${email}:${expiresAtStr}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
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
 * リクエストからトークンを取り出して検証し、
 * 無効なら401を返して null を返す補助関数。
 *
 * 使い方（analyze.js や product-detail.js の冒頭に追加）:
 *
 *   import { requireAuth } from './_auth';
 *
 *   export default async function handler(req, res) {
 *     const email = requireAuth(req, res);
 *     if (!email) return; // requireAuth内で既に401レスポンス済みなのでここで終了
 *
 *     // ここから先は認証済みの処理
 *     ...
 *   }
 */
export function requireAuth(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;

  const email = verifySessionToken(token);

  if (!email) {
    res.status(401).json({ error: 'ログインが必要です' });
    return null;
  }

  return email;
}
