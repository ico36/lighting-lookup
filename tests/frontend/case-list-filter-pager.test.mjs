// tests/frontend/case-list-filter-pager.test.mjs
//
// P5-2(案件名の絞り込み・ページャ)・P5-3(カート対象マーク)の回帰テスト。
// P2(case-detail-cart-breakdown.test.mjs)で確立した方式(public/index.htmlを文字列として
// 読み、対象関数の本体を波括弧のカウントで切り出して構造・分岐・文言を検査する)を踏襲する。
// extractFunctionBody()の実装・落とし穴・自己検証テストは同ファイルでカバー済みのため、
// ここでは重複させない。
//
// 【if文の切り出しにもextractFunctionBody()を使う理由】estimate-form-writeback-guard.test.mjs
// と同じ判断。extractFunctionBody()は「`{`で終わる正規表現にマッチした位置から対応する
// `}`までを波括弧の深さカウントで切り出す」だけの汎用ヘルパーで、対象がfunction宣言である
// 必要はない。casesCache.length===0 / filtered.length===0 の2つのif文もこれで切り出す。
//
// 【今回は indexOfTagClose() 相当のワークアラウンドが不要な理由】対象関数(renderCasesList()・
// onCaseListFilterInput()・renderCasesPager()・changeCasesPage()・searchArchivedCasesUI())は
// いずれもHTMLタグの開始/終了境界をindexOf('>')で素朴に探す処理を持たない。renderCasesList()
// 内に`if (casesCurrentPage > totalPages)`という比較演算子の`>`が登場するが、これは単文
// (波括弧を持たない)なので、波括弧の深さカウントだけで完結するextractFunctionBody()には
// 影響しない(事前にnode一発で全対象の抽出が波括弧の対応込みで成功することを確認済み)。

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

