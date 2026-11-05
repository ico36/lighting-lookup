// api/stats/login.js
// 経営統計ページ(stats.ma-system.co.jp)専用のOTPログインAPI。
// action(request-otp / verify-otp)で処理を分岐する。api/login.js(照明サーチ本体)と
// 同じ構造だが、以下の点が異なる:
//
//   - 契約の有効性ではなく、許可リスト(STATS_VIEWER_EMAILS、lib/statsViewers.js)を見る。
//   - 【許可リストに無いアドレスにはコードを送らないが、応答は常に同じ形にする】
//     request-otpは許可リストの有無に関わらず常に { success: true, mode: 'otp' } を
//     返す。クールダウン(canResendOtp/markOtpSent)も許可リストの有無に関わらず
//     必ず同じタイミングで設定する。ここで分岐すると、短時間に連続リクエストした
//     ときの応答(2回目が429になるかどうか)の違いから、そのアドレスが許可リストに
//     あるかどうかが外部から分かってしまうため。
//   - OTPの保存(lib/otp.js)はnamespace:'stats-otp'を使い、照明サーチ本体の
//     ログイン(namespace指定なし="otp")とクールダウン・試行回数カウンタが
//     独立する(お互いに影響しない)。
//   - セッショントークンはapi/stats/_auth.jsのcreateStatsSessionToken()
//     (STATS_SESSION_SECRET署名)を使う。本体のSESSION_SECRETは使わない。
//
// 必要な環境変数: STATS_VIEWER_EMAILS, STATS_SESSION_SECRET, RESEND_API_KEY, MAIL_FROM
//
// Redisキー:
//   ratelimit:stats-otp-request:email:{email} / :ip:{ip} ... request-otp のレート制限
//   ratelimit:stats-otp-verify:email:{email} / :ip:{ip}   ... verify-otp のレート制限
//   stats-otp:{email} / stats-otp:attempts:{email} / stats-otp:cooldown:{email}
//     ... lib/otp.js参照(namespace:'stats-otp')

import crypto from 'crypto';
import { redisKey } from '../../lib/redis';
import { getClientIp, checkRateLimit } from '../../lib/rateLimit';
import { isStatsViewerEmail } from '../../lib/statsViewers';
import {
  OTP_MAX_ATTEMPTS,
  generateOtpCode,
  hashOtpCode,
  normalizeOtpCode,
  storeOtp,
  readOtp,
  incrementOtpAttempts,
  clearOtpState,
  canResendOtp,
  markOtpSent,
} from '../../lib/otp';
import { sendStatsOtpEmail } from '../../lib/statsOtpMail';
import { createStatsSessionToken } from './_auth';

const OTP_NAMESPACE = 'stats-otp';

const OTP_REQUEST_LIMIT_EMAIL = 10;
const OTP_REQUEST_LIMIT_IP = 40;
const OTP_REQUEST_WINDOW_SECONDS = 60 * 60; // 1時間

const OTP_VERIFY_LIMIT_EMAIL = 10;
const OTP_VERIFY_WINDOW_EMAIL_SECONDS = 60 * 60 * 24; // 24時間
const OTP_VERIFY_LIMIT_IP = 30;
const OTP_VERIFY_WINDOW_IP_SECONDS = 60 * 60; // 1時間

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function getNormalizedEmailOrNull(req, res) {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
    return null;
  }
  return normalizeEmail(email);
}

