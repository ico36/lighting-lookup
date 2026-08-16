// tests/support/loader.smoke.test.mjs
// tests/support/loader.mjs のスモークテスト。本体側の lib/*.js は
//   1. 相対importが拡張子なし
//   2. package.jsonに "type": "module" が無いのに import/export構文
// という、素のNodeでは読めない前提を2つ持つ。ここでは本題（E-5の分岐）に入る前に、
// ローダーがこの2つを解決できているかどうかだけを確認する。
//
// lib/upgradeQuote.js は他モジュールに依存しないため、'stripe' フェイクなしで
// importできることの確認も兼ねる。lib/subscription.js は内部で 'stripe' と
// './redis'（拡張子なし）をimportするため、両方の解決を通す。
//
// 【確認する対象は既存exportのみ】isEarlyBirdCouponAvailable() はE-5でこれから
// 新設する関数で、このテストを書いた時点ではまだ存在しない。ここに含めると
// 「未実装だから赤」なのか「ローダーが壊れているから赤」なのかを区別できなくなる
// ため、土台の健全性確認は既存exportだけに絞る。isEarlyBirdCouponAvailable() の
// 検証はE-5本体のテスト（tests/lib/isEarlyBirdCouponAvailable.test.mjs）側に置く。

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('loader: 拡張子なし・ESM構文の本体ファイルをimportできる', async () => {
  const subscription = await import('../../lib/subscription.js');
  const upgradeQuote = await import('../../lib/upgradeQuote.js');

  // 実体が取れていること（importが例外にならず、想定するexportが存在すること）を確認。
  // これが通れば、resolve側の拡張子補完(specifier + '.js')とload側のformat強制
  // (ESMとして解釈)の両方が機能している。
  assert.equal(typeof subscription.planLimitsFromPrice, 'function');
  assert.equal(typeof upgradeQuote.createUpgradeQuote, 'function');
  assert.equal(typeof upgradeQuote.verifyUpgradeQuote, 'function');
});
