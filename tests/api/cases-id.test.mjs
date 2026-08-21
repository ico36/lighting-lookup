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
import { __resetFakeRedis } from '../support/fakes/redis.mjs';
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
