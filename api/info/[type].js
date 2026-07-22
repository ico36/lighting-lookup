// api/info/[type].js
// 軽量な参照専用エンドポイントをまとめたもの（Vercel HobbyプランのServerless Function数上限対策）
// GET /api/info/announcements   … お知らせ一覧の取得
// GET /api/info/contact-config  … お問い合わせフォーム用の宛先・アカウント情報の取得

import { Redis } from '@upstash/redis';
import { requireAuth } from '../_auth';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function getAnnouncements(req, res) {
  const announcements = (await redis.get('announcements')) || [];
  return res.status(200).json({ announcements });
}

async function getContactConfig(req, res, email) {
  return res.status(200).json({
    supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com',
    accountEmail: email,
    planName: 'スタンダードプラン',
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

  const { type } = req.query;

  if (type === 'announcements') return getAnnouncements(req, res);
  if (type === 'contact-config') return getContactConfig(req, res, email);

  return res.status(404).json({ error: 'Not found' });
}
