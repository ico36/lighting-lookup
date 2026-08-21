// tests/api/cases-archive.test.mjs
// GET /api/cases/archive (api/cases/archive.js) の工程P3-2での変更を検証する。
// - プラン制限を持たない(全プラン開放)
// - レスポンスの各件が toArchiveListItem() の形(キー集合が正確に一致)に絞られている
// - 日付範囲の絞り込みが実際に効いている(フェイクRedisのzrange byScore経由)
//
// lib/cases.js は本物のまま、その下の永続化層(Redis)だけを tests/support/fakes/redis.mjs
// に差し替える(tests/support/loader.mjs の resolve() 参照)。api/cases/archive.js が読む
// `../_auth` は tests/support/fakes/auth.mjs に差し替わる。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler, { toArchiveListItem } from '../../api/cases/archive.js';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { __setAuth, __reset as __resetAuth } from '../support/fakes/auth.mjs';
import { __resetFakeRedis } from '../support/fakes/redis.mjs';
import { createCase, updateCaseStatus, archiveCase, STATUS } from '../../lib/cases.js';

const EMAIL = 'archive-tester@example.com';

beforeEach(() => {
  __resetFakeRedis();
  __resetAuth();
  __setAuth({ email: EMAIL, limits: { plan: 'light', searchLimit: 20, caseLimit: 5, retentionDays: 30 } });
});

// 案件を作り、完了 → アーカイブまで進める。archivedAtにscoreとして使う日時を
// 明示的に指定できるよう、archiveCase()実行前後でRedis側のscoreを直接書き換える
// のではなく、archiveCase()自体は「今」でアーカイブし、範囲検証は
// searchArchivedCases()に渡すfrom/toの方をずらして行う(archivedAtの値そのものを
// テストのために不自然に書き換えない)。
async function createArchivedCase(customerName) {
  const created = await createCase(EMAIL, { customerName }, { caseLimit: 5 });
  await updateCaseStatus(created.id, STATUS.COMPLETED, 'user', { retentionDays: 0 });
  const archived = await archiveCase(created.id);
  return archived;
}

test('toArchiveListItem(): キー集合が id/customerName/status/archivedAt の4つに正確に一致する', () => {
  const record = {
    id: 'c_1',
    customerName: '山田様',
    status: STATUS.COMPLETED,
    archivedAt: 12345,
    cartItems: [{ name: 'ダミー器具' }],
    estimateMeta: { clientName: '秘密' },
    memo: '内部メモ',
  };
  const item = toArchiveListItem(record);
  assert.deepEqual(
    new Set(Object.keys(item)),
    new Set(['id', 'customerName', 'status', 'archivedAt']),
    'キー集合が想定と異なる(存在チェックだけでは、フィールド追加時の漏れを検出できない)'
  );
  // cartItems・estimateMeta・memoが漏れていないことも明示的に確認する
  assert.equal('cartItems' in item, false);
  assert.equal('estimateMeta' in item, false);
  assert.equal('memo' in item, false);
});

test('GET /api/cases/archive: ライトでも200で取得できる(全プラン開放)', async () => {
  __setAuth({ limits: { plan: 'light', searchLimit: 20, caseLimit: 5, retentionDays: 30 } });
  await createArchivedCase('田中様');

  const req = fakeReq(undefined, { method: 'GET' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cases.length, 1);
});

test('GET /api/cases/archive: レスポンスの各件がtoArchiveListItem()の形に絞られている', async () => {
  await createArchivedCase('佐藤様');

  const req = fakeReq(undefined, { method: 'GET' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.cases.length, 1);
  assert.deepEqual(new Set(Object.keys(res.body.cases[0])), new Set(['id', 'customerName', 'status', 'archivedAt']));
});

test('GET /api/cases/archive: 日付範囲の絞り込みが効いている(範囲内→1件、範囲外→0件の対比)', async () => {
  // 同じ1件の案件に対して、範囲内/範囲外の両方を試す。0件側だけの確認だと、
  // 絞り込み自体が壊れて常に空を返すケースを見逃す(範囲内側で1件返ることを
  // 併せて確認して初めて、絞り込みが実際に機能していると言える)。
  const archived = await createArchivedCase('鈴木様');

  const withinFrom = new Date(archived.archivedAt).toISOString().slice(0, 10);
  const withinTo = withinFrom;
  const withinReq = fakeReq(undefined, { method: 'GET', query: { from: withinFrom, to: withinTo } });
  const withinRes = fakeRes();
  await handler(withinReq, withinRes);
  assert.equal(withinRes.statusCode, 200);
  assert.equal(withinRes.body.cases.length, 1, '範囲内(アーカイブ日を含む)なら1件返るはず');

  const futureFrom = new Date(archived.archivedAt + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const futureTo = new Date(archived.archivedAt + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const outsideReq = fakeReq(undefined, { method: 'GET', query: { from: futureFrom, to: futureTo } });
  const outsideRes = fakeRes();
  await handler(outsideReq, outsideRes);
  assert.equal(outsideRes.statusCode, 200);
  assert.equal(outsideRes.body.cases.length, 0, '範囲外(アーカイブ日より後)なら0件のはず');
});

test('GET /api/cases/archive: campaignキーを返さない(工程P3-2でゲート自体を撤去したため)', async () => {
  await createArchivedCase('高橋様');

  const req = fakeReq(undefined, { method: 'GET' });
  const res = fakeRes();
  await handler(req, res);

  assert.equal('campaign' in res.body, false);
});
