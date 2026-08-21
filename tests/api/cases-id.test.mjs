// tests/api/cases-id.test.mjs
// GET /api/cases/{id} (api/cases/[id].js) の工程P3-2でのプラン制限を検証する。
// - アーカイブ済み + 許可プラン外 → 403 (featureRestrictedBody()の形)
// - 通常案件はプランに関わらず巻き込まれない
// - アーカイブ済み + 許可プランなら200

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
