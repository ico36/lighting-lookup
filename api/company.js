// api/company.js
// 自社情報（社名・電話番号・登録番号・ロゴURL）の保存／取得API
// Redisキー: company:{email} にJSONで保存する

import { Redis } from '@upstash/redis';
import { requireAuth } from './_auth';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export default async function handler(req, res) {
  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

  const key = `company:${email}`;

  if (req.method === 'GET') {
    const company = await redis.get(key);
    return res.status(200).json({ company: company || null });
  }

  if (req.method === 'POST') {
    const { name, tel, license, logoUrl } = req.body || {};

    if (!isNonEmptyString(name)) {
      return res.status(400).json({ error: '会社名を入力してください' });
    }

    const company = {
      name: name.trim(),
      tel: isNonEmptyString(tel) ? tel.trim() : '',
      license: isNonEmptyString(license) ? license.trim() : '',
      logoUrl: isNonEmptyString(logoUrl) ? logoUrl.trim() : '',
      updatedAt: Date.now(),
    };

    await redis.set(key, company);
    return res.status(200).json({ success: true, company });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
