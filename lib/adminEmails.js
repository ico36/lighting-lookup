// lib/adminEmails.js
// 管理者バイパス用のメールアドレス判定。ADMIN_EMAILS環境変数(カンマ区切り)を
// api/login.js（ログイン時のバイパス）と api/_auth.js（セッション再チェックの
// スキップ）の両方で同じロジックを使うために共有する。

export function isAdminEmail(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(String(email || '').trim().toLowerCase());
}
