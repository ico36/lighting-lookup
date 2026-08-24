// tests/api/cases-id.test.mjs
// GET /api/cases/{id} (api/cases/[id].js) の工程P3-2でのプラン制限を検証する。
// - アーカイブ済み + 許可プラン外 → 403 (featureRestrictedBody()の形)
// - 通常案件はプランに関わらず巻き込まれない
// - アーカイブ済み + 許可プランなら200
//
// 【P3-2とは別件】PATCH/DELETEの書き込みガードも検証する。プラン制限ではなく、
// 「アーカイブ済みは全プラン共通で書き込み不可」という担保漏れの修正。
// DELETEは意図的に塞いでいない(アーカイブは永久保持・復元不可の方針のため、
// 顧客名入りデータを消す唯一の手段として残す)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cases/[id].js';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { __setAuth, __reset as __resetAuth } from '../support/fakes/auth.mjs';
import { __resetFakeRedis, redis, redisKey } from '../support/fakes/redis.mjs';
import { createCase, updateCaseStatus, archiveCase, STATUS } from '../../lib/cases.js';

const EMAIL = 'id-tester@example.com';

function setPlan(plan) {
  __setAuth({ email: EMAIL, limits: { plan, searchLimit: 20, caseLimit: 5, retentionDays: 30 } });
}

beforeEach(() => {
  __resetFakeRedis();
  __resetAuth();
  setPlan('light');
});

async function createArchivedCase(customerName) {
  const created = await createCase(EMAIL, { customerName }, { caseLimit: 5 });
  await updateCaseStatus(created.id, STATUS.COMPLETED, 'user', { retentionDays: 0 });
  return archiveCase(created.id);
}

async function createNormalCase(customerName) {
  return createCase(EMAIL, { customerName }, { caseLimit: 5 });
}

