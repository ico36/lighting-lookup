// api/announcements.js
// お知らせ一覧の取得API
// Redisキー: announcements にJSON配列で保存する（新しい順）
// 追加・編集はscripts/add-announcement.js経由で行う（管理画面はなし）

import { Redis } from '@upstash/redis';
import { requireAuth } from './_auth';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

  const announcements = (await redis.get('announcements')) || [];
  return res.status(200).json({ announcements });
}
