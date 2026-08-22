// tests/frontend/case-manual-archive.test.mjs
// 工程P4-2: 案件詳細画面の手動アーカイブボタン(archiveCaseHandler())を固定する。
//
// P2で確立した方式(public/index.htmlを文字列として読み、対象関数の本体を波括弧の
// カウントで切り出して構造・分岐・文言を検査する)を踏襲する。extractFunctionBody()
// の実装・落とし穴はtests/frontend/case-detail-cart-breakdown.test.mjsの自己検証
// テストで既にカバーしているため、ここでは重複させない。
//
// 【extractFunctionBody()の安全性について】archiveCaseHandler()が含むテンプレート
// リテラルは `/api/cases/${caseId}` の1箇所のみで、比較演算子`>`や対になっていない
// `{`/`}`を含まない。P2で踏んだ地雷(`${cartItems.length > ... }`の`>`をタグの終端`>`と
// 誤認するバグ)はrenderCaseDetail()がHTMLタグの境界を`indexOf('>')`で素朴に探す
// 別のヘルパー(indexOfTagClose())の問題であり、波括弧の深さカウントだけで完結する
// extractFunctionBody()自体には影響しない。そのためここではindexOfTagClose()の
// ような追加のワークアラウンドを使わず、素のextractFunctionBody()をそのまま使う。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INDEX_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'index.html'), 'utf8');

function extractFunctionBody(source, functionSignaturePattern) {
  const match = source.match(functionSignaturePattern);
  assert.ok(match, `関数の開始位置が見つかりません: ${functionSignaturePattern}`);
  const startOfBrace = match.index + match[0].length - 1;
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

const renderCaseDetailBody = extractFunctionBody(INDEX_HTML, /function renderCaseDetail\(c, searches\) \{/);
const archiveCaseHandlerBody = extractFunctionBody(INDEX_HTML, /async function archiveCaseHandler\(btn, caseId\) \{/);
const isCaseNotArchivableErrorBody = extractFunctionBody(INDEX_HTML, /function isCaseNotArchivableError\(data\) \{/);

test('renderCaseDetail(): アーカイブボタンの表示条件が !isArchived && TERMINAL_STATUSES.includes(c.status)', () => {
  assert.ok(
    renderCaseDetailBody.includes("(!isArchived && TERMINAL_STATUSES.includes(c.status))"),
    '表示条件の式が見つからない(文面が変わった可能性)'
  );
  assert.ok(
    renderCaseDetailBody.includes("onclick=\"archiveCaseHandler(this, '${c.id}')\""),
    'アーカイブボタンのonclickが見つからない'
  );
});

test('isCaseNotArchivableError(): error === CASE_NOT_ARCHIVABLE を判定する', () => {
  assert.ok(isCaseNotArchivableErrorBody.includes("data.error === 'CASE_NOT_ARCHIVABLE'"));
});

// 【このテストは文言を意図的に固定している】ここでconfirm()の3行を全文一致で検査
// しているのは、文言の変更が意図せず起きていないかを検知するため。実際に文言を
// 変える意思決定をした場合は、このテストも併せて更新すること。特に3行目
// (「閲覧・複製はご利用のプランによって異なります」)は、CASE_ARCHIVEDの案内文には
// 無い「アーカイブと削除の使い分け」を伝える唯一の箇所なので、削っていいかどうかは
// 単純な言い回し調整とは別に判断すること。このテストが落ちたら、まず「文言を変える
// 意思決定をしたかどうか」を確認してから、実装のミスかテストの更新漏れかを判断する。
test('archiveCaseHandler(): confirmの3行の文言が全文一致で存在する(意図的な固定。上記コメント参照)', () => {
  assert.ok(
    archiveCaseHandlerBody.includes("'この案件をアーカイブしますか？\\n' +"),
    '1行目(確認の主文)が見つからない'
  );
  assert.ok(
    archiveCaseHandlerBody.includes("'アーカイブした案件は案件一覧から外れ、案件一覧へ戻すことはできません。\\n' +"),
    '2行目(不可逆であることの説明)が見つからない'
  );
  assert.ok(
    archiveCaseHandlerBody.includes(
      "'アーカイブ済みの案件はアーカイブ検索から探せます。閲覧・複製はご利用のプランによって異なります。'"
    ),
    '3行目(アーカイブ検索・プラン差の案内)が見つからない'
  );
});

test('archiveCaseHandler(): CASE_NOT_ARCHIVABLEはisCaseNotArchivableError()経由でdata.messageを表示する', () => {
  assert.ok(
    archiveCaseHandlerBody.includes('isCaseNotArchivableError(data)'),
    'isCaseNotArchivableError(data)の呼び出しが無い'
  );
  assert.match(
    archiveCaseHandlerBody,
    /isCaseNotArchivableError\(data\)\)\s*\{[\s\S]*?showError\(errorEl, data\.message\)/,
    'CASE_NOT_ARCHIVABLEの分岐内でshowError(errorEl, data.message)を呼んでいない' +
      '(data.errorを生で出す汎用フォールバックに落ちると、利用者にエラーコードの文字列が見える)'
  );
});

test('archiveCaseHandler(): カート対象クリアの5行がif (currentCartCaseId === caseId)の中にある', () => {
  assert.match(
    archiveCaseHandlerBody,
    /if \(currentCartCaseId === caseId\) \{[\s\S]*?currentCartCaseId = null;[\s\S]*?localStorage\.removeItem\('cart_case_id'\);[\s\S]*?cartCase = null;[\s\S]*?renderCartItems\(\);[\s\S]*?updateCartBadge\(\);[\s\S]*?\}/,
    'カート対象クリアの5行が想定の順序・ガードの中に見つからない'
  );
});
