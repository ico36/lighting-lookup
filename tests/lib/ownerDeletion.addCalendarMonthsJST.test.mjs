// tests/lib/ownerDeletion.addCalendarMonthsJST.test.mjs
// lib/ownerDeletion.js の addCalendarMonthsJST() の単体テスト。
// 「6か月」を暦月で加算し、加算先の月に存在しない日(月末起点)は丸めることを固定する
// (実装コメント参照。JSのDate.setMonth()に素直に任せると3月へ繰り上がる既知の挙動を
// 避けている)。日付はすべてテスト内でリテラルに組み立てており、実行時刻に依存しない。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addCalendarMonthsJST } from '../../lib/ownerDeletion.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// JSTの暦日時からms epochを組み立てる(月は1始まり、人間が読む表記に合わせる)。
function jst(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour, minute, second) - JST_OFFSET_MS;
}

test('addCalendarMonthsJST(): 8/31 + 6か月 → 平年の2月は28日に丸める', () => {
  const result = addCalendarMonthsJST(jst(2026, 8, 31), 6);
  assert.equal(result, jst(2027, 2, 28));
});

test('addCalendarMonthsJST(): 8/31 + 6か月 → 閏年の2月は29日に丸める', () => {
  // 2028年は閏年(4で割り切れ、100で割り切れない)
  const result = addCalendarMonthsJST(jst(2027, 8, 31), 6);
  assert.equal(result, jst(2028, 2, 29));
});

test('addCalendarMonthsJST(): 月末を跨がない加算では日付・時刻ともそのまま', () => {
  const result = addCalendarMonthsJST(jst(2026, 1, 15, 9, 30, 15), 6);
  assert.equal(result, jst(2026, 7, 15, 9, 30, 15));
});

test('addCalendarMonthsJST(): 年を跨ぎ、かつ月末で丸めが必要なケース', () => {
  const result = addCalendarMonthsJST(jst(2026, 12, 31), 2);
  assert.equal(result, jst(2027, 2, 28));
});

test('addCalendarMonthsJST(): 3月末(31日)+1か月は4月30日に丸める(4月は30日まで)', () => {
  const result = addCalendarMonthsJST(jst(2026, 3, 31), 1);
  assert.equal(result, jst(2026, 4, 30));
});
