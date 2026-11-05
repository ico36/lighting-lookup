// lib/statsOtpMail.js
// 経営統計ページ(stats.ma-system.co.jp)のログイン用ワンタイムコードをResend経由で
// メール送信する。lib/otpMail.js(照明サーチ本体のOTPログイン)と同じ構造だが、
// 件名・本文を統計サイト向けにしている(本体のブランドと混同させないため)。
// SDKは使わずfetchのみ(package.jsonに新しい依存を増やさない方針)。
//
// 【ログ・例外メッセージに絶対に出さないもの】コード自体とRESEND_API_KEY。
// lib/otpMail.jsと同じ方針。

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;
const STATS_OTP_LOGIN_CODE_SUBJECT = '経営統計ログインコード';

function buildStatsOtpEmailText(code) {
  return `経営統計ページのログインコードです。

${code}

このコードの有効期限は発行から10分間です。
心当たりがない場合は、このメールを無視してください。`;
}

// { to: string, code: string } を受け取り、Resend APIへ1通送る。
// HTMLメールは作らない(text のみ)。失敗時は例外を投げる(呼び出し側でロールバック処理)。
export async function sendStatsOtpEmail({ to, code }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        subject: STATS_OTP_LOGIN_CODE_SUBJECT,
        text: buildStatsOtpEmailText(code),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error('[statsOtpMail] Resendへのリクエストに失敗しました:', err.name, err.message);
    throw new Error('統計ログインコードの送信に失敗しました(リクエストエラー)');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch (e) {
      // Resendが非JSONを返した場合はステータスのみで組み立てる
    }
    console.error('[statsOtpMail] Resendがエラーを返しました:', response.status, detail?.name, detail?.message);
    throw new Error(`統計ログインコードの送信に失敗しました(status: ${response.status})`);
  }
}
