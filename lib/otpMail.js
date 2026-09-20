// lib/otpMail.js
// OTPログイン用のワンタイムコードをResend経由でメール送信する。
// SDKは使わずfetchのみ(package.jsonに新しい依存を増やさない方針)。
//
// 【ログ・例外メッセージに絶対に出さないもの】コード自体とRESEND_API_KEY。
// 失敗時にconsole.error・throwするErrorへ含めてよいのはHTTPステータスと、
// Resendが返したエラー内容(name・message)だけ。リクエストボディ(to/subject/text等)を
// そのままログへ流用しない。

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;
const OTP_LOGIN_CODE_SUBJECT = '照明サーチ ログインコード';

function buildOtpEmailText(code) {
  return `照明サーチのログインコードです。

${code}

このコードの有効期限は発行から10分間です。
心当たりがない場合は、このメールを無視してください。`;
}

// { to: string, code: string } を受け取り、Resend APIへ1通送る。
// HTMLメールは作らない(text のみ)。失敗時は例外を投げる(呼び出し側でロールバック処理)。
export async function sendOtpEmail({ to, code }) {
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
      // MAIL_FROMは加工せずそのまま渡す(「表示名 <address>」形式も想定するため)。
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        subject: OTP_LOGIN_CODE_SUBJECT,
        text: buildOtpEmailText(code),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // fetch自体が失敗した場合(タイムアウトによるAbortErrorを含む)。
    // err.name/err.messageはネットワークエラーの説明であり、コード・APIキーを含まない。
    console.error('[otpMail] Resendへのリクエストに失敗しました:', err.name, err.message);
    throw new Error('OTPメールの送信に失敗しました(リクエストエラー)');
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
    console.error('[otpMail] Resendがエラーを返しました:', response.status, detail?.name, detail?.message);
    throw new Error(`OTPメールの送信に失敗しました(status: ${response.status})`);
  }
}
