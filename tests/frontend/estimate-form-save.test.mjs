// tests/frontend/estimate-form-save.test.mjs
// 残課題⑥・工程E2(見積書フォームの一括保存)で入れた構造を固定するE3テスト。
//
// P2(case-detail-cart-breakdown.test.mjs)で確立した方式(public/index.htmlを文字列として
// 読み、対象関数の本体を波括弧のカウントで切り出して構造・分岐・文言を検査する)を踏襲する。
// extractFunctionBody()の実装・落とし穴・自己検証テストは同ファイルでカバー済みのため、
// ここでは重複させない。
//
// 【indexOfTagClose()相当のワークアラウンドが不要な理由】case-manual-archive.test.mjsと
// 同じ判断。対象3関数(persistEstimateForm()・saveEstimateForm()・generateEstimateSheet())は
// いずれも波括弧カウントでの抽出が正常に完了することを事前にnodeで確認済み。
// generateEstimateSheet()は`items.filter(item => ...)`のようなアロー関数由来の`>`を
// 含むが、これは比較演算子でもHTMLタグの境界でもなく、このテストファイル自体が
// indexOf('>')のようなタグ境界探索ロジックを持たないため影響しない。
//
// 【見送った3項目とその理由】
// - 案件名・宛名の空欄ガードが「無いこと」の固定: 「無いこと」を固定すると将来の実装を
//   先回りで縛ってしまう。宛名の必須化は実際にD2で入れた経緯があり、同種の判断が
//   将来この欄にも起こり得る。
// - saveEstimateForm()の「保存しました」の全文一致: 文言の重さに対してテストの維持
//   コストが見合わない(case-manual-archive.test.mjsのconfirm3行の全文一致は、取り消し
//   不能な操作の説明という重さがあったための例外であり、ここでは同列に扱わない)。
// - 「入力内容を保存」ボタンが「見積書を生成」ボタンより前(HTML上で先)にあることの固定:
//   ボタンを1つ足すだけで壊れるわりに、壊れても実害は見た目(順序)のみに留まる。
//
// スクロール挙動(revealErrorEl()のblockやscroll-margin-top)もE2の範囲外(別コミット)
// のため対象外。
//
// 【R3(extraItems)で追加した2項目】persistEstimateForm()・generateEstimateSheet()が
// 共通の読み取りヘルパーreadExtraItemsFromDOM()を呼んでいることを固定する(下記
// 「readExtraItemsFromDOM()を呼ぶ」の2テスト)。空行の除外条件をこの2箇所が別々に
// 持つ二重管理を再発させないための固定。
//
// 【R3(extraItems)で見送った候補とその理由】
// - createExtraItemRowHTML()のflex:6/flex:4という具体的な幅比率の固定: この機能は
//   108px固定→130px固定→flex:6/4と短期間に3回幅の配分が変わっており、UIの微調整が
//   今後も起こりやすい実装詳細。ここを固定すると、次に比率を調整するたびにテストの
//   修正が必要になり、テストの維持コストが実際に守りたい価値(見た目の破綻防止)を
//   上回ると判断した。
// - .extra-item-rowの折り返し・モバイル幅での見た目: このファイルの方式(文字列読み+
//   波括弧カウント)はDOMレイアウト計算を伴わないため、実際の折り返し・幅の見た目は
//   そもそも検証できない。
// - updateEstimatePreview()の合計金額計算(materialSubtotal + laborPrice + visitPrice +
//   extraItemsTotal)にextraItemsが含まれること: readExtraItemsFromDOM()を呼んでいる
//   こと自体は他の2箇所と同じパターンで固定できるが、計算式そのものの文字列一致は
//   壊れやすく、実際の計算結果(動的な値)はこの方式(実行せずソースを読むだけ)では
//   検証できない。観点の目安にも明示されていなかったため優先度は低いと判断した。

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

