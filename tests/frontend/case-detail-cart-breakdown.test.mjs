// tests/frontend/case-detail-cart-breakdown.test.mjs
//
// 案件詳細のカート内容カードに追加した「器具ごとの展開表示」(工程P2)の回帰テスト。
// public/index.html はJSモジュールとしてimportできない(ビルドステップなしのvanilla JS
// 1枚もの)ため、プレーンテキストとして読み、対象関数の本体を波括弧のカウントで
// 切り出したうえで正規表現/文字列検査する。
//
// 【固定長スライスを使わない理由】以前、目印コメントや行数を基準にした固定長スライスで
// 関数本体を切り出したところ、コメントが伸びた際に末尾が欠けて検査が素通りした事故が
// あったため、対応する`}`が見つかるまで深さをカウントする方式にしている。
//
// 【何をここでは検証しないか】ブラウザでの実際のレンダリング結果(DOM)はここでは検証
// しない。jsdom等のテスト基盤は意図的に導入していない(このリポジトリの既存方針)。
// あくまで「ソースコード上、期待する構造・分岐・文言がその位置にあるか」の固定検査。
//
// 【既知の落とし穴】この方式(文字列検索・波括弧カウント)は、実際にはHTML/JSの構文木を
// 見ていない素朴なテキスト処理なので、テンプレートリテラルの中に`>`や`{`/`}`を含む式が
// 出てくると誤検出しうる(本ファイルでも`<details${cartItems.length > ... }>`の比較演算子
// `>` をタグの終端`>`と誤認するバグを一度作っている → indexOfTagClose()参照)。新しいテストを
// 足すときは、対象のテンプレート文字列に`>`/`{`/`}`を含む式が無いか先に目視で確認すること。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');

// `function <name>(...) {` を起点に、対応する`}`までを波括弧の深さカウントで
// 切り出す。文字列・テンプレートリテラル・コメントの中身も区別せず単純にカウントする
// (このファイルの既存コードは各行のstyle文字列等を含め常に波括弧が対で閉じている前提。
//  対にならない場合は例外を投げて検知する)。
function extractFunctionBody(source, functionSignaturePattern) {
  const match = source.match(functionSignaturePattern);
  assert.ok(match, `関数の開始位置が見つかりません: ${functionSignaturePattern}`);
  const startOfBrace = match.index + match[0].length - 1; // マッチ末尾の`{`
  assert.equal(source[startOfBrace], '{', '関数シグネチャの直後が`{`ではありません');

  let depth = 0;
  for (let i = startOfBrace; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(startOfBrace, i + 1);
      }
    }
  }
  throw new Error('対応する`}`が見つかりませんでした(波括弧が対になっていません)');
}

