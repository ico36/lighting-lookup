// tests/api/cases-index.test.mjs
// POST /api/cases (api/cases/index.js) の duplicateFrom に対する工程P3-2の
// プラン制限を検証する。
// - アーカイブ済み案件の複製はライトで403
// - 通常案件の複製はライトでも成功する
// - 存在しないIDは403ではなく404(IDの存在有無を漏らさない設計判断の固定)

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cases/index.js';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { __setAuth, __reset as __resetAuth } from '../support/fakes/auth.mjs';
import { __resetFakeRedis } from '../support/fakes/redis.mjs';
import { createCase, updateCaseStatus, archiveCase, STATUS } from '../../lib/cases.js';

const EMAIL = 'index-tester@example.com';

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

test('ライトでアーカイブ済み案件をduplicateFromに指定してPOST → 403、featureRestrictedBody()の形', async () => {
  const archived = await createArchivedCase('複製元アーカイブ様');
  setPlan('light');

  const req = fakeReq({ duplicateFrom: archived.id }, { method: 'POST' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'feature_restricted');
  assert.equal(res.body.feature, 'archiveAccess');
});

test('ライトで通常案件をduplicateFromに指定してPOST → 成功(201)', async () => {
  const normal = await createCase(EMAIL, { customerName: '複製元通常様' }, { caseLimit: 5 });
  setPlan('light');

  const req = fakeReq({ duplicateFrom: normal.id }, { method: 'POST' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.case.duplicatedFrom.caseId, normal.id);
});

test('スタンダードでアーカイブ済み案件をduplicateFromに指定してPOST → 成功(201)', async () => {
  const archived = await createArchivedCase('スタンダード複製様');
  setPlan('standard');

  const req = fakeReq({ duplicateFrom: archived.id }, { method: 'POST' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 201);
});

// 【設計判断の固定】存在しないIDは403ではなく404にする。ここで403にすると
// 「そのIDは存在する(が権限が無い)」ことが漏れてしまう。api/cases/index.js の
// コメント・api/cases/[id].jsの既存404と同じ考え方。
test('存在しないIDをduplicateFromに指定 → 403ではなく404', async () => {
  setPlan('light');

  const req = fakeReq({ duplicateFrom: 'c_does_not_exist' }, { method: 'POST' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'CASE_NOT_FOUND');
});
