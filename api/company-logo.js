// api/company-logo.js
// 自社ロゴ画像を Vercel Blob にアップロードし、URLを返すAPI
// 必要なnpmパッケージ: @vercel/blob（package.jsonに追加済み）
// 必要な環境変数: BLOB_READ_WRITE_TOKEN（VercelでBlobストアを接続すると自動付与）

import { put } from '@vercel/blob';
import { requireAuth } from './_auth';

const MAX_BYTES = 3 * 1024 * 1024; // デコード後3MBまで

function extFromMime(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

  try {
    const { base64, mimeType } = req.body || {};
    const ext = extFromMime(mimeType);

    if (!base64 || typeof base64 !== 'string' || !ext) {
      return res.status(400).json({ error: '画像形式が正しくありません（PNG/JPEG/WebPのみ対応）' });
    }

    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'ロゴ画像のサイズが正しくありません（3MB以下にしてください）' });
    }

    const pathname = `company-logos/${encodeURIComponent(email)}-${Date.now()}.${ext}`;
    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType: mimeType,
    });

    return res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error('ロゴアップロードエラー:', err);
    return res.status(500).json({ error: 'ロゴ画像のアップロードに失敗しました' });
  }
}
