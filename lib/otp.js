// lib/otp.js
// OTPログインの、Redisに触れる部分だけを切り出したモジュール。
// メール送信(lib/otpMail.js)・APIのレート制限やレスポンス組み立て(api/login.js)は
// 一切扱わない。ここにあるのは「コードの生成・ハッシュ化・保存・検証・削除」だけ。
//
// Redisキー(いずれも lib/redis.js の redisKey() 経由。Preview環境では preview: 接頭辞):
//   otp:{email}           ... { hash, createdAt } を OTP_TTL_SECONDS で保存
//   otp:attempts:{email}  ... 検証失敗回数のカウンタ。otp:{email} と同時に 0 で作り、
//                             同じ TTL を持たせる(request-otp側の storeOtp() でまとめて作る。
//                             verify-otp側の INCR 任せにすると、同時作成でない分だけ
//                             2キーのTTLがズレる余地が生まれるため)
//   otp:cooldown:{email}  ... 再送クールダウン(OTP_RESEND_COOLDOWN_SECONDS)の目印
//
// ハッシュ方式は api/_auth.js のセッショントークン・lib/upgradeQuote.js の見積トークンと
// 同じ SESSION_SECRET の HMAC-SHA256。新しい鍵は増やさない(漏洩時の影響範囲は
// セッショントークン自体の偽造と同等になるため、鍵を分けても防御は増えない)。

import crypto from 'crypto';
import { redis, redisKey } from './redis';

export const OTP_TTL_SECONDS = 600; // 10分
export const OTP_LENGTH = 6;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

function otpKey(email) {
  return redisKey('otp', email);
}

function attemptsKey(email) {
  return redisKey('otp', 'attempts', email);
}

function cooldownKey(email) {
  return redisKey('otp', 'cooldown', email);
}

// crypto.randomInt(0, 1_000_000) は [0, 1000000) を一様分布で返す。
// 先頭ゼロが多く出ること自体は仕様上問題ない(6桁固定にpadStartで揃えるだけ)。
export function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0');
}

export function hashOtpCode(email, code) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(`${email}:${code}`)
    .digest('hex');
}

// 利用者が手入力するコードの正規化。全角数字を半角化し、空白・ハイフンを除去した上で
// 6桁の数字ちょうどかを見る。合わなければ null を返し、呼び出し側で400にする
// (この時点では otp:{email} に一切触れていないので、attempts は増やさない)。
export function normalizeOtpCode(raw) {
  if (typeof raw !== 'string') return null;
  const halfWidth = raw
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s-]/g, '');
  return /^\d{6}$/.test(halfWidth) ? halfWidth : null;
}

// otp:{email} と otp:attempts:{email} を同時に作る。TTLを完全に揃えるため
// pipeline で1回にまとめる(lib/cases.js と同じ流儀)。
export async function storeOtp(email, hash) {
  await redis
    .pipeline()
    .set(otpKey(email), { hash, createdAt: Date.now() }, { ex: OTP_TTL_SECONDS })
    .set(attemptsKey(email), 0, { ex: OTP_TTL_SECONDS })
    .exec();
}

export async function readOtp(email) {
  return redis.get(otpKey(email));
}

// 失敗回数を1増やして返す。storeOtp() で先に otp:attempts:{email} が
// 作られている前提だが、万一欠けていた場合の保険として、INCRの結果が1なら
// その場でTTLを付け直す(api/login.js の既存レート制限と同じ「INCR→初回だけEXPIRE」)。
export async function incrementOtpAttempts(email) {
  const key = attemptsKey(email);
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, OTP_TTL_SECONDS);
  }
  return attempts;
}

// otp:{email}・otp:attempts:{email}・otp:cooldown:{email} をまとめて削除する。
// 照合成功時・試行回数超過時・メール送信失敗時のロールバックのすべてで使う。
// クールダウンも一緒に消すのは、試行回数超過や送信失敗の直後に60秒待たせず
// すぐ再要求できるようにするため。
export async function clearOtpState(email) {
  await redis.del(otpKey(email), attemptsKey(email), cooldownKey(email));
}

export async function canResendOtp(email) {
  const cooldown = await redis.get(cooldownKey(email));
  return !cooldown;
}

export async function markOtpSent(email) {
  await redis.set(cooldownKey(email), 1, { ex: OTP_RESEND_COOLDOWN_SECONDS });
}
