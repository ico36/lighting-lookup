// api/login.js
// OTPログインAPI。action(request-otp / verify-otp)で処理を分岐する。
// action未指定・不正な値はどちらの分岐にも該当させず400にする。
//
// 必要な環境変数:
//   STRIPE_SECRET_KEY, KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_EMAILS, SESSION_SECRET,
//   LOGIN_MODE ('otp'が既定。'legacy'のときだけ旧・即時ログイン相当の経路を使う),
//   RESEND_API_KEY, MAIL_FROM (LOGIN_MODE=otp のときのみ必須)
//
// 【LOGIN_MODE=legacy について】ドメイン取得前でResendの送信元アドレスを用意できない間、
// 本番を legacy のまま運用できるようにするための一時的な経路。契約チェック(Stripe)まで
// 通ったその場でセッショントークンを返す(OTPを発行しない)。
// TODO: LOGIN_MODE=legacy はドメイン取得後・OTP必須化のタイミングで削除予定。
//
// Redisキー:
//   ratelimit:otp-request:email:{email} / :ip:{ip}  ... request-otp のレート制限
//   ratelimit:otp-verify:email:{email} / :ip:{ip}    ... verify-otp のレート制限
//   otp:{email} / otp:attempts:{email} / otp:cooldown:{email} ... lib/otp.js 参照

import crypto from 'crypto';
import { redis, redisKey } from '../lib/redis';
import { isAdminEmail } from '../lib/adminEmails';
import { checkActiveSubscriptionLive, getSubscriptionStateCached, ADMIN_PLAN_LIMITS } from '../lib/subscription';
import { readQuota } from '../lib/quota';
import { getTosConsent, isTosConsentCurrent, detectAndRecordCheckoutConsent } from '../lib/legalConsent';
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
} from '../lib/otp';
import { sendOtpEmail } from '../lib/otpMail';

const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // セッション有効期間: 30日
// トークン自体はこの期間有効なままだが、requireAuth()側でStripeサブスク状態を
// 定期的に再チェックしているため、解約後は最大1時間程度でアクセスできなくなる
// (lib/subscription.js の SUBSCRIPTION_CACHE_TTL_SECONDS 参照)。

// 既定はotp。'legacy'以外の値(未設定・typo含む)はすべてotp扱いにする。
// モジュール読み込み時の定数ではなくリクエストごとに読む関数にしてある
// (Vercel環境では環境変数の変更に再デプロイが必要なため実質差はないが、
// テストがprocess.env.LOGIN_MODEを切り替えて分岐を検証できるようにするため)。
function getLoginMode() {
  return process.env.LOGIN_MODE === 'legacy' ? 'legacy' : 'otp';
}

// 総当たり対策はverify-otp側のレート制限(下のOTP_VERIFY_LIMIT_*)が担うため、
// 発行側は「普通に使っていて到達しない」程度まで緩めてある。
export const OTP_REQUEST_LIMIT_EMAIL = 10;
export const OTP_REQUEST_LIMIT_IP = 40;
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

// クライアントの実IPを取得する。
// Vercelはエッジ層でx-forwarded-forを上書きし、外部からの偽装値は転送しない
// 仕様のため通常はx-forwarded-forのままでも安全だが
// (https://vercel.com/docs/headers/request-headers#x-forwarded-for)、
// 将来Vercelの手前に別プロキシ(CDN等)を追加した場合はx-forwarded-forが
// そちらの値で上書きされる可能性がある。x-vercel-forwarded-forは
// 「x-forwarded-forと同一だが外部プロキシの影響を受けないVercel内部専用の値」
// のため、これを優先して使う。
function getClientIp(req) {
  const raw = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '';
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value.split(',')[0].trim() || 'unknown-ip';
}

