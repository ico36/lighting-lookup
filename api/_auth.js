// api/_auth.js
// login.jsが発行したセッショントークンを検証する共通ヘルパー
// ファイル名を _auth.js のように先頭にアンダースコアを付けておくと、
// Vercelがこれ自体を独立したAPIエンドポイントとして公開しないため安全です。

import crypto from 'crypto';
import { getSubscriptionStateCached } from '../lib/subscription';

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
 * 認証の実体。requireAuth() と requireAuthWithPlan() の共通部分。
 * 成功したら { email, limits, period }、失敗したらレスポンスを返した上で null。
 *
 * トークンの署名・有効期限に加えて、Stripeのサブスク状態も(Redisに短いTTLで
 * キャッシュしつつ)再チェックする。解約済みなのに古いセッショントークンが
 * 有効期限(30日)まで使えてしまう問題への対応。
 *
 * 管理者(ADMIN_EMAILS)の扱いは getSubscriptionStateCached() 側に集約されている
 * (Stripe顧客を持たないため、照会もキャッシュもせず「有効・全部無制限・期間なし」を
 * 即返す)。以前はここでも isAdminEmail() で早期リターンしていたが、同じ判定が
 * 2箇所にあると片方だけ直したときに管理者が締め出されるため、判定は
 * lib/subscription.js の1箇所だけに寄せている。
 */
async function authenticate(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length)
    : null;

  let email;
  try {
    email = verifySessionToken(token);
  } catch (err) {
    // SESSION_SECRET未設定・破損など設定不備が主な原因。詳細はログのみに残し、
    // クライアントには一貫したJSON形式のエラーのみ返す（生の500ページを防ぐ）。
    console.error('[auth] セッション検証中にエラーが発生しました（SESSION_SECRETの設定を確認してください）:', err);
    res.status(500).json({ error: '認証エラーが発生しました' });
    return null;
  }

  if (!email) {
    res.status(401).json({ error: 'ログインが必要です' });
    return null;
  }

  const { active, limits, period } = await getSubscriptionStateCached(email);
  if (!active) {
    res.status(401).json({ error: '認証エラーが発生しました' });
    return null;
  }

  return { email, limits, period };
}

/**
 * リクエストからトークンを取り出して検証し、
 * 無効なら401を返して null を返す補助関数。
 *
 * 【戻り値はメールアドレスの文字列のまま】プラン上限が要らないエンドポイントを
 * 一切変更しなくて済むよう、この関数のシグネチャは据え置いてある。
 * 戻り値をオブジェクトに変えたり、String オブジェクトに包んでプロパティを生やす
 * (`typeof` が 'object' になる)方法は採っていない。lib/redis.js の redisKey() が
 * パーツに文字列以外を渡されると例外にするため、包むと api/company.js や
 * lib/cases.js が実行時に落ちるのが理由。
 * 上限・請求期間も必要な場合は requireAuthWithPlan() を使うこと。
 *
 * 使い方（analyze.js や product-detail.js の冒頭に追加）:
 *
 *   import { requireAuth } from './_auth';
 *
 *   export default async function handler(req, res) {
 *     const email = await requireAuth(req, res);
 *     if (!email) return; // requireAuth内で既に401/500レスポンス済みなのでここで終了
 *
 *     // ここから先は認証済みの処理
 *     ...
 *   }
 */
export async function requireAuth(req, res) {
  const auth = await authenticate(req, res);
  return auth ? auth.email : null;
}

/**
 * requireAuth() と同じ認証を行い、契約中プランの上限と請求期間も返す。
 * 検索回数の上限判定など、プラン情報が要るエンドポイント向け。
 *
 *   import { requireAuthWithPlan } from './_auth';
 *
 *   export default async function handler(req, res) {
 *     const auth = await requireAuthWithPlan(req, res);
 *     if (!auth) return; // 既に401/500レスポンス済み
 *     const { email, limits, period } = auth;
 *     ...
 *   }
 *
 * limits は { plan, searchLimit, caseLimit, retentionDays }。数値は -1 が無制限で、
 * lib/subscription.js の isUnlimited() で判定する。
 * period は請求期間 { start, end }（ミリ秒エポック）で、取得できない場合は null。
 * null のときは「カウントしない・ブロックしない」で扱うこと（詳細は
 * lib/subscription.js の checkActiveSubscriptionLive() のコメントを参照）。
 *
 * @returns {Promise<{email: string, limits: {plan: string, searchLimit: number, caseLimit: number, retentionDays: number}, period: {start: number, end: number} | null} | null>}
 */
export async function requireAuthWithPlan(req, res) {
  return authenticate(req, res);
}
