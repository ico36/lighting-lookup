// tests/support/loader.mjs
//
// このリポジトリの api/*.js・lib/*.js は Vercel の esbuild バンドルを前提にしていて、
//   1. 相対 import が拡張子なし（例: `from '../lib/subscription'`）
//   2. package.json に "type": "module" が無いのに import/export 構文を使っている
// という、素の Node が単体では解決できない2つの前提がある。テストのためだけに
// 本体側（37件の相対 import・package.json）を書き換えるのは影響範囲が大きすぎるため、
// Node の Module Customization Hooks（resolve/load）でテスト実行時だけ補う。
//
// あわせて、実際の Stripe SDK と api/checkout.js の `./_auth` をテスト用の
// フェイクへ差し替える（tests/support/fakes/*.mjs）。lib/subscription.js や
// lib/upgradeQuote.js は差し替えず本物を読み込む（E-5でテストしたいのはこの2つの
// 実コードの振る舞いのため）。
//
// 使い方: `node --import ./tests/support/register-loader.mjs --test tests/`
//   （package.json の `npm test` に登録済み）

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url)); // 末尾 '/' 付き
const FAKES_DIR = new URL('./fakes/', import.meta.url);

// `./_auth` を差し替えるのは api/checkout.js からの import に限定する。
// _auth.js は api/ 直下にあり、checkout.js も同じ api/ 直下なので相対指定は
// `../_auth` ではなく `./_auth`（同一ディレクトリ）。他の api/*.js（login.js など）
// から見た `./_auth` は本物のまま通す。
const CHECKOUT_JS = path.join(REPO_ROOT, 'api', 'checkout.js');

export async function resolve(specifier, context, nextResolve) {
  // 1. Stripe SDK 全体をフェイクへ。実SDKは一切ロードしない
  //    （ネットワークに出ず、呼び出し内容をテストが検証できるようにするため）。
  if (specifier === 'stripe') {
    return { url: new URL('stripe.mjs', FAKES_DIR).href, shortCircuit: true };
  }

  // 2. api/checkout.js が読む `./_auth` だけをフェイクへ。
  //    requireAuthWithPlan の中身（Redis・Stripeの再照会）はE-5の対象外のため、
  //    テストが直接 { email, limits } を差し込めるようにする。
  if (specifier === './_auth' && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL);
    if (parentPath === CHECKOUT_JS) {
      return { url: new URL('auth.mjs', FAKES_DIR).href, shortCircuit: true };
    }
  }

  // 3. リポジトリ本体の相対importは拡張子なし。ここで `.js` を補って解決する。
  //    本体のimportはすべて相対（`.`始まり）なので、それ以外（npmパッケージ）は触らない。
  if (specifier.startsWith('.') && !path.extname(specifier)) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch (err) {
      // 拡張子を補っても解決できない場合は、元の指定のままデフォルト解決に委ねて
      // 本来のエラーメッセージを出す（ここで握りつぶさない）。
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // リポジトリ本体の lib/・api/ 配下の .js は import/export 構文だが、
  // package.json に "type": "module" が無いため既定では CommonJS と判定され、
  // SyntaxError になる。本体側の import/export 構文を変えずに済むよう、
  // このディレクトリ配下だけ明示的に ESM として読ませる。
  //
  // node_modules は絶対に対象にしない（パス先頭一致で判定し、部分一致にしないのはこのため。
  // 依存パッケージ内部に `/lib/` を含むディレクトリがあっても誤爆させない）。
  if (url.startsWith('file://')) {
    const filePath = fileURLToPath(url);
    const inLib = filePath.startsWith(path.join(REPO_ROOT, 'lib') + path.sep);
    const inApi = filePath.startsWith(path.join(REPO_ROOT, 'api') + path.sep);
    if (filePath.endsWith('.js') && (inLib || inApi)) {
      return nextLoad(url, { ...context, format: 'module' });
    }
  }

  return nextLoad(url, context);
}