// email + 有効期限をSESSION_SECRETで署名した簡易トークンを発行
function createSessionToken(email) {
  const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;
  const payload = `${email}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

// INCRして初回だけEXPIREを付ける既存パターン。limitを超えたらfalseを返す。
async function checkRateLimit(key, limit, windowSeconds) {
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, windowSeconds);
  }
  return attempts <= limit;
}

// OTPのハッシュ(HMAC-SHA256のhex、常に64文字)同士の比較。長さは常に一致する前提だが、
// crypto.timingSafeEqualは長さ不一致だと例外を投げるため、api/_auth.jsと同じく
// 念のため長さを確認してから渡す。
function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// email形式を検証し、正規化した値を返す。不正ならその場で400を返してnullを返す
// (呼び出し側は null なら return するだけでよい)。
function getNormalizedEmailOrNull(req, res) {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
    return null;
  }
  return normalizeEmail(email);
}

async function handleRequestOtp(req, res) {
  const loginMode = getLoginMode();

  // 0. 設定チェック(otpモードのみ)。ここで弾けばレート制限枠を消費させずに済む。
  if (loginMode === 'otp' && (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM)) {
    console.error('[login] LOGIN_MODE=otp ですが RESEND_API_KEY または MAIL_FROM が未設定です');
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }

  // 1-2. メール形式チェック・正規化
  const normalizedEmail = getNormalizedEmailOrNull(req, res);
  if (!normalizedEmail) return;

  // 3. レート制限(email/ipそれぞれ)
  const ip = getClientIp(req);
  const emailOk = await checkRateLimit(
    redisKey('ratelimit', 'otp-request', 'email', normalizedEmail),
    OTP_REQUEST_LIMIT_EMAIL,
    OTP_REQUEST_WINDOW_SECONDS
  );
  if (!emailOk) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく時間をおいて再度お試しください' });
  }
  const ipOk = await checkRateLimit(
    redisKey('ratelimit', 'otp-request', 'ip', ip),
    OTP_REQUEST_LIMIT_IP,
    OTP_REQUEST_WINDOW_SECONDS
  );
  if (!ipOk) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく時間をおいて再度お試しください' });
  }

  // 4. クールダウン判定。legacyモードではmarkOtpSent()を呼ばないため
  // otp:cooldown:{email}が存在せず、実質常に素通りする。
  if (!(await canResendOtp(normalizedEmail))) {
    return res.status(429).json({ error: '前回の送信から時間が経っていません。しばらくお待ちください' });
  }

  // 5. 契約チェック(管理者はスキップ)
  const admin = isAdminEmail(normalizedEmail);
  let limits = ADMIN_PLAN_LIMITS;
  let period = null;

  if (!admin) {
    let contractResult;
    try {
      contractResult = await checkActiveSubscriptionLive(normalizedEmail);
    } catch (err) {
      console.error('Stripe確認エラー:', err);
      return res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }

    if (!contractResult.customerFound) {
      return res.status(403).json({
        code: 'NO_CUSTOMER',
        error: 'このメールアドレスに対応する契約が見つかりませんでした',
      });
    }
    if (!contractResult.active) {
      return res.status(403).json({
        code: 'NO_ACTIVE_SUBSCRIPTION',
        error: '有効なサブスクリプションが見つかりませんでした。お支払い状況をご確認ください',
      });
    }
    limits = contractResult.limits;
    period = contractResult.period;

    // 新規契約者がCheckoutのconsent_collectionで既に同意済みなら、ログイン後の
    // 確認ゲートを二重に出さないようここで検出・記録しておく(tos:{email}が
    // 既にあれば何もしない)。失敗してもログイン自体は継続する
    // (detectAndRecordCheckoutConsent()内で吸収済み)。
    if (!isTosConsentCurrent(await getTosConsent(normalizedEmail))) {
      await detectAndRecordCheckoutConsent(normalizedEmail);
    }
  }

  // 6. LOGIN_MODEで分岐
  if (loginMode === 'legacy') {
    // TODO: LOGIN_MODE=legacy はドメイン取得後・OTP必須化のタイミングで削除予定。
    if (process.env.VERCEL_ENV === 'production') {
      console.warn('[login] LOGIN_MODE=legacy が本番で使用されました:', normalizedEmail);
    }
    const token = createSessionToken(normalizedEmail);
    const quota = await readQuota({ email: normalizedEmail, limits, period });
    return res.status(200).json({ success: true, admin, token, quota, mode: 'legacy' });
  }

  // otpモード: 生成・保存・送信。adminフラグ・token・codeはレスポンスに含めない
  // (未認証の相手に管理者かどうかを教えないため)。
  const code = generateOtpCode();
  const hash = hashOtpCode(normalizedEmail, code);
  await storeOtp(normalizedEmail, hash);
  await markOtpSent(normalizedEmail);

  try {
    await sendOtpEmail({ to: normalizedEmail, code });
  } catch (err) {
    await clearOtpState(normalizedEmail);
    console.error('[login] OTPメールの送信に失敗しました:', err.message);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }

  return res.status(200).json({ success: true, mode: 'otp' });
}

async function handleVerifyOtp(req, res) {
  // 1. メール形式チェック・正規化
  const normalizedEmail = getNormalizedEmailOrNull(req, res);
  if (!normalizedEmail) return;

  // 2. IP単位の検証制限(emailの実在有無に関わらず先にかける)
  const ip = getClientIp(req);
  const ipOk = await checkRateLimit(
    redisKey('ratelimit', 'otp-verify', 'ip', ip),
    OTP_VERIFY_LIMIT_IP,
    OTP_VERIFY_WINDOW_IP_SECONDS
  );
  if (!ipOk) {
    return res.status(429).json({ error: '検証の試行回数が多すぎます。しばらく時間をおいて再度お試しください' });
  }

  // 3. コードの正規化(全角数字・空白・ハイフンを許容)。形式不正はattemptsを増やさない。
  const { code: rawCode } = req.body || {};
  const code = normalizeOtpCode(rawCode);
  if (!code) {
    return res.status(400).json({ error: 'コードの形式が正しくありません' });
  }

  // 4. レコードの存在確認
  const record = await readOtp(normalizedEmail);
  if (!record) {
    return res.status(401).json({ code: 'CODE_EXPIRED', error: 'コードの有効期限が切れました。再送してください' });
  }

  // 5. email単位の検証制限(レコードが存在するときだけ数える。第三者が本人に
  // 気づかれずに1日分の検証枠を使い切れないようにするため)
  const emailOk = await checkRateLimit(
    redisKey('ratelimit', 'otp-verify', 'email', normalizedEmail),
    OTP_VERIFY_LIMIT_EMAIL,
    OTP_VERIFY_WINDOW_EMAIL_SECONDS
  );
  if (!emailOk) {
    return res.status(429).json({ error: '検証の試行回数が多すぎます。しばらく時間をおいて再度お試しください' });
  }

  // 6. 試行回数を加算。INCRはアトミックなので、同時リクエストが来てもここで
  // OTP_MAX_ATTEMPTSを超えた分は照合フェーズへ進めない。
  const attempts = await incrementOtpAttempts(normalizedEmail);
  if (attempts > OTP_MAX_ATTEMPTS) {
    await clearOtpState(normalizedEmail);
    return res.status(401).json({ code: 'CODE_EXPIRED', error: 'コードの有効期限が切れました。再送してください' });
  }

  // 7. 照合
  const expectedHash = hashOtpCode(normalizedEmail, code);
  if (!timingSafeEqualHex(expectedHash, record.hash)) {
    // ちょうど上限に達した失敗(5回目)ならここでレコードを消す。次(6回目)は
    // 上のreadOtp()が空振りしてCODE_EXPIREDになる。
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await clearOtpState(normalizedEmail);
    }
    return res.status(401).json({ code: 'INVALID_CODE', error: 'コードが正しくありません' });
  }

  // 8. 照合成功。即削除してから契約状態を確認する(request-otp時から時間が
  // 空くため、getSubscriptionStateCached()で改めて見る。個別のNO_CUSTOMER等の
  // コードは出さず、api/_auth.jsのauthenticate()と同じ汎用401にする)。
  await clearOtpState(normalizedEmail);

  const { active, limits, period } = await getSubscriptionStateCached(normalizedEmail);
  if (!active) {
    return res.status(401).json({
      code: 'SUBSCRIPTION_INACTIVE',
      error: 'サブスクリプションが有効ではありません。もう一度ログインからやり直してください',
    });
  }

  const admin = isAdminEmail(normalizedEmail);
  const token = createSessionToken(normalizedEmail);
  const quota = await readQuota({ email: normalizedEmail, limits, period });
  return res.status(200).json({ success: true, admin, token, quota });
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
