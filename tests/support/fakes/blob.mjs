// tests/support/fakes/blob.mjs
// @vercel/blob のフェイク。lib/ownerDeletion.js が呼ぶ del() だけを実装する
// (put()はapi/company-logo.jsが使うが、今回のテスト対象外なので実装しない)。

let deletedUrls = [];
let handler = async () => {};

export function __reset() {
  deletedUrls = [];
  handler = async () => {};
}
__reset();

/** del()の挙動を差し替える(失敗を模すテスト用)。例: __setHandler(async () => { throw new Error('boom'); }) */
export function __setHandler(fn) {
  handler = fn;
}

export function __getDeletedUrls() {
  return deletedUrls.slice();
}

export async function del(url) {
  await handler(url);
  deletedUrls.push(url);
}
