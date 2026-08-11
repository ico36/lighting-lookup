// api/company.js
// 自社情報（社名・電話番号・登録番号・ロゴURL）の保存／取得API
// Redisキー: company:{email} にJSONで保存する（Preview環境では preview: 接頭辞付き）

import { requireAuthWithPlan } from './_auth';
import { redis, redisKey } from '../lib/redis';
import { readQuota } from '../lib/quota';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export default async function handler(req, res) {
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return; // requireAuthWithPlan内で既に401レスポンス済み
  const { email, limits, period } = auth;

  const key = redisKey('company', email);

  if (req.method === 'GET') {
    const company = await redis.get(key);
    // 残り検索回数も一緒に返す。ログイン済みのまま画面を開き直した場合
    // (セッションは30日有効)は api/login.js を通らないため、ここで返さないと
    // 次に検索するまで「残り○回」を表示できない。カウントは増やさない読み取り専用。
    const quota = await readQuota({ email, limits, period });
    return res.status(200).json({ company: company || null, quota });
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