const renderCasesListBody = extractFunctionBody(INDEX_HTML, /function renderCasesList\(\) \{/);
const onCaseListFilterInputBody = extractFunctionBody(INDEX_HTML, /function onCaseListFilterInput\(\) \{/);
const renderCasesPagerBody = extractFunctionBody(INDEX_HTML, /function renderCasesPager\(totalPages\) \{/);
const changeCasesPageBody = extractFunctionBody(INDEX_HTML, /function changeCasesPage\(delta\) \{/);
// 引数名(btn)までは固定しない(estimate-form-writeback-guard.test.mjsと同じ判断)。
// extractFunctionBody()はマッチした文字列の末尾が`{`であることを前提にしているため、
// `(`の後ろで正規表現を打ち切らず、`[^)]*\) \{`で引数の中身を読み飛ばしたうえで
// 確実に開き波括弧まで消費する。
const searchArchivedCasesUIBody = extractFunctionBody(INDEX_HTML, /async function searchArchivedCasesUI\([^)]*\) \{/);

// ===== 絞り込み =====

test('renderCasesList(): 絞り込み文字列はtrim()とtoLowerCase()を通してから比較している', () => {
  assert.ok(
    renderCasesListBody.includes('caseFilterQuery.trim().toLowerCase()'),
    'caseFilterQuery.trim().toLowerCase() が見つからない(正規化の処理が変わった可能性)'
  );
  assert.ok(
    renderCasesListBody.includes(".toLowerCase().includes(query)"),
    '案件名側もtoLowerCase()してからincludes(query)で比較する処理が見つからない'
  );
});

test('renderCasesList(): casesCacheは書き換えず、絞り込み結果はローカル変数(filtered)で扱っている', () => {
  assert.ok(
    renderCasesListBody.includes('const filtered = query'),
    'filteredがconstのローカル変数として宣言されていない'
  );
  // casesCacheへの再代入(casesCache = ...)が無いことを確認する。casesCache.length・
  // casesCache.filter(...)・(: casesCache;のような)読み取りだけなら「casesCache」の直後は
  // '.'・';'・')'等になり、この正規表現(casesCacheの直後に=、ただし==は除く)にはマッチしない。
  assert.ok(
    !/casesCache\s*=[^=]/.test(renderCasesListBody),
    'renderCasesList()内でcasesCacheへの再代入が見つかった(絞り込み結果でcasesCache自体が上書きされている疑い)'
  );
});

// ===== 空表示の2分岐 =====

// 【このテストは文言を意図的に固定している】P4のconfirm文言テストと同様、文言の変更が
// 意図せず起きていないかを検知するため全文一致で見る。文言を変える意思決定をした場合は、
// このテストも併せて更新すること。
test('renderCasesList(): 案件0件と絞り込み結果0件で文言の異なる別々の早期returnになっている(共通化されていない)', () => {
  const emptyCacheIf = extractFunctionBody(renderCasesListBody, /if \(casesCache\.length === 0\) \{/);
  const emptyFilteredIf = extractFunctionBody(renderCasesListBody, /if \(filtered\.length === 0\) \{/);

  assert.ok(
    emptyCacheIf.includes('案件はまだありません'),
    'casesCache.length===0の分岐に「案件はまだありません」の文言が見つからない'
  );
  assert.ok(
    emptyCacheIf.includes('return;'),
    'casesCache.length===0の分岐がreturn;で終わっていない(早期returnになっていない)'
  );

  assert.ok(
    emptyFilteredIf.includes('一致する案件がありません'),
    'filtered.length===0の分岐に「一致する案件がありません」の文言が見つからない'
  );
  assert.ok(
    emptyFilteredIf.includes('return;'),
    'filtered.length===0の分岐がreturn;で終わっていない(早期returnになっていない)'
  );

  // 2つの分岐が同一の処理に共通化されていない(コピー&ペーストで済ませており、片方だけ
  // 文言を直し忘れる事故を防ぐ設計にはなっていない)ことを、内容の非一致で確認する。
  assert.notEqual(
    emptyCacheIf,
    emptyFilteredIf,
    '2つの空表示の分岐が同じ内容になっている(文言が分化していない、または共通関数化で判別できなくなっている)'
  );
});

// ===== ページャ =====

test('CASES_PER_PAGE は 8 である', () => {
  const constMatch = INDEX_HTML.match(/const CASES_PER_PAGE = (\d+);/);
  assert.ok(constMatch, 'CASES_PER_PAGE の定数定義が見つからない');
  assert.equal(Number(constMatch[1]), 8, 'CASES_PER_PAGE が8ではない');
});

test('renderCasesPager(): totalPages <= 1 のときページャをdisplay:noneにする', () => {
  assert.match(
    renderCasesPagerBody,
    /if \(totalPages <= 1\) \{[\s\S]*?pagerEl\.style\.display = 'none';[\s\S]*?\}/,
    'totalPages<=1の分岐でdisplay=noneにする処理が見つからない'
  );
});

test('renderCasesPager(): 前後ボタンが端でdisabledになる', () => {
  assert.ok(
    renderCasesPagerBody.includes("${casesCurrentPage <= 1 ? 'disabled' : ''}"),
    '前ページボタンの先頭でdisabled判定(casesCurrentPage <= 1)が見つからない'
  );
  assert.ok(
    renderCasesPagerBody.includes("${casesCurrentPage >= totalPages ? 'disabled' : ''}"),
    '次ページボタンの末尾でdisabled判定(casesCurrentPage >= totalPages)が見つからない'
  );
});

test('onCaseListFilterInput(): casesCurrentPageを1に戻してからrenderCasesList()を呼ぶ(順序込み)', () => {
  assert.match(
    onCaseListFilterInputBody,
    /casesCurrentPage = 1;[\s\S]*?renderCasesList\(\);/,
    'casesCurrentPage = 1; がrenderCasesList()の呼び出しより前に無い' +
      '(順序が逆だと、絞り込み結果に対して1ページ目に戻す前に描画してしまう)'
  );
});

test('changeCasesPage(): ページ番号を加算してrenderCasesList()を呼ぶ', () => {
  assert.ok(changeCasesPageBody.includes('casesCurrentPage += delta;'), 'casesCurrentPage += delta; が見つからない');
  assert.ok(changeCasesPageBody.includes('renderCasesList();'), 'renderCasesList()の呼び出しが見つからない');
});

// ===== カート対象の行 =====

test('renderCasesList(): currentCartCaseIdと一致する行にのみ🛒が付く', () => {
  assert.ok(
    renderCasesListBody.includes('const isCartTarget = c.id === currentCartCaseId;'),
    'isCartTargetの判定(c.id === currentCartCaseId)が見つからない'
  );
  assert.ok(
    renderCasesListBody.includes("${isCartTarget ? '🛒 ' : ''}"),
    'isCartTargetによる🛒の出し分けが見つからない'
  );
});

test('renderCasesList(): カート対象の行は2px solid var(--accent)、それ以外は1px solid var(--border)', () => {
  assert.ok(
    renderCasesListBody.includes("border:${isCartTarget ? '2px solid var(--accent)' : '1px solid var(--border)'}"),
    '枠線の出し分け(2px solid var(--accent) / 1px solid var(--border))が見つからない'
  );
});

test('renderCasesList(): 枠線太さの差を吸収するpaddingの出し分け(11px 14px / 12px 14px)がある', () => {
  assert.ok(
    renderCasesListBody.includes("padding:${isCartTarget ? '11px 14px' : '12px 14px'}"),
    'paddingの出し分け(11px 14px / 12px 14px)が見つからない' +
      '(枠線太さの差(1px→2px)を相殺する意図で足したもの。単純な11px/12pxへの書き換えに' +
      '見えて実は意味があるため、値を変える場合はコメント側の説明も一緒に見直すこと)'
  );
});

test('searchArchivedCasesUI(): アーカイブ検索結果の行には🛒が無い', () => {
  assert.ok(
    !searchArchivedCasesUIBody.includes('🛒'),
    'アーカイブ検索結果側に🛒が含まれている' +
      '(アーカイブ済み案件はカート対象になる経路が無いため、この印は出すべきではない)'
  );
});