test('extractFunctionBody: 波括弧カウントでネストした関数本体全体を取得できる(自己検証)', () => {
  const sample = `
function outer(x) {
  const style = "a { b: c; } d";
  if (x) {
    return { nested: () => { return 1; } };
  }
  return null;
}
function nextFunctionShouldNotBeIncluded() {}
`;
  const body = extractFunctionBody(sample, /function outer\(x\) \{/);
  assert.ok(body.includes('nested: () =>'), '入れ子の中身が欠けている');
  assert.ok(!body.includes('nextFunctionShouldNotBeIncluded'), '次の関数まで取り込んでしまっている(終端検出が壊れている)');
  assert.ok(body.trimEnd().endsWith('}'), '終端が閉じ括弧で終わっていない');
});

const renderCaseDetailBody = extractFunctionBody(
  INDEX_HTML,
  /function renderCaseDetail\(c, searches\) \{/
);
const renderCartItemsBreakdownBody = extractFunctionBody(
  INDEX_HTML,
  /function renderCartItemsBreakdown\(items\) \{/
);

// カート内容カードの<details>...</details>ブロックと、その中の<summary>...</summary>を
// 切り出す。renderCaseDetail()内に<details>はこの1箇所しかない前提(他に増えたら
// indexOf/lastIndexOfの単純な範囲取りが壊れるので、その時点でこのテストごと見直す)。
//
// 開始タグの終端`>`を単純にindexOf('>')で探すと、属性値のテンプレート式
// `${cartItems.length > CART_BREAKDOWN_AUTO_OPEN_MAX ? ...}` に含まれる比較演算子の
// `>` を拾ってしまう。`${...}`の中にいる間は`>`を無視するよう深さを数える。
function indexOfTagClose(str, fromIndex) {
  let depth = 0;
  for (let i = fromIndex; i < str.length; i++) {
    if (str[i] === '{' && str[i - 1] === '$') depth++;
    else if (str[i] === '}' && depth > 0) depth--;
    else if (str[i] === '>' && depth === 0) return i;
  }
  return -1;
}

function extractCartDetailsBlock() {
  const detailsStart = renderCaseDetailBody.indexOf('<details');
  assert.notEqual(detailsStart, -1, '<details>タグが見つからない');
  const detailsCloseTag = '</details>';
  const detailsEnd = renderCaseDetailBody.indexOf(detailsCloseTag, detailsStart);
  assert.notEqual(detailsEnd, -1, '</details>タグが見つからない');
  const detailsBlock = renderCaseDetailBody.slice(detailsStart, detailsEnd + detailsCloseTag.length);

  const summaryStart = detailsBlock.indexOf('<summary');
  assert.notEqual(summaryStart, -1, '<summary>タグが見つからない');
  const summaryCloseTag = '</summary>';
  const summaryEnd = detailsBlock.indexOf(summaryCloseTag, summaryStart);
  assert.notEqual(summaryEnd, -1, '</summary>タグが見つからない');

  const tagCloseIdx = indexOfTagClose(detailsBlock, 0);
  assert.notEqual(tagCloseIdx, -1, '<details>の開始タグの終端`>`が見つからない');

  return {
    detailsOpenTag: detailsBlock.slice(0, tagCloseIdx + 1),
    summaryBlock: detailsBlock.slice(summaryStart, summaryEnd + summaryCloseTag.length),
    afterSummaryBlock: detailsBlock.slice(summaryEnd + summaryCloseTag.length),
  };
}

test('カート内容カードの<details>がisArchived分岐でガードされていない(通常/アーカイブ共通)', () => {
  const cardMarker = '<div class="input-card">\n      <details';
  const idx = renderCaseDetailBody.indexOf(cardMarker);
  assert.notEqual(idx, -1, 'カート内容カードの<details>ブロックが見つからない(マークアップが変わった?)');

  // 直前に isArchived の三項演算子による空文字ガード(`${isArchived ? '' : ...}`)が
  // かかっていないかを、直前一定範囲の文字列で確認する。かかっているとアーカイブ済み
  // 案件でこのカードごと消えてしまい、P2の「通常案件でも出す」という目的が崩れる。
  const precedingWindow = renderCaseDetailBody.slice(Math.max(0, idx - 80), idx);
  assert.ok(
    !precedingWindow.includes("isArchived ? ''"),
    'カート内容カードがisArchivedの空文字ガードでラップされている(通常案件で消えてしまう)'
  );
});

test('集計行(点数/小計)が<summary>の中にあり、renderCartItemsBreakdown()呼び出しは<details>の中で<summary>より後にある', () => {
  const { summaryBlock, afterSummaryBlock } = extractCartDetailsBlock();

  assert.ok(
    summaryBlock.includes('${cartItems.length}点 / ${yen(cartSubtotal)}'),
    '集計行(点数/小計)が<summary>...</summary>の中に無い'
  );
  assert.ok(
    !summaryBlock.includes('renderCartItemsBreakdown('),
    'renderCartItemsBreakdown()の呼び出しが<summary>の中に紛れ込んでいる(展開時に集計行が二重になる)'
  );
  assert.ok(
    afterSummaryBlock.includes('renderCartItemsBreakdown(cartItems)'),
    'renderCartItemsBreakdown()の呼び出しが</summary>より後(<details>の中)に見つからない'
  );
});

test('renderCartItemsBreakdown() が renderCaseDetail() 内から一度だけ呼ばれている', () => {
  const calls = renderCaseDetailBody.match(/renderCartItemsBreakdown\(cartItems\)/g) || [];
  assert.equal(calls.length, 1, `呼び出し回数が想定と異なる(${calls.length}回)`);
});

test('<details>のopen属性がCART_BREAKDOWN_AUTO_OPEN_MAXとの比較で出し分けられている(しきい値そのものは固定しない)', () => {
  const { detailsOpenTag } = extractCartDetailsBlock();
  assert.match(
    detailsOpenTag,
    /<details\$\{cartItems\.length > CART_BREAKDOWN_AUTO_OPEN_MAX \? '' : ' open'\}>/,
    'open属性の条件式(CART_BREAKDOWN_AUTO_OPEN_MAXとの比較)が見つからない'
  );

  // しきい値の数値自体はテストに直書きしない(仕様変更のたびにテストを書き換える
  // 事態を避けるため)。定数として定義されていて、かつ有効な正の整数であることのみ確認する。
  const constMatch = INDEX_HTML.match(/const CART_BREAKDOWN_AUTO_OPEN_MAX = (\d+);/);
  assert.ok(constMatch, 'CART_BREAKDOWN_AUTO_OPEN_MAX の定数定義が見つからない');
  assert.ok(Number(constMatch[1]) > 0, 'しきい値が正の整数になっていない');
});

test('renderCartItemsBreakdown(): 空配列のとき「まだ器具が入っていません」を返す分岐がある', () => {
  assert.ok(
    /if \(!items\.length\) \{[\s\S]*?まだ器具が入っていません/.test(renderCartItemsBreakdownBody),
    '空カートの案内文、またはその手前のガード(!items.length)が見つからない'
  );
});

test('renderCartItemsBreakdown(): 器具名・型番・数量を表示している', () => {
  // manufacturer/nameは個別にescapeHtml(item.manufacturer)のような呼び方ではなく、
  // [item.manufacturer, item.name]を.map(escapeHtml)でまとめてエスケープしている
  // (次のテストの空白joinの都合)。ここでは両フィールドが対象配列に含まれることを見る。
  assert.ok(
    renderCartItemsBreakdownBody.includes('[item.manufacturer, item.name]'),
    'manufacturer/nameがエスケープ対象の配列に含まれていない'
  );
  assert.ok(
    renderCartItemsBreakdownBody.includes('.map(escapeHtml)'),
    'manufacturer/nameのエスケープ処理(.map(escapeHtml))が見つからない'
  );
  assert.ok(renderCartItemsBreakdownBody.includes('escapeHtml(item.modelNumber)'), 'modelNumberの表示が見つからない');
  assert.ok(renderCartItemsBreakdownBody.includes('item.quantity'), 'quantityの表示が見つからない');
});

test('renderCartItemsBreakdown(): manufacturer/nameを空白joinする際、片方が空でも余分な空白が残らない', () => {
  assert.ok(
    renderCartItemsBreakdownBody.includes(
      "[item.manufacturer, item.name].filter(Boolean).map(escapeHtml).join(' ')"
    ),
    'filter(Boolean)による空文字除去が見つからない(manufacturerが空のとき先頭に空白が残る可能性)'
  );
});

test('renderCartItemsBreakdown(): 単価未入力(0)の器具は金額を出さず「未入力」にする(NaN表示・0円との混同を避ける)', () => {
  assert.ok(
    renderCartItemsBreakdownBody.includes('isZeroPrice = !item.unitPrice || item.unitPrice <= 0'),
    '既存のisZeroPrice判定(renderCartItems()等と同じ条件式)が見つからない'
  );
  assert.ok(
    renderCartItemsBreakdownBody.includes("isZeroPrice ? '未入力' : yen(item.unitPrice * item.quantity)"),
    '未入力時に金額の代わりに「未入力」を出す分岐が見つからない'
  );
});

test('renderCartItemsBreakdown(): 読み取り専用(input/onclick/buttonを持たない)', () => {
  assert.ok(!/<input\b/i.test(renderCartItemsBreakdownBody), '<input>が含まれている(読み取り専用のはずが編集要素を持っている)');
  assert.ok(!/<button\b/i.test(renderCartItemsBreakdownBody), '<button>が含まれている(読み取り専用のはずが操作要素を持っている)');
  assert.ok(!/\bonclick\s*=/.test(renderCartItemsBreakdownBody), 'onclickが含まれている(読み取り専用のはずが操作要素を持っている)');
});

test('カート内容カードの集計行(点数/小計)が引き続き残っている(退行防止)', () => {
  assert.ok(
    renderCaseDetailBody.includes('${cartItems.length}点 / ${yen(cartSubtotal)}'),
    '既存の集計表示が失われている'
  );
});
