// lib/rateLimit.js
// クライアントIPの取得と、Redisベースの単純なレート制限の共通ヘルパー。
// 元はapi/login.js専用だったが、api/checkout.jsのget-signup-plans(メールアドレスを
// 使ったStripeへの照会)にも同じ仕組みが必要になったため切り出した。

import { redis } from './redis';

// クライアントの実IPを取得する。
// Vercelはエッジ層でx-forwarded-forを上書きし、外部からの偽装値は転送しない
// 仕様のため通常はx-forwarded-forのままでも安全だが
// (https://vercel.com/docs/headers/request-headers#x-forwarded-for)、
// 将来Vercelの手前に別プロキシ(CDN等)を追加した場合はx-forwarded-forが
// そちらの値で上書きされる可能性がある。x-vercel-forwarded-forは
// 「x-forwarded-forと同一だが外部プロキシの影響を受けないVercel内部専用の値」
// のため、これを優先して使う。
export function getClientIp(req) {
  const raw = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '';
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value.split(',')[0].trim() || 'unknown-ip';
}

// INCRして初回だけEXPIREを付ける既存パターン。limitを超えたらfalseを返す。
export async function checkRateLimit(key, limit, windowSeconds) {
  const attempts = await redis.incr(key);
  if (attempts === 1) {
    await redis.expire(key, windowSeconds);
  }
  return attempts <= limit;
}
