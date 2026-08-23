// tests/frontend/estimate-form-writeback-guard.test.mjs
//
// 見積書フォームの未保存入力が消える不具合の修正(showEstimateForm()の書き戻し6行を
// estimateFormCaseId !== currentCartCaseId のときだけ実行する)を固定する。
//
// P2(tests/frontend/case-detail-cart-breakdown.test.mjs)で確立した方式(public/index.html
// を文字列として読み、対象関数の本体を波括弧のカウントで切り出して構造・分岐・文言を
// 検査する)を踏襲する。extractFunctionBody()の実装・落とし穴・自己検証テストは同ファイル
// でカバー済みのため、ここでは重複させない。
//
// 【extractFunctionBody()をif文の切り出しにも使う理由】extractFunctionBody()は実際には
// 「`{`で終わる正規表現にマッチした位置から、対応する`}`までを波括弧の深さカウントで
// 切り出す」だけの汎用ヘルパーで、対象が`function ... {`である必要はない。
// `if (estimateFormCaseId !== currentCartCaseId) {`も同じ形(`{`で終わる)なので、
// showEstimateForm()の本体に対して同じ関数をそのまま再利用し、if文の切り出し専用の
// 別ヘルパーは新設しない。
//
// 【今回は indexOfTagClose() 相当のワークアラウンドが不要な理由】case-manual-archive.test.mjs
// の先例と同じ判断。showEstimateForm()はHTMLタグやテンプレートリテラルの`${...}`を含まず、
// 比較演算子`>`や対になっていない`{`/`}`も含まない(このファイルの自己検証テストで実際に
// 波括弧の対応が取れていることを確認済み)。そのためタグ境界の誤検出は起こりえず、
// 波括弧の深さカウントだけで完結するextractFunctionBody()をそのまま使う。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');

