// tests/support/fakes/otpMail.mjs
// lib/otpMail.js の sendOtpEmail() を差し替えるフェイク。Resendへ実際にネットワークで
// 送信させず、api/login.js のテストが「何に対して何回送ろうとしたか」「送信失敗時の
// ロールバックが動くか」を確認できるようにする。
// lib/otpMail.js 自体の実装(リクエストの組み立て・Resendのエラー処理)は
// tests/lib/otpMail.test.mjs 側でglobalThis.fetchを直接スタブして検証する
// (ここでは対象外)。

let sentEmails = [];
let shouldFail = false;

export async function sendOtpEmail({ to, code }) {
  if (shouldFail) {
    throw new Error('OTPメールの送信に失敗しました(フェイク)');
  }
  sentEmails.push({ to, code });
}

export function __getSentEmails() {
  return sentEmails.slice();
}

export function __setShouldFail(value) {
  shouldFail = value;
}

export function __reset() {
  sentEmails = [];
  shouldFail = false;
}
