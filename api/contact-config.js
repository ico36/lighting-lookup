// api/contact-config.js
// お問い合わせフォーム用の宛先メールアドレスと、ログイン中アカウントの情報を返すAPI
// メール送信自体はサーバー側では行わず、フロント側でmailtoリンクを組み立てるための情報提供のみ

import { requireAuth } from './_auth';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

  return res.status(200).json({
    supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com',
    accountEmail: email,
    planName: 'スタンダードプラン',
  });
}
