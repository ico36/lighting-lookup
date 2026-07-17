// api/login.js
// メールアドレス＋Stripeサブスク状態のその場確認によるログインAPI
//
// 必要な環境変数（Vercelに設定済み前提）:
//   STRIPE_SECRET_KEY              - Stripeシークレットキー
//   KV_REST_API_URL                - Upstash Redis REST URL
//   KV_REST_API_TOKEN              - Upstash Redis REST Token（読み書き用）
//   ADMIN_EMAILS                   - 管理者メールアドレス（カンマ区切り、例: "you@example.com,other@example.com"）
//   SESSION_SECRET                 - セッショントークン署名用の秘密文字列（適当な長いランダム文字列でOK）
//
// 必要なnpmパッケージ:
//   npm install stripe @upstash/redis

const Stripe = require('stripe');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const RATE_LIMIT_MAX_ATTEMPTS = 5;      // この回数を超えたらブロック
const RATE_LIMIT_WINDOW_SECONDS = 900;  // 15分間の試行回数でカウント
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // セッション有効期間: 30日

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// email + 有効期限をSESSION_SECRETで署名した簡易トークンを発行
// （別途DBを持たない設計のため、トークン自体に情報を含めて検証する方式）
function createSessionToken(email) {
  const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;
  const payload = `${email}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload)
    .digest('hex');
  const token = Buffer.from(`${payload}:${signature}`).toString('base64url');
  return token;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method Not Allowed' });
    return;
  }

  const { email } = req.body || {};

  if (!isValidEmail(email)) {
    res.status(400).json({ success: false, message: 'メールアドレスの形式が正しくありません' });
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  // --- レート制限チェック（IPとメール両方で見る） ---
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '')
    .split(',')[0]
    .trim() || 'unknown-ip';

  const rateLimitKeys = [
    `ratelimit:login:email:${normalizedEmail}`,
    `ratelimit:login:ip:${ip}`,
  ];

  for (const key of rateLimitKeys) {
    const attempts = await redis.incr(key);
    if (attempts === 1) {
      // 初回アクセス時のみTTLをセット（カウントウィンドウの開始）
      await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }
    if (attempts > RATE_LIMIT_MAX_ATTEMPTS) {
      res.status(429).json({
        success: false,
        message: 'ログイン試行回数が多すぎます。しばらく時間をおいて再度お試しください',
      });
      return;
    }
  }

  // --- 管理者バイパス ---
  if (getAdminEmails().includes(normalizedEmail)) {
    const token = createSessionToken(normalizedEmail);
    res.status(200).json({ success: true, admin: true, token });
    return;
  }

  // --- Stripeサブスク状態の確認 ---
  try {
    const customers = await stripe.customers.list({
      email: normalizedEmail,
      limit: 1,
    });

    if (customers.data.length === 0) {
      res.status(403).json({
        success: false,
        message: 'このメールアドレスに対応する契約が見つかりませんでした',
      });
      return;
    }

    const customer = customers.data[0];

    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 10,
    });

    const hasActiveSubscription = subscriptions.data.some((sub) =>
      ['active', 'trialing'].includes(sub.status)
    );

    if (!hasActiveSubscription) {
      res.status(403).json({
        success: false,
        message: '有効なサブスクリプションが見つかりませんでした。お支払い状況をご確認ください',
      });
      return;
    }

    const token = createSessionToken(normalizedEmail);
    res.status(200).json({ success: true, admin: false, token });
  } catch (err) {
    console.error('Stripe確認エラー:', err);
    res.status(500).json({ success: false, message: 'サーバーエラーが発生しました' });
  }
};
