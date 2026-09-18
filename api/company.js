// api/company.js
// 自社情報（社名・電話番号・登録番号・ロゴURL）の保存／取得API
// Redisキー: company:{email} にJSONで保存する（Preview環境では preview: 接頭辞付き）

import { requireAuthWithPlan } from './_auth';
import { redis, redisKey } from '../lib/redis';
import { readQuota } from '../lib/quota';
import { getTosConsent, isTosConsentCurrent, recordTosConsent, CURRENT_TOS_VERSION } from '../lib/legalConsent';

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
    // 規約同意の状態も一緒に返す。専用エンドポイントは作らない方針(api配下は
    // 12ファイル上限、api/login.jsと同じ理由)のため、ここに相乗りさせる。
    const tosAccepted = isTosConsentCurrent(await getTosConsent(email));
    return res.status(200).json({ company: company || null, quota, tosAccepted });
  }

  if (req.method === 'POST') {
    const { action } = req.body || {};

    // 規約同意の記録専用の分岐。company:{email}には一切触れない
    // (自社情報の保存と同意記録が互いのデータを上書きしないようキーを分けている)。
    if (action === 'accept-tos') {
      const { version } = req.body || {};
      if (version !== CURRENT_TOS_VERSION) {
        // 版が食い違う場合は記録せず、画面側に規約を読み直させる
        // (古いタブを開いたまま同意した、版を上げた直後などが該当)。
        return res.status(409).json({ error: 'version_mismatch', currentVersion: CURRENT_TOS_VERSION });
      }
      await recordTosConsent(email, { source: 'gate' });
      return res.status(200).json({ success: true });
    }

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
