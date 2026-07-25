// lib/redis.js
// Upstash Redisクライアントの共通初期化。api配下の各エンドポイント・lib/cases.jsから
// 使い回す（以前は同じ初期化コードが5ファイルに重複していた）。

import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
