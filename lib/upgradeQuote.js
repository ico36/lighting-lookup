// lib/upgradeQuote.js
// プラン変更の「見積トークン(quote)」の発行と検証。
//
// アップグレードは2ステップになる:
//   1. get-upgrade-options ... 移行先ごとに日割り額をプレビューして提示する
//   2. update-plan          ... 利用者が選んだ移行先で実際に変更する
//
// このとき、フロントが「どの移行先を選んだか」と「そのとき提示した金額」を送り返す
// 必要がある。素朴に { plan, amountDue } を持たせる形だと、次の3つを防げない:
//   - 取り違え ... 候補Aの金額で候補Bへ変更してしまう
//   - 改ざん   ... 提示額やPrice IDを差し替えて別のプランを安く確定させる
//   - 陳腐化   ... モーダルを開いたまま放置し、古い条件で確定してしまう
//
// そこで、対にすべき値をまとめてHMAC署名した1個の文字列(quote)にして往復させる。
// フロントは中身を組み替えられず、サーバーは署名を検証してから中の値を使う。
// 移行先のPrice IDもこの中に入れるので、クライアントから任意のPrice IDを
// 受け取ることもない(無料のPriceを指定される穴が塞がる)。
//
// 署名方式は api/_auth.js のセッショントークンと同じ SESSION_SECRET のHMAC-SHA256。
// 新しい鍵も新しい概念も増やさない。

import crypto from 'crypto';

// 発行から確定までの猶予。短すぎると比較画面を読んでいる間に切れ、長すぎると
// 古い条件（クーポンの適用状態や定価が変わったあと）で確定できてしまう。
const QUOTE_TTL_MS = 10 * 60 * 1000;

function sign(payloadB64) {
  return crypto
    .createHmac('sha256', process.env.SESSION_SECRET)
    .update(payloadB64)
    .digest('hex');
}

/**
 * 見積トークンを発行する。
 *
 * @param {{email: string, fromPriceId: string, toPriceId: string, toPlan: string,
 *          amountDue: number, currency: string, couponSent: boolean,
 *          couponApplied: boolean}} quote
 *   couponSent    ... プレビューで実際にクーポンを渡せたか。update側もこれに合わせる
 *                     （片方だけ割引が乗ると提示額と請求額がズレる）
 *   amountDue     ... 提示額。更新後に実請求額と突き合わせて食い違いを検知する
 *
 * 時刻は expiresAt だけで、単位はミリ秒（Date.now() を使うこのリポジトリの表現）。
 * 日割りをやめた（proration_behavior: 'none'）ので、以前ここに入れていた
 * 秒エポックの prorationDate は不要になった。
 *
 * nonce は発行ごとに必ず署名を変えるため。冪等キーを署名から導出しているので、
 * ペイロードが同一だとキーも同一になり、決済失敗後にカードを差し替えて再試行しても
 * Stripeが前回の失敗レスポンスを返し続ける（Stripeは失敗も冪等キーに紐付けて保存する）。
 * 現実には同一ミリ秒で2回発行されることはまずないが、「起こらないはず」ではなく
 * 「構造上起こらない」にしておく。同じquoteの再送信は同じキーのままなので、
 * 二重送信を防ぐ性質は保たれる。
 *
 * @returns {string} base64url(JSON) + '.' + HMAC
 */
export function createUpgradeQuote(quote) {
  const payload = {
    ...quote,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + QUOTE_TTL_MS, // ミリ秒エポック
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * 見積トークンを検証して中身を返す。
 *
 * @param {string} token
 * @param {string} email 認証済みのメールアドレス。トークン内の値と一致するか確認する
 * @returns {{ok: true, quote: object} | {ok: false, reason: 'malformed'|'invalid_signature'|'expired'|'email_mismatch'}}
 */
export function verifyUpgradeQuote(token, email) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  // 形が違うもの（ドット無し/複数、空のペイロード、16進でない署名）はすべて malformed。
  // invalid_signature は「正しい形だが署名が合わない」＝改ざんの兆候だけに使いたいので、
  // 単に壊れたトークンを混ぜない。
  if (parts.length !== 2 || !parts[0] || !/^[0-9a-f]+$/i.test(parts[1])) {
    return { ok: false, reason: 'malformed' };
  }

  const [payloadB64, signature] = parts;

  // 署名の比較は長さを合わせてから timingSafeEqual に渡す
  // （長さが違うと timingSafeEqual 自体が例外を投げる）
  let expected;
  try {
    expected = sign(payloadB64);
  } catch (err) {
    // SESSION_SECRET 未設定など。呼び出し側に500を返させる
    throw err;
  }

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: 'invalid_signature' };
  }

  let quote;
  try {
    quote = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (err) {
    return { ok: false, reason: 'malformed' };
  }

  if (!quote || typeof quote !== 'object') return { ok: false, reason: 'malformed' };
  if (!Number.isFinite(quote.expiresAt) || Date.now() > quote.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  // 他人のquoteを自分のセッションで使えないようにする
  if (quote.email !== email) return { ok: false, reason: 'email_mismatch' };

  return { ok: true, quote };
}

/**
 * 二重送信対策の冪等キー。同じquoteでの再送信はStripe側で同じ結果になる。
 * withButtonGuard()はブラウザ内の多重クリックしか防げず、通信のリトライや
 * 別タブからの再送信は防げないため、サーバー側でも押さえる。
 *
 * 署名部分をそのまま使う。quoteが1つ違えばキーも変わり、同じquoteなら必ず同じになる。
 */
export function idempotencyKeyFromQuote(token) {
  return `upgrade_${token.split('.')[1]}`;
}
