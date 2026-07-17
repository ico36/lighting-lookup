// api/login.js
// メールアドレス＋Stripeサブスク状態のその場確認によるログインAPI
//
// 必要な環境変数（Vercelに設定済み）:
//   STRIPE_SECRET_KEY, KV_REST_API_URL, KV_REST_API_TOKEN, ADMIN_EMAILS, SESSION_SECRET
//
// 必要なnpmパッケージ（package.jsonに追加済み）:
//   stripe, @upstash/redis

import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import crypto from 'crypto';

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
function createSessionToken(email) {
  const expiresAt = Date.now() + SESSION_DURATION_SECONDS * 1000;
  const payload = `${email}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64url');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 【重要】ここで email を受け取る（この行が消えている、または下にいっているのが原因です！）
  const { email } = req.body || {};

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // --- 管理者バイパス（レート制限をスキップして即座にログイン） ---
  if (getAdminEmails().includes(normalizedEmail)) {
    const token = createSessionToken(normalizedEmail);
    return res.status(200).json({ success: true, admin: true, token });
  }

  // --- レート制限チェック（ここから下は一般ユーザーのみ進む） ---
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
      await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);
    }
    if (attempts > RATE_LIMIT_MAX_ATTEMPTS) {
      return res.status(429).json({
        error: 'ログイン試行回数が多すぎます。しばらく時間をおいて再度お試しください',
      });
    }
  }

  // --- Stripeサブスク状態の確認 ---
  try {
    const customers = await stripe.customers.list({
      email: normalizedEmail,
      limit: 1,
    });

    if (customers.data.length === 0) {
      return res.status(403).json({
        error: 'このメールアドレスに対応する契約が見つかりませんでした',
      });
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
      return res.status(403).json({
        error: '有効なサブスクリプションが見つかりませんでした。お支払い状況をご確認ください',
      });
    }

    const token = createSessionToken(normalizedEmail);
    return res.status(200).json({ success: true, admin: false, token });
  } catch (err) {
    console.error('Stripe確認エラー:', err);
    return res.status(500).json({ error: 'サーバーエラーが発生しました' });
  }
}