async function handleRequestOtp(req, res) {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    console.error('[stats-login] RESEND_API_KEY または MAIL_FROM が未設定です');
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }

  const normalizedEmail = getNormalizedEmailOrNull(req, res);
  if (!normalizedEmail) return;

  const ip = getClientIp(req);
  const emailOk = await checkRateLimit(
    redisKey('ratelimit', 'stats-otp-request', 'email', normalizedEmail),
    OTP_REQUEST_LIMIT_EMAIL,
    OTP_REQUEST_WINDOW_SECONDS
  );
  if (!emailOk) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく時間をおいて再度お試しください' });
  }
  const ipOk = await checkRateLimit(
    redisKey('ratelimit', 'stats-otp-request', 'ip', ip),
    OTP_REQUEST_LIMIT_IP,
    OTP_REQUEST_WINDOW_SECONDS
  );
  if (!ipOk) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく時間をおいて再度お試しください' });
  }

  if (!(await canResendOtp(normalizedEmail, { namespace: OTP_NAMESPACE }))) {
    return res.status(429).json({ error: '前回の送信から時間が経っていません。しばらくお待ちください' });
  }

  // 許可リスト(STATS_VIEWER_EMAILS)にあるかどうかで、この先の処理(コードの生成・
  // 保存・送信)を分けるが、応答(最後のres.status(200))とクールダウンの付与は
  // 分岐しない(ファイル冒頭のコメント参照)。
  const allowed = isStatsViewerEmail(normalizedEmail);
  await markOtpSent(normalizedEmail, { namespace: OTP_NAMESPACE });

  if (allowed) {
    const code = generateOtpCode();
    const hash = hashOtpCode(normalizedEmail, code);
    await storeOtp(normalizedEmail, hash, { namespace: OTP_NAMESPACE });

    try {
      await sendStatsOtpEmail({ to: normalizedEmail, code });
    } catch (err) {
      await clearOtpState(normalizedEmail, { namespace: OTP_NAMESPACE });
      console.error('[stats-login] 統計ログインコードの送信に失敗しました:', err.message);
      return res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }
  } else {
    console.warn(`[stats-login] 許可されていないメールアドレスからのログイン試行です: ${normalizedEmail}`);
  }

  return res.status(200).json({ success: true, mode: 'otp' });
}

async function handleVerifyOtp(req, res) {
  if (!process.env.STATS_SESSION_SECRET) {
    console.error('[stats-login] STATS_SESSION_SECRET が未設定のため、リクエストを拒否しました');
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }

  const normalizedEmail = getNormalizedEmailOrNull(req, res);
  if (!normalizedEmail) return;

  const ip = getClientIp(req);
  const ipOk = await checkRateLimit(
    redisKey('ratelimit', 'stats-otp-verify', 'ip', ip),
    OTP_VERIFY_LIMIT_IP,
    OTP_VERIFY_WINDOW_IP_SECONDS
  );
  if (!ipOk) {
    return res.status(429).json({ error: '検証の試行回数が多すぎます。しばらく時間をおいて再度お試しください' });
  }

  const { code: rawCode } = req.body || {};
  const code = normalizeOtpCode(rawCode);
  if (!code) {
    return res.status(400).json({ error: 'コードの形式が正しくありません' });
  }

  const record = await readOtp(normalizedEmail, { namespace: OTP_NAMESPACE });
  if (!record) {
    return res.status(401).json({ code: 'CODE_EXPIRED', error: 'コードの有効期限が切れました。再送してください' });
  }

  const emailOk = await checkRateLimit(
    redisKey('ratelimit', 'stats-otp-verify', 'email', normalizedEmail),
    OTP_VERIFY_LIMIT_EMAIL,
    OTP_VERIFY_WINDOW_EMAIL_SECONDS
  );
  if (!emailOk) {
    return res.status(429).json({ error: '検証の試行回数が多すぎます。しばらく時間をおいて再度お試しください' });
  }

  const attempts = await incrementOtpAttempts(normalizedEmail, { namespace: OTP_NAMESPACE });
  if (attempts > OTP_MAX_ATTEMPTS) {
    await clearOtpState(normalizedEmail, { namespace: OTP_NAMESPACE });
    return res.status(401).json({ code: 'CODE_EXPIRED', error: 'コードの有効期限が切れました。再送してください' });
  }

  const expectedHash = hashOtpCode(normalizedEmail, code);
  if (!timingSafeEqualHex(expectedHash, record.hash)) {
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await clearOtpState(normalizedEmail, { namespace: OTP_NAMESPACE });
    }
    return res.status(401).json({ code: 'INVALID_CODE', error: 'コードが正しくありません' });
  }

  await clearOtpState(normalizedEmail, { namespace: OTP_NAMESPACE });

  // request-otp時から時間が空くため、許可リストに今も含まれているかを再確認する
  // (手動でSTATS_VIEWER_EMAILSを変更した直後等、稀なケースへの保険)。
  if (!isStatsViewerEmail(normalizedEmail)) {
    return res.status(401).json({ error: 'ログインできませんでした' });
  }

  let token;
  try {
    token = createStatsSessionToken(normalizedEmail);
  } catch (err) {
    console.error('[stats-login] セッショントークンの発行に失敗しました:', err.message);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }

  return res.status(200).json({ success: true, token });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  if (action === 'request-otp') {
    return handleRequestOtp(req, res);
  }
  if (action === 'verify-otp') {
    return handleVerifyOtp(req, res);
  }

  return res.status(400).json({ error: 'action は request-otp または verify-otp を指定してください' });
}