const persistEstimateFormBody = extractFunctionBody(INDEX_HTML, /async function persistEstimateForm\(\) \{/);
const saveEstimateFormBody = extractFunctionBody(INDEX_HTML, /async function saveEstimateForm\(btn\) \{/);
const generateEstimateSheetBody = extractFunctionBody(INDEX_HTML, /async function generateEstimateSheet\(btn\) \{/);

// ===== 1. persistEstimateForm(): 6欄すべてをDOMから読んでいること =====

const READ_LINE_PATTERNS = [
  "document.getElementById('estimate-case-name-input').value",
  "document.getElementById('client-name').value",
  "document.getElementById('client-site').value",
  "document.getElementById('price-labor').value",
  "document.getElementById('price-visit').value",
  "document.getElementById('biz-note').value",
];

test('persistEstimateForm(): 案件名・お客様名・工事場所・施工費・出張費・備考の6欄すべてをDOMから読んでいる', () => {
  for (const linePattern of READ_LINE_PATTERNS) {
    assert.ok(
      persistEstimateFormBody.includes(linePattern),
      `6欄のうち読み取りが見つからない: ${linePattern}`
    );
  }
});

// ===== 2. persistEstimateForm(): estimateFormSaveキーでPATCHを送っていること =====

// estimateMetaのオブジェクトリテラル全体を1つの文字列で完全一致させると、フィールドが
// 1つ増えるたびに(並び順・スペースの書き方が変わっただけでも)このテストが落ちる。
// ここで固定したいのは「estimateFormSaveキーで送っていること」と「必要なフィールドが
// 含まれていること」であって、リテラル全体の形ではないため、各識別子の有無を個別に確認する。
test('persistEstimateForm(): estimateFormSaveキーでcustomerNameとestimateMetaをまとめて送っている', () => {
  assert.ok(
    persistEstimateFormBody.includes('estimateFormSave: {'),
    'PATCHのbodyにestimateFormSaveキーが見つからない(サーバー側E1のcontractと不一致の疑い)'
  );
  assert.ok(
    persistEstimateFormBody.includes('estimateMeta: {'),
    'estimateMetaキーが見つからない'
  );
  const ESTIMATE_META_FIELDS = ['clientName', 'clientSite', 'laborPrice', 'visitPrice', 'bizNote', 'extraItems'];
  for (const field of ESTIMATE_META_FIELDS) {
    assert.ok(
      persistEstimateFormBody.includes(field),
      `estimateMetaの中身にフィールドが見つからない: ${field}`
    );
  }
});

// ===== 4. persistEstimateForm(): currentCartCaseId無しでerr.code = 'no_case'をthrowすること =====

test("persistEstimateForm(): currentCartCaseIdが無いときerr.code = 'no_case'でthrowする", () => {
  assert.match(
    persistEstimateFormBody,
    /if \(!currentCartCaseId\) \{[\s\S]*?err\.code = 'no_case';[\s\S]*?throw err;/,
    "!currentCartCaseIdの分岐でerr.code = 'no_case'を付けてthrowする処理が見つからない" +
      '(黙ってnullを返すと、呼び出し元が保存していないのに成功したとみなす恐れがある)'
  );
});

// ===== 5. persistEstimateForm(): PATCH失敗時にerr.codeを付与すること =====

test("persistEstimateForm(): PATCH失敗時、401はerr.code = 'session_expired'、CASE_ARCHIVEDはerr.code = 'case_archived'を付ける", () => {
  assert.match(
    persistEstimateFormBody,
    /if \(!response\.ok\) \{[\s\S]*?err\.code = 'session_expired';[\s\S]*?err\.code = 'case_archived';[\s\S]*?throw err;/,
    'response.ok===falseの分岐でsession_expired/case_archivedの判定・throwが見つからない'
  );
});

// ===== 6. saveEstimateForm(): withButtonGuardの中でpersistEstimateForm()を呼ぶこと =====

test('saveEstimateForm(): withButtonGuardの中でpersistEstimateForm()を呼ぶ', () => {
  assert.match(
    saveEstimateFormBody,
    /withButtonGuard\(btn, async \(\) => \{[\s\S]*?await persistEstimateForm\(\);/,
    'withButtonGuardのコールバック内でpersistEstimateForm()を呼んでいない'
  );
});

// ===== 8. saveEstimateForm(): err.codeによる分岐 =====

test("saveEstimateForm(): err.code === 'session_expired' はhandleSessionExpired()、'case_archived' はrenderCaseArchivedNotice()を呼ぶ", () => {
  assert.match(
    saveEstimateFormBody,
    /err\.code === 'session_expired'\)\s*\{[\s\S]*?handleSessionExpired\(\);/,
    "err.code === 'session_expired' の分岐でhandleSessionExpired()を呼んでいない"
  );
  assert.match(
    saveEstimateFormBody,
    /err\.code === 'case_archived'\)\s*\{[\s\S]*?renderCaseArchivedNotice\(errorEl\);/,
    "err.code === 'case_archived' の分岐でrenderCaseArchivedNotice(errorEl)を呼んでいない"
  );
});

// ===== 9. generateEstimateSheet(): persistEstimateForm()を呼び、saveEstimateForm(は呼ばないこと =====
//
// 【この固定の意図】generateEstimateSheet()は自前のwithButtonGuard(btn, ...)で全体を
// 包んでいる。その内側でsaveEstimateForm(btn)を呼ぶと、渡したbtnが既にdisabledなので
// withButtonGuard()の「if (btn && btn.disabled) return;」に引っかかり、保存処理が
// 静かにスキップされる。UIに触れない核処理(persistEstimateForm())だけを呼ぶ設計を
// 崩さないための固定。

test('generateEstimateSheet(): persistEstimateForm()を呼び、saveEstimateForm(は呼んでいない(withButtonGuardの二重ラップ回避)', () => {
  assert.ok(
    generateEstimateSheetBody.includes('await persistEstimateForm();'),
    'persistEstimateForm()の呼び出しが見つからない'
  );
  assert.ok(
    !generateEstimateSheetBody.includes('saveEstimateForm('),
    'saveEstimateForm(の呼び出しが見つかった' +
      '(自前のwithButtonGuardの中からsaveEstimateForm(btn)を呼ぶと、既にdisabledなbtnが' +
      '内側のwithButtonGuardのガードに引っかかり、保存が静かにスキップされる)'
  );
});

// ===== 11. 撤去済みのsaveEstimateCaseName()・estimate-case-name-msgが復活していないこと =====
//
// 【コメント中の言及は許容する】saveEstimateForm()の説明コメントに「D3時代の
// saveEstimateCaseName()と揃えている」という過去との比較の言及が残っており、これは
// 意図的なもの(履歴の説明)なので許容する。ここで固定したいのは「実コードとしての
// 復活」であり、コメント中の言及ではないため、onclick属性・function定義という
// 具体的な出現パターンだけを見る。

test('saveEstimateCaseName()のボタン・関数定義、estimate-case-name-msgが復活していない', () => {
  assert.ok(
    !INDEX_HTML.includes('onclick="saveEstimateCaseName('),
    'saveEstimateCaseName(this)を呼ぶボタンが復活している(案件名カードの保存ボタンは撤去済みのはず)'
  );
  assert.ok(
    !INDEX_HTML.includes('function saveEstimateCaseName('),
    'saveEstimateCaseName()の関数定義が復活している'
  );
  assert.ok(
    !INDEX_HTML.includes('estimate-case-name-msg'),
    'estimate-case-name-msg(撤去済みのメッセージ要素)への参照が復活している'
  );
});

// ===== 12. persistEstimateForm(): readExtraItemsFromDOM()を呼ぶこと =====

test('persistEstimateForm(): readExtraItemsFromDOM()を呼び、extraItemsとしてestimateMetaに含める', () => {
  assert.ok(
    persistEstimateFormBody.includes('readExtraItemsFromDOM()'),
    'readExtraItemsFromDOM()の呼び出しが見つからない(独自に読み直すと空行の除外条件が二重管理になる)'
  );
});

// ===== 13. generateEstimateSheet(): 同じreadExtraItemsFromDOM()を呼ぶこと =====
//
// 【この固定の意図】persistEstimateForm()とgenerateEstimateSheet()が別々に空行の
// 除外ロジックを持つと、estimateMetaの他フィールド(laborPrice/visitPriceの`>= 0`
// 検証)で既に起きている二重管理の構図をextraItemsでも再発させることになる。
// readExtraItemsFromDOM()という同じ関数を両方が呼んでいることを固定する。

test('generateEstimateSheet(): readExtraItemsFromDOM()を呼び、persistEstimateForm()と同じ読み取りロジックを使う', () => {
  assert.ok(
    generateEstimateSheetBody.includes('readExtraItemsFromDOM()'),
    'readExtraItemsFromDOM()の呼び出しが見つからない(persistEstimateForm()と別のロジックで読み直している疑い)'
  );
});
