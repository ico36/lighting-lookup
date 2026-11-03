// tests/frontend/estimate-sheet-labor-visit-label.test.mjs
// 見積書(施工費・出張費・提出日)に関する3つの変更を固定する。
//
// 【A】施工費が0円のとき行を出さない。従来は出張費だけ`visit > 0`(テキスト版は
// `visitPrice > 0`)で非表示にしており、施工費は無条件に表示していた非対称を解消する。
// 合計・小計の計算式(materialSubtotal + labor + visit + extraTotal等)は変更しない
// (表示だけを変える)ため、その文字列が変わっていないことも固定する。
//
// 【C】施工費・出張費の項目名(ラベル)を編集可能にする。buildEstimateSheetHTML()・
// テキスト版テンプレート・フォーム(labor-label-input/visit-label-input)・
// showEstimateForm()(保存済みラベルの復元)・persistEstimateForm()(保存)・
// previewArchivedEstimate()(閲覧専用プレビュー)のすべてで、固定文字列「施工費」
// 「出張費」ではなく、estimateMeta.laborLabel/visitLabelを使うことを固定する。
//
// 【B】見積書の提出日(issueDate)を編集可能にする。フォーム(estimate-issue-date)・
// formatIssueDate()(JST安全な表示用フォーマット)・generateEstimateSheet()
// (空欄なら今日の日付にフォールバック)・showEstimateForm()(保存済みの値を
// 初期値として自動で埋めない)・persistEstimateForm()(保存)・
// previewArchivedEstimate()(issueDateがあれば使い、無ければcreatedAt)を固定する。
//
// このファイルの方式(public/index.htmlを文字列として読み、対象関数の本体を波括弧の
// カウントで切り出して構造を検査する)はtests/frontend/estimate-form-save.test.mjsで
// 確立済みの既存の流儀を踏襲する(実行はしない。buildEstimateSheetHTML()はescapeHtml()・
// yen()というモジュールスコープの関数を内部で呼ぶため、単体でnew Function()に通して
// 実行するには依存関数を別途提供する必要があり、このリポジトリの既存テストはどこも
// その手間を取っていない)。
//
// 例外としてformatIssueDate()だけは、DOM・escapeHtml()・yen()のいずれにも依存しない
// 純粋関数(文字列を受け取り文字列を返すだけ)なので、new Function()に通して実際に
// 実行し、JST安全な日付変換(年・月・日に分けてローカル時刻のDateを組み立てる)が
// 正しく動くことを直接検証する。ここはこのタスクで名指しされた「new Date('YYYY-MM-DD')
// はUTC深夜0時解釈になる」罠そのものの検証なので、構造だけを見る既存の流儀より
// 実際に実行して確認する価値が高いと判断した。

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

