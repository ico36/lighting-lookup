// tests/frontend/case-archived-guard.test.mjs
// 工程P3-3: CASE_ARCHIVED(書き込み禁止)・feature_restricted(プラン制限)の
// フロント側ハンドリングと、アーカイブ検索バナーの整理を固定する。
//
// P2で確立した方式(public/index.htmlを文字列として読み、対象関数の本体を波括弧の
// カウントで切り出して構造・分岐・文言を検査する)を踏襲する。extractFunctionBody()
// の実装・落とし穴はtests/frontend/case-detail-cart-breakdown.test.mjsの自己検証
// テストで既にカバーしているため、ここでは重複させない。

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

const isCaseArchivedErrorBody = extractFunctionBody(INDEX_HTML, /function isCaseArchivedError\(data\) \{/);
const renderCaseArchivedNoticeBody = extractFunctionBody(INDEX_HTML, /function renderCaseArchivedNotice\(errorEl\) \{/);
const isFeatureRestrictedErrorBody = extractFunctionBody(INDEX_HTML, /function isFeatureRestrictedError\(data\) \{/);

test('isCaseArchivedError(): error === CASE_ARCHIVED を判定する', () => {
  assert.ok(isCaseArchivedErrorBody.includes("data.error === 'CASE_ARCHIVED'"));
});

test('renderCaseArchivedNotice(): 文言に「複製」を含まない(ライトは複製できないため)', () => {
  assert.ok(!renderCaseArchivedNoticeBody.includes('複製'), '文言に「複製」が含まれている(ライトには実行できない操作)');
  assert.ok(renderCaseArchivedNoticeBody.includes('新しい案件を作成'), '「新しい案件を作成」の案内が見つからない');
  assert.ok(renderCaseArchivedNoticeBody.includes("onclick=\"openCasesModal()\""), '案件一覧を開くボタンが見つからない');
});

test('isFeatureRestrictedError(): error === feature_restricted を判定する', () => {
  assert.ok(isFeatureRestrictedErrorBody.includes("data.error === 'feature_restricted'"));
});

// 【CASE_ARCHIVEDを適用した7箇所】isCaseArchivedError()を経由してrenderCaseArchivedNotice()を
// 呼んでいることを確認する。適用しなかった3箇所(handleImportFileの2経路・
// generateEstimateSheet()のcatchブロック)は対象がアーカイブ済みになりえない/
// 意図的な静かな失敗のため対象外。
const patchGuardedFunctions = [
  { name: 'saveCaseName', pattern: /async function saveCaseName\(btn, caseId\) \{/ },
  { name: 'changeCaseStatus', pattern: /async function changeCaseStatus\(btn, newStatus\) \{/ },
  { name: 'addHistoryToCart', pattern: /async function addHistoryToCart\(btn, index\) \{/ },
  { name: 'addCandidateToCart', pattern: /async function addCandidateToCart\(btn, index, errorElId\) \{/ },
  { name: 'updateCartItemUI', pattern: /async function updateCartItemUI\(itemId, field, value\) \{/ },
  { name: 'removeCartItemUI', pattern: /async function removeCartItemUI\(itemId\) \{/ },
  { name: 'executeCartItemReplace', pattern: /async function executeCartItemReplace\(btn, index, errorElId\) \{/ },
];

for (const { name, pattern } of patchGuardedFunctions) {
  test(`${name}(): isCaseArchivedError()を経由してrenderCaseArchivedNotice()を呼ぶ`, () => {
    const body = extractFunctionBody(INDEX_HTML, pattern);
    assert.ok(body.includes('isCaseArchivedError(data)'), `${name}()にisCaseArchivedError(data)の呼び出しが無い`);
    assert.ok(body.includes('renderCaseArchivedNotice('), `${name}()にrenderCaseArchivedNotice()の呼び出しが無い`);
  });
}

test('openCaseDetail(): feature_restrictedのとき制限ビューを描画し、case-detail-titleを明示的に上書きする', () => {
  const body = extractFunctionBody(INDEX_HTML, /async function openCaseDetail\(caseId\) \{/);
  assert.ok(body.includes('isFeatureRestrictedError(data)'), 'isFeatureRestrictedError()の呼び出しが無い');
  assert.ok(body.includes('renderUpgradeCta('), 'renderUpgradeCta()の呼び出しが無い');
  // renderCaseDetail()を通らない経路のため、case-detail-titleが前回開いた案件名の
  // ままにならないよう、ここで明示的に上書きしていることを固定する(退行防止)。
  assert.ok(
    /isFeatureRestrictedError\(data\)\)\s*\{[\s\S]*?case-detail-title[\s\S]*?renderUpgradeCta\(/.test(body),
    'feature_restricted分岐の中でcase-detail-titleを上書きしていない(前回開いた案件名が残る可能性)'
  );
});

test('duplicateCurrentCase(): feature_restrictedのときrenderUpgradeCta()を呼ぶ', () => {
  const body = extractFunctionBody(INDEX_HTML, /async function duplicateCurrentCase\(btn, caseId\) \{/);
  assert.ok(body.includes('isFeatureRestrictedError(data)'), 'isFeatureRestrictedError()の呼び出しが無い');
  assert.ok(body.includes('renderUpgradeCta('), 'renderUpgradeCta()の呼び出しが無い');
});

// 【工程E2で対象をsaveEstimateMeta()からgenerateEstimateSheet()へ変更】
// 見積書生成に伴う保存(旧saveEstimateMeta()、現persistEstimateForm())は
// 「案件名・お客様名・工事場所・施工費・出張費・備考をまとめて保存する」形に
// 統合された。persistEstimateForm()自体はエラー時にerr.codeを付けてthrowする
// だけで、CASE_ARCHIVEDのときだけalert()するという判断はしない(saveEstimateForm()
// と挙動を分けるため、UI側の判断は呼び出し元に委ねる設計。詳細はpersistEstimateForm()
// のコメント参照)。この「CASE_ARCHIVEDのときだけalert、他は静かに無視」という
// 振る舞いは、実際にはgenerateEstimateSheet()末尾のtry/catchが担っているため、
// 固定対象もそちらに変更する。
test('generateEstimateSheet(): persistEstimateForm()失敗時、CASE_ARCHIVEDのときだけ例外的にalert()で知らせる(他の失敗は静かに無視する既存方針を維持)', () => {
  const generateEstimateSheetBody = extractFunctionBody(INDEX_HTML, /async function generateEstimateSheet\(btn\) \{/);
  const catchBody = extractFunctionBody(generateEstimateSheetBody, /catch \(err\) \{/);
  assert.ok(catchBody.includes("err.code === 'case_archived'"), "err.code === 'case_archived' の判定が見つからない");
  assert.match(
    catchBody,
    /err\.code === 'case_archived'\)\s*\{[\s\S]*?alert\(/,
    'case_archivedのときにalert()を呼んでいない(保存失敗が利用者に伝わらない)'
  );
});

test('searchArchivedCasesUI(): data.campaignを参照しない(工程P3-2でGET /api/cases/archiveがcampaignを返さなくなったため)', () => {
  const body = extractFunctionBody(INDEX_HTML, /async function searchArchivedCasesUI\(btn\) \{/);
  assert.ok(!body.includes('data.campaign'), 'data.campaignの参照が残っている(常にundefinedになる死んだ分岐)');
  assert.ok(!body.includes('bannerEl'), 'bannerEl(未使用になった変数)の参照が残っている');
});

test('archive-search-campaign-banner要素は将来の告知用にDOMとして残っている', () => {
  assert.ok(
    INDEX_HTML.includes('id="archive-search-campaign-banner"'),
    'バナー要素のDOM自体が削除されている(lib/featureCampaigns.jsのキャンペーン機構を将来転用する想定と矛盾)'
  );
});