test('ライトでアーカイブ済み案件をGET → 403、ボディはfeatureRestrictedBody()の形', async () => {
  const archived = await createArchivedCase('制限対象様');
  setPlan('light');

  const req = fakeReq(undefined, { method: 'GET', query: { id: archived.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'feature_restricted');
  assert.equal(res.body.feature, 'archiveAccess');
  assert.equal('limits' in res.body, false);
});

test('ライトで通常案件をGET → 200(巻き込み事故が無いこと)', async () => {
  const normal = await createNormalCase('通常案件様');
  setPlan('light');

  const req = fakeReq(undefined, { method: 'GET', query: { id: normal.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.id, normal.id);
});

test('スタンダードでアーカイブ済み案件をGET → 200', async () => {
  const archived = await createArchivedCase('スタンダード様');
  setPlan('standard');

  const req = fakeReq(undefined, { method: 'GET', query: { id: archived.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.id, archived.id);
});

test('プロでアーカイブ済み案件をGET → 200', async () => {
  const archived = await createArchivedCase('プロ様');
  setPlan('pro');

  const req = fakeReq(undefined, { method: 'GET', query: { id: archived.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.id, archived.id);
});

// ----- 書き込みガード(【P3-2とは別件】。全プラン共通、archiveAccessとは無関係) -----

test('アーカイブ済み案件にPATCH → 403 CASE_ARCHIVED', async () => {
  const archived = await createArchivedCase('編集禁止様');
  setPlan('light');

  const req = fakeReq({ customerName: '書き換え後' }, { method: 'PATCH', query: { id: archived.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'CASE_ARCHIVED');
});

test('通常案件にPATCH → 成功(巻き込み事故が無いこと)', async () => {
  const normal = await createNormalCase('編集可能様');
  setPlan('light');

  const req = fakeReq({ customerName: '書き換え後' }, { method: 'PATCH', query: { id: normal.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.customerName, '書き換え後');
});

// 【意図的に通している】アーカイブは全プランで永久保持・復元不可の方針のため、
// DELETEを塞ぐと顧客名入りのデータを利用者が二度と消せなくなる。PATCHと同じ
// 理由で「一貫性のためにDELETEも塞ごう」と素朴に書き換えられがちな箇所なので、
// 塞がないことをここで固定する(退行防止)。フロント側の削除ボタン
// (public/index.html「🗑 この案件を完全に削除」)もisArchived分岐の外にあり、
// アーカイブ済み案件に対して常に表示される設計と一致させている。
test('アーカイブ済み案件にDELETE → 成功(意図的に塞いでいないことの固定)', async () => {
  const archived = await createArchivedCase('削除可能様');
  setPlan('light');

  const req = fakeReq(undefined, { method: 'DELETE', query: { id: archived.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

test('アーカイブ済み案件へのPATCH禁止はプランに関わらず効く(スタンダード・プロでも403)', async () => {
  const archivedForStandard = await createArchivedCase('スタンダード編集禁止様');
  setPlan('standard');
  const standardReq = fakeReq({ customerName: 'x' }, { method: 'PATCH', query: { id: archivedForStandard.id } });
  const standardRes = fakeRes();
  await handler(standardReq, standardRes);
  assert.equal(standardRes.statusCode, 403);
  assert.equal(standardRes.body.error, 'CASE_ARCHIVED');

  const archivedForPro = await createArchivedCase('プロ編集禁止様');
  setPlan('pro');
  const proReq = fakeReq({ customerName: 'x' }, { method: 'PATCH', query: { id: archivedForPro.id } });
  const proRes = fakeRes();
  await handler(proReq, proRes);
  assert.equal(proRes.statusCode, 403);
  assert.equal(proRes.body.error, 'CASE_ARCHIVED');
});

// ----- 手動アーカイブ(工程P4-1。{ archive: true }) -----

async function createCompletedCase(customerName) {
  const created = await createCase(EMAIL, { customerName }, { caseLimit: 5 });
  return updateCaseStatus(created.id, STATUS.COMPLETED, 'user', { retentionDays: 30 });
}

async function createLostCase(customerName) {
  const created = await createCase(EMAIL, { customerName }, { caseLimit: 5 });
  return updateCaseStatus(created.id, STATUS.LOST, 'user', { retentionDays: 30 });
}

test('PATCH { archive: true }: 完了の案件 → 200、archivedAtがセットされ:archivedへ移動する', async () => {
  const completed = await createCompletedCase('完了アーカイブ様');
  setPlan('light');

  const req = fakeReq({ archive: true }, { method: 'PATCH', query: { id: completed.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Number.isFinite(res.body.case.archivedAt), 'archivedAtが数値でセットされていない');

  // lib/cases.jsのarchiveCase()がcases:{email}:archived ZSETへ実際にzaddしているかを
  // フェイクRedis経由で直接確認する(レスポンスのarchivedAtフィールドだけでは、
  // 案件本体は書き換わったがZSETへの移動が漏れているケースを見逃すため)。
  const archivedZsetSize = await redis.zcard(redisKey('cases', EMAIL, 'archived'));
  assert.equal(archivedZsetSize, 1, 'cases:{email}:archived ZSETへ移動していない');
});

test('PATCH { archive: true }: 失注・キャンセルの案件 → 200、archivedAtがセットされ:archivedへ移動する', async () => {
  const lost = await createLostCase('失注アーカイブ様');
  setPlan('light');

  const req = fakeReq({ archive: true }, { method: 'PATCH', query: { id: lost.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Number.isFinite(res.body.case.archivedAt), 'archivedAtが数値でセットされていない');

  const archivedZsetSize = await redis.zcard(redisKey('cases', EMAIL, 'archived'));
  assert.equal(archivedZsetSize, 1, 'cases:{email}:archived ZSETへ移動していない');
});

test('PATCH { archive: true }: 完了・失注以外(承認待ち) → 403 CASE_NOT_ARCHIVABLE', async () => {
  const normal = await createNormalCase('承認待ち様'); // createCase()のデフォルトは承認待ち
  setPlan('light');

  const req = fakeReq({ archive: true }, { method: 'PATCH', query: { id: normal.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'CASE_NOT_ARCHIVABLE');
  assert.equal(typeof res.body.message, 'string');
  assert.ok(res.body.message.length > 0, 'messageが空(フロントでエラーコードの生文字列が見える経路になる)');
});

// 【新しいチェックを足していないことの固定】archive分岐自体には二重アーカイブの
// チェックを追加していない(判定を2箇所に分散させないため)。この403は、PATCH共通の
// 既存ガード(record.archivedAtの有無を見るCASE_ARCHIVED、archive分岐より前で
// 効く)がそのまま拾った結果であることを、body: { archive: true }で固定する。
test('PATCH { archive: true }: 既にアーカイブ済み → 403 CASE_ARCHIVED(新しいチェックを追加していないことの固定)', async () => {
  const archived = await createArchivedCase('二重アーカイブ様');
  setPlan('light');

  const req = fakeReq({ archive: true }, { method: 'PATCH', query: { id: archived.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'CASE_ARCHIVED');
});

// 【分岐順序の固定】archive分岐はaction分岐群の最後(customerNameの後・400
// フォールバックの前)に置いている。status等と同時に送られた場合、先行するif群が
// 先勝ちして即returnするため、archive分岐には到達しない。ここではstatusと同時に
// archive: trueを送り、statusの変更だけが実行されて(承認済みへ変わる)アーカイブは
// 実行されない(archivedAtがnullのまま)ことを確認する。
test('PATCH { status, archive } 同時送信 → statusが勝ち、アーカイブは実行されない(archive分岐を最後に置いた設計の固定)', async () => {
  const completed = await createCompletedCase('同時送信様');
  setPlan('light');

  const req = fakeReq(
    { status: STATUS.APPROVED, archive: true },
    { method: 'PATCH', query: { id: completed.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.status, STATUS.APPROVED);
  assert.equal(res.body.case.archivedAt, null, 'archive分岐が実行されてしまっている(statusより先に評価された)');
});

// ----- estimateFormSave(工程E1。見積書フォーム画面の「保存」ボタン用) -----
// customerNameとestimateMetaを1回のPATCHでまとめて更新する複合アクション。
// updateCaseName()・updateEstimateMeta()を別々のリクエストで直列に送ると安全だが、
// 並列だと後勝ちで片方の更新が消えるレースコンディションが起きるため、まとめて
// 1回のread-modify-writeで確定させる設計にした(lib/cases.jsのコメント参照)。

test('PATCH { estimateFormSave: { customerName, estimateMeta } }: 両方同時に更新される', async () => {
  const created = await createNormalCase('更新前様');
  setPlan('light');

  const req = fakeReq(
    {
      estimateFormSave: {
        customerName: '更新後様',
        estimateMeta: {
          clientName: 'お客様太郎',
          clientSite: '2階リビング',
          laborPrice: 5000,
          visitPrice: 1000,
          bizNote: '備考テキスト',
        },
      },
    },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.customerName, '更新後様');
  assert.deepEqual(res.body.case.estimateMeta, {
    clientName: 'お客様太郎',
    clientSite: '2階リビング',
    laborPrice: 5000,
    visitPrice: 1000,
    bizNote: '備考テキスト',
    extraItems: [],
  });
});

test('PATCH { estimateFormSave: { customerName } }: customerNameのみ指定時はestimateMetaを変更しない', async () => {
  const created = await createNormalCase('元の名前様');
  setPlan('light');

  const req = fakeReq(
    { estimateFormSave: { customerName: '名前だけ変更様' } },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.customerName, '名前だけ変更様');
  assert.deepEqual(
    res.body.case.estimateMeta,
    { clientName: '', clientSite: '', laborPrice: 0, visitPrice: 0, bizNote: '', extraItems: [] },
    'estimateMetaを指定していないのに変化している'
  );
});

test('PATCH { estimateFormSave: { estimateMeta } }: estimateMetaのみ指定時はcustomerNameを変更しない', async () => {
  const created = await createNormalCase('名前は変えない様');
  setPlan('light');

  const req = fakeReq(
    { estimateFormSave: { estimateMeta: { clientName: 'お客様花子' } } },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.customerName, '名前は変えない様', 'customerNameを指定していないのに変化している');
  assert.equal(res.body.case.estimateMeta.clientName, 'お客様花子');
});

test('PATCH { estimateFormSave: {} }: customerName・estimateMetaどちらも無い場合は400 INVALID_REQUEST', async () => {
  const created = await createNormalCase('空リクエスト様');
  setPlan('light');

  const req = fakeReq({ estimateFormSave: {} }, { method: 'PATCH', query: { id: created.id } });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'INVALID_REQUEST');
});

test('アーカイブ済み案件にPATCH { estimateFormSave: {...} } → 403 CASE_ARCHIVED(既存ガードがこの分岐にも効く)', async () => {
  const archived = await createArchivedCase('保存禁止様');
  setPlan('light');

  const req = fakeReq(
    { estimateFormSave: { customerName: '書き換えを試みる' } },
    { method: 'PATCH', query: { id: archived.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'CASE_ARCHIVED');
});

// 【分岐順序の固定】estimateFormSave分岐はrestoreImportの直後・customerNameの直前に
// 置いている。customerNameと同時に送られた場合、先行するestimateFormSaveが先勝ちして
// 即returnするため、customerName単体の分岐には到達しない。
test('PATCH { estimateFormSave, customerName } 同時送信 → estimateFormSaveが勝つ(customerNameより前に置いた設計の固定)', async () => {
  const created = await createNormalCase('同時送信前様');
  setPlan('light');

  const req = fakeReq(
    {
      estimateFormSave: { customerName: 'estimateFormSave側の名前' },
      customerName: 'customerName側の名前',
    },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.body.case.customerName,
    'estimateFormSave側の名前',
    'customerName単体分岐に流れてしまっている(順序が逆)'
  );
});

// ----- extraItems(残課題: 見積書フォームの任意の費用項目。R3) -----
// lib/cases.js の normalizeExtraItems() の検証(label50文字切り詰め・amountのマイナス
// 許容・不正値の0フォールバック・配列でない入力/非オブジェクト要素の扱い)と、
// applyEstimateMeta()・restoreCaseFromImport()の両方がそこを通ることを固定する。
// normalizeExtraItems()自体はexportされていない(lib/cases.jsの既存の慣習として、
// lib層の検証ロジックはAPIハンドラ経由のみでテストしており、直接importする専用の
// unitテストファイルは無い)ため、このファイルの慣習(APIハンドラを叩く)に揃える。
//
// 【見送った候補とその理由】
// - 「配列でない入力」と「配列内の非オブジェクト要素」は当初別々の候補だったが、
//   1つのテストにまとめた(下記「配列でない入力は[]、配列内の非オブジェクト要素は
//   除外される」)。どちらも「不正な形の入力を安全側に倒す」という同じ関心事のため、
//   分ける実益が薄い。
// - applyEstimateMeta()・restoreCaseFromImport()双方の本体が`normalizeExtraItems(`を
//   呼んでいることをソース文字列で確認する構造テストは見送った。下記の「同じ入力が
//   同じ結果に正規化される」テスト(挙動の一致)のほうが目的として強く、両方は不要。
//   ソース文字列での固定は実装の書き方そのものを縛るため壊れやすいうえ、たとえ
//   誰かが将来normalizeExtraItems()を呼ばずに別の同等ロジックを書いたとしても、
//   結果が一致している限り実害は無い(挙動テストなら検出できないが、それでよい)。
// - 旧データ互換(estimateMetaはあるがextraItemsキーが無いレコード)のテストは見送った。
//   フェイクRedis(tests/support/fakes/redis.mjs)への直接注入という、このリポジトリに
//   前例のない手法の導入が必要になり、コストに見合わない。この互換性は
//   normalizeCase()の既存の仕組み(cartItems等でも使っている「配列であることだけ
//   保証する」パターン)にそのまま乗っているだけで、extraItems固有の新しいリスクは
//   低いと判断した。

test('PATCH { estimateFormSave: { estimateMeta: { extraItems } } }: labelは50文字に切り詰められる', async () => {
  const created = await createNormalCase('label切り詰めテスト様');
  setPlan('light');

  const longLabel = 'あ'.repeat(60);
  const req = fakeReq(
    { estimateFormSave: { estimateMeta: { extraItems: [{ label: longLabel, amount: 1000 }] } } },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.estimateMeta.extraItems.length, 1);
  assert.equal(
    res.body.case.estimateMeta.extraItems[0].label,
    longLabel.slice(0, 50),
    'labelが50文字に切り詰められていない'
  );
});

test('PATCH { estimateFormSave: { estimateMeta: { extraItems } } }: amountはマイナスを許容する(値引き)', async () => {
  const created = await createNormalCase('マイナス許容テスト様');
  setPlan('light');

  const req = fakeReq(
    { estimateFormSave: { estimateMeta: { extraItems: [{ label: '値引き', amount: -3000 }] } } },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.case.estimateMeta.extraItems,
    [{ label: '値引き', amount: -3000 }],
    'マイナスのamountが0以上に補正されてしまっている(laborPrice/visitPriceの>= 0ガードをコピーしていないか)'
  );
});

test('PATCH { estimateFormSave: { estimateMeta: { extraItems } } }: amountが不正値のときは0にフォールバックし、行(label)は残る', async () => {
  const created = await createNormalCase('不正値テスト様');
  setPlan('light');

  const req = fakeReq(
    { estimateFormSave: { estimateMeta: { extraItems: [{ label: '謎の項目', amount: 'abc' }] } } },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.case.estimateMeta.extraItems,
    [{ label: '謎の項目', amount: 0 }],
    '不正なamountで行ごと消えてしまっている(labelが入力済みの行は残すべき)'
  );
});

test('PATCH { estimateFormSave: { estimateMeta: { extraItems } } }: 配列でない入力は[]、配列内の非オブジェクト要素は除外される', async () => {
  const created = await createNormalCase('配列以外テスト様');
  setPlan('light');

  const reqNotArray = fakeReq(
    { estimateFormSave: { estimateMeta: { extraItems: 'not-an-array' } } },
    { method: 'PATCH', query: { id: created.id } }
  );
  const resNotArray = fakeRes();
  await handler(reqNotArray, resNotArray);
  assert.equal(resNotArray.statusCode, 200);
  assert.deepEqual(resNotArray.body.case.estimateMeta.extraItems, [], '配列でない入力が[]になっていない');

  const reqMixed = fakeReq(
    {
      estimateFormSave: {
        estimateMeta: { extraItems: [null, 'x', 123, { label: '正常項目', amount: 500 }] },
      },
    },
    { method: 'PATCH', query: { id: created.id } }
  );
  const resMixed = fakeRes();
  await handler(reqMixed, resMixed);
  assert.equal(resMixed.statusCode, 200);
  assert.deepEqual(
    resMixed.body.case.estimateMeta.extraItems,
    [{ label: '正常項目', amount: 500 }],
    '配列内の非オブジェクト要素(null・文字列・数値)が除外されていない、または正常な要素まで消えている'
  );
});

// テストデータ(label・amountとも最初から正規化済みの値)のため、このテスト単体では
// normalizeExtraItems()を通しているかは検出できない(その役目は下の「同じ結果に
// 正規化される」テスト(L-6)が担う)。ここでの役目はrestoreImport経由でextraItemsが
// 保存されるという基本動作の確認。
test('PATCH { restoreImport: { estimateMeta } }: extraItemsを含むestimateMetaがそのまま復元される', async () => {
  const created = await createNormalCase('復元テスト様');
  setPlan('light');

  const req = fakeReq(
    {
      restoreImport: {
        estimateMeta: {
          clientName: '復元太郎',
          extraItems: [
            { label: '値引き', amount: -2000 },
            { label: '駐車場代', amount: 500 },
          ],
        },
      },
    },
    { method: 'PATCH', query: { id: created.id } }
  );
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.case.estimateMeta.clientName, '復元太郎');
  assert.deepEqual(res.body.case.estimateMeta.extraItems, [
    { label: '値引き', amount: -2000 },
    { label: '駐車場代', amount: 500 },
  ]);
});

// 【この固定の意図】applyEstimateMeta()(estimateFormSave/estimateMetaアクション経由)と
// restoreCaseFromImport()(restoreImportアクション経由)は、estimateMeta導入時から
// 別々に「同じ検証ロジックを持つ」という二重管理の構図があった(L1のコミットコメント
// 参照)。extraItemsではnormalizeExtraItems()に検証を集約して両方から呼ぶ設計にしたが、
// この集約が実際に効いていること(=どちらの経路を通っても結果が一致すること)を
// 同じ壊れた入力を両経路に送って確認する。将来どちらか一方だけ直し忘れる/別ロジックを
// 書いてしまう事故があれば、この結果不一致で検出できる。
test('estimateMeta更新(applyEstimateMeta())とrestoreImport(restoreCaseFromImport())で、同じextraItems入力が同じ結果に正規化される', async () => {
  const rawExtraItems = [
    { label: 'あ'.repeat(60), amount: -1500 }, // 50文字切り詰め + マイナス許容
    null, // 非オブジェクト要素は除外
    { label: '正常項目', amount: 'abc' }, // 不正amountは0にフォールバック
  ];
  const expected = [
    { label: 'あ'.repeat(50), amount: -1500 },
    { label: '正常項目', amount: 0 },
  ];

  const viaEstimateMeta = await createNormalCase('経路比較A様');
  setPlan('light');
  const req1 = fakeReq(
    { estimateFormSave: { estimateMeta: { extraItems: rawExtraItems } } },
    { method: 'PATCH', query: { id: viaEstimateMeta.id } }
  );
  const res1 = fakeRes();
  await handler(req1, res1);

  const viaRestoreImport = await createNormalCase('経路比較B様');
  const req2 = fakeReq(
    { restoreImport: { estimateMeta: { extraItems: rawExtraItems } } },
    { method: 'PATCH', query: { id: viaRestoreImport.id } }
  );
  const res2 = fakeRes();
  await handler(req2, res2);

  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.deepEqual(res1.body.case.estimateMeta.extraItems, expected, 'estimateMeta経路の正規化結果が期待と異なる');
  assert.deepEqual(res2.body.case.estimateMeta.extraItems, expected, 'restoreImport経路の正規化結果が期待と異なる');
  assert.deepEqual(
    res1.body.case.estimateMeta.extraItems,
    res2.body.case.estimateMeta.extraItems,
    '2つの経路で正規化結果が食い違っている(二重管理の再発の疑い)'
  );
});
