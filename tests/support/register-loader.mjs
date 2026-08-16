// tests/support/register-loader.mjs
// `node --import ./tests/support/register-loader.mjs --test tests/` の --import で読む。
// loader.mjs の resolve/load フックをプロセス全体に登録する。

import { register } from 'node:module';

// import.meta.url はこの時点で既に 'file:///...register-loader.mjs' というURL文字列。
// pathToFileURL() はファイルシステムパスを受け取る関数でURL文字列を受け取る関数では
// ないため、ここに通すと cwd を二重に前置した壊れたURLになる
// （実際に踏んだ: file:///repo/file:/repo/tests/support/loader.mjs）。
// register() の第2引数はURL(文字列可)を直接渡す。
register('./loader.mjs', import.meta.url);
