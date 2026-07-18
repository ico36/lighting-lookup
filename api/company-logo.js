// api/company-logo.js
// 自社ロゴ画像を Vercel Blob にアップロードし、URLを返すAPI
// 必要なnpmパッケージ: @vercel/blob（package.jsonに追加済み）
// 必要な環境変数: BLOB_READ_WRITE_TOKEN
//   Vercelのプロジェクト →「Storage」→「Create Database」→「Blob」でストアを作成し
//   プロジェクトに接続すると自動的に環境変数として付与される（Production/Preview/Development
//   それぞれの環境に反映されているか要確認）。未設定の場合は put() が例外を投げる。

import { put } from '@vercel/blob';
import { requireAuth } from './_auth';

// フロント側（public/index.html）の表示・チェックと同じ値に揃えること
const MAX_BYTES = 2 * 1024 * 1024; // デコード後2MBまで

const MIME_EXT_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const email = requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401レスポンス済み

  // Blobストア未接続の場合、put()が投げる例外だけでは原因が分かりにくいため先に明示チェックする
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('[company-logo] BLOB_READ_WRITE_TOKEN が設定されていません。VercelのStorageでBlobストアを作成し、プロジェクトに接続してください（Production環境にも反映されているか要確認）。');
    return res.status(500).json({
      error: 'サーバー側の画像保存設定が未完了です（BLOB_READ_WRITE_TOKEN未設定）。管理者に確認してください。',
    });
  }

  try {
    const { base64, mimeType } = req.body || {};

    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ error: '画像データが送信されていません' });
    }

    const ext = MIME_EXT_MAP[mimeType];
    if (!ext) {
      return res.status(400).json({ error: '対応していない画像形式です（PNG・JPEG・SVGのみ対応しています）' });
    }

    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch (decodeErr) {
      console.error('[company-logo] base64デコードエラー:', decodeErr);
      return res.status(400).json({ error: '画像データの読み込みに失敗しました' });
    }

    if (buffer.length === 0) {
      return res.status(400).json({ error: '画像データが空です' });
    }
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({
        error: `ロゴ画像のサイズが上限（${Math.floor(MAX_BYTES / (1024 * 1024))}MB）を超えています`,
      });
    }

    const pathname = `company-logos/${encodeURIComponent(email)}-${Date.now()}.${ext}`;

    const blob = await put(pathname, buffer, {
      access: 'public',
      contentType: mimeType,
    });

    return res.status(200).json({ url: blob.url });
  } catch (err) {
    // Vercel Function Logsで原因を追えるよう、スタックトレース込みで出力する（握りつぶさない）
    console.error('[company-logo] アップロードエラー:', err instanceof Error ? err.stack : err);
    return res.status(500).json({
      error: 'ロゴ画像のアップロードに失敗しました',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
