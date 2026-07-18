// api/company-logo.js
// 自社ロゴ画像を Vercel Blob にアップロードし、URLを返すAPI
// 必要なnpmパッケージ: @vercel/blob（package.jsonに追加済み）
//
// 認証情報について:
//   Vercelのプロジェクト →「Storage」→「Create Database」→「Blob」でストアを作成し
//   プロジェクトに接続すると、@vercel/blob の put() は以下のいずれかの方法で
//   自動的に認証情報を解決する（どちらが使われるかはVercel側の接続方式次第で、
//   コード側で判別・分岐する必要はない）:
//     1. 環境変数 BLOB_READ_WRITE_TOKEN（従来方式）
//     2. 環境変数 BLOB_STORE_ID ＋ ランタイムに自動注入される VERCEL_OIDC_TOKEN（新方式）
//   そのため、特定の環境変数の有無を事前チェックするとStorage接続方式によっては
//   誤検知で失敗するので行わない。put() 自身の例外をそのまま拾って詳細を返す。

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