const buildEstimateSheetHTMLBody = extractFunctionBody(
  INDEX_HTML,
  /function buildEstimateSheetHTML\(\{[\s\S]*?\}\) \{/
);
const generateEstimateSheetBody = extractFunctionBody(
  INDEX_HTML,
  /async function generateEstimateSheet\(btn\) \{/
);
const showEstimateFormBody = extractFunctionBody(INDEX_HTML, /function showEstimateForm\(\) \{/);
const persistEstimateFormBody = extractFunctionBody(INDEX_HTML, /async function persistEstimateForm\(\) \{/);
const previewArchivedEstimateBody = extractFunctionBody(
  INDEX_HTML,
  /function previewArchivedEstimate\(caseId\) \{/
);
const formatIssueDateBody = extractFunctionBody(INDEX_HTML, /function formatIssueDate\(dateOnlyStr\) \{/);

// ===== A. buildEstimateSheetHTML(): 施工費行が labor > 0 で分岐する(出張費と同じ扱い) =====

test('buildEstimateSheetHTML(): 施工費行は labor > 0 のときだけ表示する(出張費の visit > 0 と同じ扱い)', () => {
  assert.match(
    buildEstimateSheetHTMLBody,
    /\$\{labor > 0 \? `[\s\S]*?<\/tr>` : ''\}/,
    '施工費行が labor > 0 の三項演算子で囲まれていない'
  );
  assert.match(
    buildEstimateSheetHTMLBody,
    /\$\{visit > 0 \? `[\s\S]*?<\/tr>` : ''\}/,
    '出張費行が visit > 0 の三項演算子で囲まれていない(既存の挙動が壊れている)'
  );
});

test('buildEstimateSheetHTML(): 施工費行が無条件(三項演算子の外)で表示される書き方が復活していない', () => {
  // 旧実装は `<td><div class="sheet-item-name">施工費</div></td>` が
  // `${labor > 0 ? ... }` の外、itemRowsHTMLの直後に無条件で置かれていた。
  const unconditionalLaborRow =
    /\$\{itemRowsHTML\}\s*<tr>\s*<td><div class="sheet-item-name">施工費<\/div><\/td>/;
  assert.ok(
    !unconditionalLaborRow.test(buildEstimateSheetHTMLBody),
    '施工費行が条件分岐の外で無条件に表示されている(出張費と非対称のまま)'
  );
});

test('buildEstimateSheetHTML(): 小計・合計の計算式は変更していない(表示だけを変える)', () => {
  assert.ok(
    buildEstimateSheetHTMLBody.includes('const subtotal = materialSubtotal + labor + visit + extraTotal;'),
    '小計の計算式が変わっている(表示条件の変更に計算式を巻き込んではいけない)'
  );
});

// ===== A. テキスト版(generateEstimateSheet()内のwindow._lastEstimateTextテンプレート):
//          施工費行が laborPrice > 0 で分岐する(出張費と同じ扱い) =====

test('generateEstimateSheet(): テキスト版の施工費行は laborPrice > 0 のときだけ出す(出張費の visitPrice > 0 と同じ扱い)', () => {
  assert.match(
    generateEstimateSheetBody,
    /\$\{laborPrice > 0 \? laborLabel \+ '：' \+ yen\(laborPrice\) \+ '\\n' : ''\}/,
    '施工費行が laborPrice > 0 の三項演算子で囲まれていない、またはlaborLabelを使っていない'
  );
  assert.match(
    generateEstimateSheetBody,
    /\$\{visitPrice > 0 \? visitLabel \+ '：' \+ yen\(visitPrice\) \+ '\\n' : ''\}/,
    '出張費行が visitPrice > 0 の三項演算子で囲まれていない、またはvisitLabelを使っていない'
  );
});

test('generateEstimateSheet(): テキスト版の小計・合計の計算式は変更していない', () => {
  assert.ok(
    generateEstimateSheetBody.includes(
      'const subtotal = materialSubtotal + laborPrice + visitPrice + extraItemsTotal;'
    ),
    '小計の計算式が変わっている(表示条件の変更に計算式を巻き込んではいけない)'
  );
});

// ===== C. フォーム: 施工費・出張費の固定ラベル(span)が項目名の入力欄(input)に
//          置き換わっていること =====

test('フォーム: 施工費・出張費が固定の<span>ではなく、50文字制限付きの入力欄(labor-label-input/visit-label-input)になっている', () => {
  assert.match(
    INDEX_HTML,
    /<input type="text" class="stacked-input" id="labor-label-input" placeholder="施工費" maxlength="50"/,
    'labor-label-inputが見つからない、またはmaxlength=50が付いていない'
  );
  assert.match(
    INDEX_HTML,
    /<input type="text" class="stacked-input" id="visit-label-input" placeholder="出張費" maxlength="50"/,
    'visit-label-inputが見つからない、またはmaxlength=50が付いていない'
  );
  assert.ok(
    !/<span class="field-key"[^>]*>施工費<\/span>/.test(INDEX_HTML),
    '施工費の固定<span>が復活している(入力欄に置き換えたはず)'
  );
  assert.ok(
    !/<span class="field-key"[^>]*>出張費<\/span>/.test(INDEX_HTML),
    '出張費の固定<span>が復活している(入力欄に置き換えたはず)'
  );
});

// ===== C. buildEstimateSheetHTML(): laborLabel/visitLabelを受け取り、空欄なら
//          初期値にフォールバックしてescapeHtml()に通す(escapeHtml(値 || フォールバック)の順) =====

test('buildEstimateSheetHTML(): laborLabel/visitLabelを引数に受け取る', () => {
  assert.match(
    INDEX_HTML,
    /function buildEstimateSheetHTML\(\{[^}]*\blaborLabel\b[^}]*\bvisitLabel\b[^}]*\}\) \{/,
    '引数の分割代入にlaborLabel/visitLabelが無い'
  );
});

test('buildEstimateSheetHTML(): フォールバックをescapeHtml()に渡す前に確定させている(escapeHtml(x) || fallbackの順にしない)', () => {
  assert.match(
    buildEstimateSheetHTMLBody,
    /const displayLaborLabel = String\(laborLabel \|\| ''\)\.trim\(\) \|\| DEFAULT_LABOR_LABEL;/,
    'displayLaborLabelの組み立てが見つからない、またはフォールバックの順序が違う'
  );
  assert.match(
    buildEstimateSheetHTMLBody,
    /const displayVisitLabel = String\(visitLabel \|\| ''\)\.trim\(\) \|\| DEFAULT_VISIT_LABEL;/,
    'displayVisitLabelの組み立てが見つからない、またはフォールバックの順序が違う'
  );
  assert.ok(
    buildEstimateSheetHTMLBody.includes('${escapeHtml(displayLaborLabel)}'),
    '施工費行がescapeHtml(displayLaborLabel)を使っていない'
  );
  assert.ok(
    buildEstimateSheetHTMLBody.includes('${escapeHtml(displayVisitLabel)}'),
    '出張費行がescapeHtml(displayVisitLabel)を使っていない'
  );
  assert.ok(
    !/escapeHtml\(laborLabel\)\s*\|\|/.test(buildEstimateSheetHTMLBody) &&
      !/escapeHtml\(visitLabel\)\s*\|\|/.test(buildEstimateSheetHTMLBody),
    'escapeHtml(x) || fallbackという逆順の書き方になっている'
  );
});

// ===== C. generateEstimateSheet(): DOMからlaborLabel/visitLabelを読み、
//          buildEstimateSheetHTML()とテキスト版の両方に渡す =====

test('generateEstimateSheet(): labor-label-input/visit-label-inputをDOMから読み、空欄なら初期値にフォールバックする', () => {
  assert.match(
    generateEstimateSheetBody,
    /const laborLabel = document\.getElementById\('labor-label-input'\)\.value\.trim\(\) \|\| DEFAULT_LABOR_LABEL;/,
    'laborLabelの読み取り+フォールバックが見つからない'
  );
  assert.match(
    generateEstimateSheetBody,
    /const visitLabel = document\.getElementById\('visit-label-input'\)\.value\.trim\(\) \|\| DEFAULT_VISIT_LABEL;/,
    'visitLabelの読み取り+フォールバックが見つからない'
  );
});

test('generateEstimateSheet(): buildEstimateSheetHTML()呼び出しにlaborLabel/visitLabelを渡している', () => {
  assert.match(
    generateEstimateSheetBody,
    /buildEstimateSheetHTML\(\{[\s\S]*?laborLabel,[\s\S]*?visitLabel,[\s\S]*?\}\)/,
    'buildEstimateSheetHTML()の呼び出しにlaborLabel/visitLabelが渡されていない'
  );
});

// ===== C. showEstimateForm(): 保存済みのlaborLabel/visitLabelを復元する =====

test('showEstimateForm(): meta.laborLabel/meta.visitLabelをlabor-label-input/visit-label-inputに復元する(空なら初期値)', () => {
  assert.match(
    showEstimateFormBody,
    /document\.getElementById\('labor-label-input'\)\.value = meta\.laborLabel \|\| DEFAULT_LABOR_LABEL;/,
    'labor-label-inputへの復元が見つからない'
  );
  assert.match(
    showEstimateFormBody,
    /document\.getElementById\('visit-label-input'\)\.value = meta\.visitLabel \|\| DEFAULT_VISIT_LABEL;/,
    'visit-label-inputへの復元が見つからない'
  );
});

// ===== C. persistEstimateForm(): labor-label-input/visit-label-inputを読み、
//          estimateMetaとして保存する =====

test('persistEstimateForm(): labor-label-input/visit-label-inputを読み、estimateMetaにlaborLabel/visitLabelとして含める', () => {
  assert.match(
    persistEstimateFormBody,
    /const laborLabel = document\.getElementById\('labor-label-input'\)\.value\.trim\(\);/,
    'laborLabelの読み取りが見つからない'
  );
  assert.match(
    persistEstimateFormBody,
    /const visitLabel = document\.getElementById\('visit-label-input'\)\.value\.trim\(\);/,
    'visitLabelの読み取りが見つからない'
  );
  assert.ok(
    persistEstimateFormBody.includes('laborLabel, visitLabel'),
    'estimateMetaのオブジェクトリテラルにlaborLabel, visitLabelが含まれていない'
  );
});

// ===== C. previewArchivedEstimate(): 保存済みのlaborLabel/visitLabelをそのまま
//          buildEstimateSheetHTML()に渡す(閲覧専用プレビューも同じラベルを表示する) =====

test('previewArchivedEstimate(): c.estimateMeta.laborLabel/visitLabelをbuildEstimateSheetHTML()に渡す', () => {
  assert.match(
    previewArchivedEstimateBody,
    /buildEstimateSheetHTML\(\{[\s\S]*?laborLabel: c\.estimateMeta\?\.laborLabel,[\s\S]*?visitLabel: c\.estimateMeta\?\.visitLabel,[\s\S]*?\}\)/,
    'previewArchivedEstimate()がlaborLabel/visitLabelを渡していない'
  );
});

// ===== B. フォーム: 提出日(issueDate)の入力欄(type="date")がある =====

test('フォーム: estimate-issue-dateがtype="date"の入力欄として存在する', () => {
  assert.match(
    INDEX_HTML,
    /<input type="date" id="estimate-issue-date" class="stacked-input"/,
    'estimate-issue-date(提出日の入力欄)が見つからない、またはtype="date"ではない'
  );
});

// ===== B. formatIssueDate(): JST安全な日付変換を実際に実行して検証する =====
// (このファイル冒頭のコメント参照: この関数だけはDOM・escapeHtml()・yen()に依存しない
// 純粋関数なので、構造チェックではなく実行して検証する)

function runFormatIssueDate(dateOnlyStr) {
  const fn = new Function('dateOnlyStr', formatIssueDateBody.slice(1, -1));
  return fn(dateOnlyStr);
}

test('formatIssueDate(): "YYYY-MM-DD"をtodayStrと同じ表示形式(年月日の長い形式)に変換する', () => {
  assert.equal(runFormatIssueDate('2026-11-02'), '2026年11月2日');
  assert.equal(runFormatIssueDate('2026-01-01'), '2026年1月1日');
  assert.equal(runFormatIssueDate('2026-12-31'), '2026年12月31日');
});

test('formatIssueDate(): new Date("YYYY-MM-DD")のUTC解釈による日付ずれの罠を踏んでいない(年月日を分けて組み立てている)', () => {
  // new Date('2026-01-01')はUTC深夜0時として解釈されるため、UTC-9時間より西側の
  // タイムゾーン(例: アメリカ大陸)で実行すると前日(2025-12-31)にずれる、という
  // クラスの不具合をformatIssueDate()が踏んでいないことを確認する。年・月・日を
  // 分けてnew Date(year, month-1, day)(ローカル時刻のコンストラクタ)を使っていれば、
  // 実行環境のタイムゾーンに関わらず常に入力した日付と同じ年月日が返るはず。
  assert.equal(
    runFormatIssueDate('2026-01-01'),
    '2026年1月1日',
    '月初(1月1日)の変換がずれている(UTC解釈の罠を踏んでいる疑い)'
  );
  assert.ok(
    formatIssueDateBody.includes('new Date(year, month - 1, day)'),
    'new Date(year, month - 1, day)というローカル時刻コンストラクタの組み立てが見つからない' +
      '(new Date(dateOnlyStr)のような文字列を直接渡す書き方だとUTC解釈の罠を踏む)'
  );
});

// ===== B. generateEstimateSheet(): estimate-issue-dateが空欄なら今日の日付(todayStr)、
//          入力済みならformatIssueDate()で変換した値を使う =====

test('generateEstimateSheet(): issueDateInputが空欄ならtodayStr、入力済みならformatIssueDate()の結果を使う', () => {
  assert.match(
    generateEstimateSheetBody,
    /const issueDateInput = document\.getElementById\('estimate-issue-date'\)\.value;/,
    'estimate-issue-dateの読み取りが見つからない'
  );
  assert.match(
    generateEstimateSheetBody,
    /const issueDateDisplay = issueDateInput \? formatIssueDate\(issueDateInput\) : todayStr;/,
    '空欄→todayStr、入力済み→formatIssueDate()という分岐が見つからない'
  );
});

test('generateEstimateSheet(): buildEstimateSheetHTML()とテキスト版の両方にissueDateDisplayを渡す(todayStrを直接渡す書き方が復活していない)', () => {
  assert.match(
    generateEstimateSheetBody,
    /buildEstimateSheetHTML\(\{[\s\S]*?issueDate: issueDateDisplay,[\s\S]*?\}\)/,
    'buildEstimateSheetHTML()にissueDateDisplayが渡されていない'
  );
  assert.ok(
    generateEstimateSheetBody.includes('御見積書（${issueDateDisplay}）'),
    'テキスト版の見出しがissueDateDisplayを使っていない'
  );
  assert.ok(
    !generateEstimateSheetBody.includes('issueDate: todayStr'),
    'buildEstimateSheetHTML()にtodayStrを直接渡す書き方が復活している(提出日入力が無視される)'
  );
});

// ===== B. showEstimateForm(): 保存済みのissueDateを初期値として自動で埋めない =====

test('showEstimateForm(): estimate-issue-dateを常に空欄にする(meta.issueDateを初期値に入れない)', () => {
  assert.match(
    showEstimateFormBody,
    /document\.getElementById\('estimate-issue-date'\)\.value = '';/,
    'estimate-issue-dateを空欄に戻す処理が見つからない'
  );
  assert.ok(
    !/document\.getElementById\('estimate-issue-date'\)\.value = meta\.issueDate/.test(showEstimateFormBody),
    'meta.issueDateを初期値として入れている(保存した日付を自動で埋めない、という仕様に反する)'
  );
});

// ===== B. persistEstimateForm(): estimate-issue-dateを読み、issueDateとして保存する =====

test('persistEstimateForm(): estimate-issue-dateを読み、estimateMetaにissueDateとして含める', () => {
  assert.match(
    persistEstimateFormBody,
    /const issueDate = document\.getElementById\('estimate-issue-date'\)\.value;/,
    'issueDateの読み取りが見つからない'
  );
  assert.ok(
    persistEstimateFormBody.includes('laborLabel, visitLabel, issueDate, bizNote'),
    'estimateMetaのオブジェクトリテラルにissueDateが含まれていない'
  );
});

// ===== B. previewArchivedEstimate(): c.estimateMeta.issueDateがあれば使い、無ければ
//          c.createdAtを使う(既存のフォールバックを壊さない) =====

test('previewArchivedEstimate(): issueDateがあればformatIssueDate()で変換し、無ければcreatedAtにフォールバックする', () => {
  assert.match(
    previewArchivedEstimateBody,
    /const issueDate = c\.estimateMeta\?\.issueDate\s*\n\s*\? formatIssueDate\(c\.estimateMeta\.issueDate\)\s*\n\s*: new Date\(c\.createdAt\)\.toLocaleDateString\('ja-JP', \{ year: 'numeric', month: 'long', day: 'numeric' \}\);/,
    'issueDate → formatIssueDate()、無ければcreatedAtへのフォールバックが見つからない'
  );
});
