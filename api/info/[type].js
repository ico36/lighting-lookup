// api/info/[type].js
// 軽量な参照専用エンドポイントをまとめたもの（Vercel HobbyプランのServerless Function数上限対策）
// GET /api/info/announcements   … お知らせ一覧の取得
// GET /api/info/contact-config  … お問い合わせフォーム用の宛先・アカウント情報の取得

import { requireAuthWithPlan } from '../_auth';
import { redis, redisKey } from '../../lib/redis';

async function getAnnouncements(req, res) {
  const announcements = (await redis.get(redisKey('announcements'))) || [];
  return res.status(200).json({ announcements });
}

async function getContactConfig(req, res, email, limits) {
  return res.status(200).json({
    supportEmail: process.env.SUPPORT_EMAIL || 'support@example.com',
    accountEmail: email,
    // 契約中プランの識別子（Stripe の Price metadata の plan）。
    // 以前は 'スタンダードプラン' がハードコードされており、実際の契約に関わらず
    // 全員が同じ文字列で問い合わせてきていた。
    //
    // 識別子(light / standard / pro / unknown)をそのまま出すのは、この文面の受け手が
    // 社内で、識別子で判断できるため。識別子→日本語名の対応表をコードに持つのは、
    // 数値のハードコードを潰した方針の逆行になる。利用者に見せる画面（アップグレードの
    // 比較モーダル）では StripeのProduct名を使っており、そちらとは用途が違う。
    planName: limits.plan,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // contact-config が契約中プランを返すため requireAuthWithPlan() を使う。
  // requireAuth() との違いは戻り値だけで、どちらも内部で同じ authenticate() を通り
  // getSubscriptionStateCached() を呼ぶ。プラン情報が不要な announcements 側にも
  // 追加のRedis/Stripe往復は発生しない（切り替え前後で1リクエストあたりの
  // subcheck:v3 の読み取りは1回のまま）。
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return; // requireAuthWithPlan内で既に401レスポンス済み
  const { email, limits } = auth;

  const { type } = req.query;

  if (type === 'announcements') return getAnnouncements(req, res);
  if (type === 'contact-config') return getContactConfig(req, res, email, limits);

  return res.status(404).json({ error: 'Not found' });
}