function extractFunctionBody(source, functionSignaturePattern) {
  const match = source.match(functionSignaturePattern);
  assert.ok(match, `開始位置が見つかりません: ${functionSignaturePattern}`);
  const startOfBrace = match.index + match[0].length - 1; // マッチ末尾の`{`
  assert.equal(source[startOfBrace], '{', 'シグネチャの直後が`{`ではありません');

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

const showEstimateFormBody = extractFunctionBody(INDEX_HTML, /function showEstimateForm\(\) \{/);
const doLogoutBody = extractFunctionBody(INDEX_HTML, /function doLogout\(\) \{/);
// 引数名(btn, caseId)までは固定しない。引数名のリネームはこのテストの関心事(分岐と
// 書き込み行の位置関係)と無関係で、リネームのたびにテストが落ちるのは意図した挙動ではない。
// ただしextractFunctionBody()はマッチした文字列の末尾が`{`であることを前提にしている
// ため、`(`の後ろで正規表現を打ち切らず、`[^)]*\) \{`で引数の中身を種類・個数を問わず
// 読み飛ばしたうえで、確実に開き波括弧まで消費する。
const archiveCaseHandlerBody = extractFunctionBody(INDEX_HTML, /async function archiveCaseHandler\([^)]*\) \{/);
const refreshCartCaseBody = extractFunctionBody(INDEX_HTML, /async function refreshCartCase\(\) \{/);

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 6欄への.value書き込み行(getElementByIdの引数部分までを固定し、右辺のフォールバック式
// までは固定しない。フォールバック式自体は別の調査/テストの対象であり、ここで見たいのは
// 「書き込み先とif分岐の位置関係」のみのため)。
const WRITE_LINE_PATTERNS = [
  "document.getElementById('estimate-case-name-input').value =",
  "document.getElementById('client-name').value =",
  "document.getElementById('client-site').value =",
  "document.getElementById('price-labor').value =",
  "document.getElementById('price-visit').value =",
  "document.getElementById('biz-note').value =",
];

test('showEstimateForm(): if (estimateFormCaseId !== currentCartCaseId) の分岐が存在する', () => {
  assert.ok(
    showEstimateFormBody.includes('if (estimateFormCaseId !== currentCartCaseId) {'),
    '一致判定のif文が見つからない(条件式の書き方が変わった可能性)'
  );
});

test('showEstimateForm(): 6欄への.value書き込みが、すべてif (estimateFormCaseId !== currentCartCaseId)の内側にある', () => {
  const ifBody = extractFunctionBody(showEstimateFormBody, /if \(estimateFormCaseId !== currentCartCaseId\) \{/);

  for (const linePattern of WRITE_LINE_PATTERNS) {
    assert.ok(
      ifBody.includes(linePattern),
      `if ブロックの内側に書き込み行が見つからない: ${linePattern}`
    );
  }

  // ifブロックを取り除いた残り(=showEstimateForm()本体のうち条件式の外側)に
  // 書き込み行が漏れ出していないかも確認する。単に「ifの中にある」だけでは、
  // 同じ行が外側にも重複して存在するケース(例えば貼り付けミスで2回書かれている)
  // を見逃すため。
  const outsideIfBody = showEstimateFormBody.replace(ifBody, '');
  for (const linePattern of WRITE_LINE_PATTERNS) {
    assert.ok(
      !outsideIfBody.includes(linePattern),
      `書き込み行がif ブロックの外側にも存在する(重複): ${linePattern}`
    );
  }
});

test('showEstimateForm(): estimateFormCaseId = currentCartCaseId; はif ブロックの外側、かつ関数の内側にある', () => {
  const ifBody = extractFunctionBody(showEstimateFormBody, /if \(estimateFormCaseId !== currentCartCaseId\) \{/);

  assert.ok(
    showEstimateFormBody.includes('estimateFormCaseId = currentCartCaseId;'),
    'estimateFormCaseId = currentCartCaseId; がshowEstimateForm()の中に見つからない'
  );
  assert.ok(
    !ifBody.includes('estimateFormCaseId = currentCartCaseId;'),
    'estimateFormCaseId = currentCartCaseId; がif ブロックの内側に紛れ込んでいる' +
      '(内側にあると、一致判定でスキップされたときに記録が更新されず、次回以降も判定が壊れたままになる)'
  );
});

test('showEstimateForm(): updateEstimatePreview()の呼び出しはif ブロックの外側にある', () => {
  const ifBody = extractFunctionBody(showEstimateFormBody, /if \(estimateFormCaseId !== currentCartCaseId\) \{/);

  assert.ok(
    showEstimateFormBody.includes('updateEstimatePreview();'),
    'updateEstimatePreview()の呼び出しがshowEstimateForm()の中に見つからない'
  );
  assert.ok(
    !ifBody.includes('updateEstimatePreview();'),
    'updateEstimatePreview()がif ブロックの内側に紛れ込んでいる' +
      '(内側にあると、書き戻しをスキップしたときにプレビューが更新されなくなる)'
  );
});

// メッセージ(estimate-form-error・estimate-form-save-msg)のクリアは、6欄の書き戻しとは
// 逆に「常に実行される」ことを固定する。メッセージは直前の操作結果を伝える一時的な表示
// であり、入力値のような保護すべき情報ではないため、estimateFormCaseIdガードの外に
// 置いて同じ案件で開き直したときも含めて毎回クリアする(showEstimateForm()のコメント参照)。
test('showEstimateForm(): estimate-form-error・estimate-form-save-msgのクリアはif ブロックの外側にある(毎回実行される)', () => {
  const ifBody = extractFunctionBody(showEstimateFormBody, /if \(estimateFormCaseId !== currentCartCaseId\) \{/);

  assert.ok(
    showEstimateFormBody.includes("hideError(document.getElementById('estimate-form-error'));"),
    'estimate-form-errorをhideError()でクリアする処理がshowEstimateForm()の中に見つからない'
  );
  assert.ok(
    !ifBody.includes("hideError(document.getElementById('estimate-form-error'));"),
    'estimate-form-errorのクリアがif ブロックの内側に紛れ込んでいる' +
      '(内側にあると、同じ案件で開き直したときにクリアされず、古いエラーが残る)'
  );

  assert.ok(
    showEstimateFormBody.includes("document.getElementById('estimate-form-save-msg').textContent = '';"),
    'estimate-form-save-msgのクリアがshowEstimateForm()の中に見つからない'
  );
  assert.ok(
    !ifBody.includes("document.getElementById('estimate-form-save-msg').textContent = '';"),
    'estimate-form-save-msgのクリアがif ブロックの内側に紛れ込んでいる' +
      '(内側にあると、同じ案件で開き直したときにクリアされず、古い「保存しました」が残る)'
  );
});

// `let estimateFormCaseId = null;`(3672行目の初期宣言)は「リセット代入」ではないため、
// 直前が`let `ではないものだけを数える(負の後読み)。宣言行を除外しないと、単純な部分
// 文字列一致では総数が4件(宣言1+リセット3)になってしまう。
//
// 【gフラグの扱いについて】このパターンをRegExpインスタンスとして1つ作って使い回すと、
// .exec()/.test()ではlastIndexが呼び出しをまたいで持ち越され、2回目以降の結果がずれる
// 恐れがある(String.prototype.matchはSymbol.match経由でlastIndexを内部的に0に戻すため
// 本来は安全だが、念のため呼び出しごとに`new RegExp(...)`で新しいインスタンスを作り、
// その懸念自体を発生させない書き方にする)。
const RESET_ASSIGNMENT_SOURCE = '(?<!let )estimateFormCaseId = null;';

test('estimateFormCaseId = null; がリポジトリ全体で3箇所だけ存在し、それぞれdoLogout()・archiveCaseHandler()・refreshCartCase()の中にある', () => {
  const totalCount = (INDEX_HTML.match(new RegExp(RESET_ASSIGNMENT_SOURCE, 'g')) || []).length;
  assert.equal(totalCount, 3, `estimateFormCaseId = null; の総出現数が想定と異なる(${totalCount}件)`);

  for (const [label, body] of [
    ['doLogout()', doLogoutBody],
    ['archiveCaseHandler()', archiveCaseHandlerBody],
    ['refreshCartCase()', refreshCartCaseBody],
  ]) {
    const count = (body.match(new RegExp(RESET_ASSIGNMENT_SOURCE, 'g')) || []).length;
    assert.equal(count, 1, `${label} の中に estimateFormCaseId = null; がちょうど1件見つからない(${count}件)`);
  }
});

test('6欄への.value書き込みは、リポジトリ全体でshowEstimateForm()の中にしか存在しない(この設計の前提)', () => {
  for (const linePattern of WRITE_LINE_PATTERNS) {
    const totalCount = (INDEX_HTML.match(new RegExp(escapeRegExp(linePattern), 'g')) || []).length;
    assert.equal(
      totalCount,
      1,
      `${linePattern} がリポジトリ全体で1箇所ではない(${totalCount}件)。` +
        'showEstimateForm()以外にも書き込みが増えている場合、estimateFormCaseIdによる' +
        '一致判定だけでは未保存入力を守れない(この判定はshowEstimateForm()一箇所に' +
        '書き込みが閉じていることが前提)。'
    );
  }
});
