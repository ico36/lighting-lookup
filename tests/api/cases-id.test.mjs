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
