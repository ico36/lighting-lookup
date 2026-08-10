// lib/redis.js
// Upstash Redisクライアントの共通初期化。api配下の各エンドポイント・lib/cases.jsから
// 使い回す（以前は同じ初期化コードが5ファイルに重複していた）。
//
// キーの組み立ても redisKey() に集約する。Upstashのストアは全環境で1つを共有して
// いるため、Preview環境（PRごとのデプロイ）で動作確認をすると本番の自社情報や案件
// データを直接書き換えてしまう。Preview のときだけキーの先頭に `preview:` を付けて
// 名前空間を分ける。

import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const PREVIEW_KEY_PREFIX = 'preview:';

/**
 * Preview環境かどうか。VERCEL_ENV は Vercel が自動で入れる環境変数で、
 * 'production' / 'preview' / 'development' のいずれか。
 * Production・ローカル開発ではいずれも接頭辞なしになる。
 */
export function isPreviewEnv() {
  return process.env.VERCEL_ENV === 'preview';
}

/**
 * Redisキーを組み立てる。パーツを ':' で連結し、Preview環境でのみ `preview:` を前置する。
 *
 *   redisKey('company', email)              -> 'company:foo@example.com'
 *   redisKey('case', caseId, 'logs')        -> 'case:c_123:logs'
 *   redisKey('announcements')               -> 'announcements'
 *
 * Production では連結結果がそのままキーになるので、既存データのキー名は1文字も
 * 変わらない（移行作業は不要）。
 *
 * undefined や空文字が紛れると `company:` や `cases::active` のような壊れたキーが
 * でき、全ユーザーで1つのキーを共有してしまう事故になるため、その場で例外にする。
 */
export function redisKey(...parts) {
  if (parts.length === 0) {
    throw new Error('[redis] redisKey() にはキーのパーツを1つ以上渡してください');
  }

  const normalized = parts.map((part, index) => {
    if (typeof part === 'number' && Number.isFinite(part)) return String(part);
    if (typeof part !== 'string' || part === '') {
      throw new Error(
        `[redis] redisKey() の ${index + 1} 番目のパーツが不正です（値: ${JSON.stringify(part)}）。` +
          `組み立てようとしたキー: ${parts.join(':')}`
      );
    }
    return part;
  });

  return `${isPreviewEnv() ? PREVIEW_KEY_PREFIX : ''}${normalized.join(':')}`;
}
