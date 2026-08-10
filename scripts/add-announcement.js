// scripts/add-announcement.js
// お知らせを1件追加する簡易スクリプト（管理画面の代わり）
//
// 使い方:
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/add-announcement.js "タイトル" "本文"
//
// 環境変数はVercelの「Settings → Environment Variables」に設定されている値と同じもの。
// `vercel env pull .env.local` で取得したファイルの中身を環境変数として渡して実行してもよい。
//
// 新しいお知らせは一覧の先頭に追加される。
//
// 【キーの接頭辞について】
// api/ と lib/ のRedisキーは lib/redis.js の redisKey() 経由で組み立てており、
// Preview環境では `preview:` が前置される。このスクリプトだけは接頭辞なしの
// `announcements`（＝Production側）を直接見る。理由は2つ:
//   1. 手動運用の管理用スクリプトで、本番のお知らせを追加するのが目的のため
//   2. このファイルはCommonJS(require)、lib/ 配下はESM構文で書かれており、
//      package.jsonに "type": "module" が無いため素のnodeからlib/redis.jsを
//      読み込めない（共有するには .mjs へのリネームが必要）
// Preview環境のお知らせを触りたくなった場合は、キーを 'preview:announcements'
// に読み替えて実行すること。

const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const [title, body] = process.argv.slice(2);

if (!title || !body) {
  console.error('使い方: node scripts/add-announcement.js "タイトル" "本文"');
  process.exit(1);
}

if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
  console.error('環境変数 KV_REST_API_URL / KV_REST_API_TOKEN を設定してから実行してください');
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function main() {
  const announcement = {
    id: crypto.randomUUID(),
    title,
    body,
    date: new Date().toISOString().slice(0, 10),
  };

  const current = (await redis.get('announcements')) || [];
  current.unshift(announcement);
  await redis.set('announcements', current);

  console.log('お知らせを追加しました:');
  console.log(announcement);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
