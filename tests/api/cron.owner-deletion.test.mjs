// tests/api/cron.owner-deletion.test.mjs
// api/cron/process-cases.js ステップ3(解約から6か月後の自動削除)のテスト。
// lib/ownerDeletion.js の Pass 3a(discoverAndScheduleOwnerDeletions、新規解約の発見)
// と Pass 3b(processDueOwnerDeletions、期日到来分の処理)を、既存の
// tests/api/cron.process-cases.test.mjs と同じフェイク(fakeStripe・フェイクRedis)で
// 検証する。日付は Date.now() を基準にした相対オフセットで組み立て、実行時刻に
// 依存させない(既存テストの流儀と同じ)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/cron/process-cases.js';
import * as fakeStripe from '../support/fakes/stripe.mjs';
import * as fakeBlob from '../support/fakes/blob.mjs';
import { __resetFakeRedis, __getZScore, __makeDelFail, redis, redisKey } from '../support/fakes/redis.mjs';
import { fakeReq, fakeRes } from '../support/fakeHttp.mjs';
import { createCase, getCase } from '../../lib/cases.js';
import {
  OWNER_DELETION_SCHEDULE_KEY,
  OWNER_DELETION_RETENTION_MONTHS,
  MAX_OWNER_DELETIONS_PER_RUN,
  addCalendarMonthsJST,
} from '../../lib/ownerDeletion.js';

const CRON_SECRET = 'test-cron-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  fakeStripe.__reset();
  fakeBlob.__reset();
  __resetFakeRedis();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.ADMIN_EMAILS = 'admin@example.com';
  delete process.env.VERCEL_ENV;
  delete process.env.OWNER_DELETION_DRY_RUN; // 既定 = ドライラン
});

async function callCron() {
  const req = fakeReq(undefined, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  const res = fakeRes();
  await handler(req, res);
  return res;
}

// resolveOwnerDeletionRecheck()/checkActiveSubscriptionLive()が読むフィールド
// (status・ended_at・canceled_at・created)だけを持つ最小限のサブスクオブジェクト。
function subscriptionWith({ id = 'sub_test', customer = 'cus_test', status, canceledAt, endedAt }) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id,
    customer,
    status,
    canceled_at: canceledAt ?? null,
    ended_at: endedAt ?? null,
    created: nowSec,
  };
}

async function setCompany(email, { logoUrl = '' } = {}) {
  await redis.set(redisKey('company', email), { name: 'Test Corp', logoUrl, updatedAt: Date.now() });
}

async function setTos(email) {
  await redis.set(redisKey('tos', email), { version: 'v1', acceptedAt: Date.now(), source: 'gate' });
}

// --- Pass 3a: 新規解約の発見 ---------------------------------------------

test('Pass3a: 解約済みオーナーの削除予定が ended_at+6か月(暦月) で登録される', async () => {
  const email = 'canceled-owner@example.com';
  await setCompany(email);

  const endedAtSec = Math.floor(Date.now() / 1000) - 3600;
  fakeStripe.__setHandler('customers.list', async () => ({ data: [{ id: 'cus_1' }] }));
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionWith({ status: 'canceled', endedAt: endedAtSec, canceledAt: endedAtSec })],
  }));

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ownerDeletion.scheduled.length, 1);
  assert.equal(res.body.ownerDeletion.scheduled[0].email, email);

  const score = __getZScore(OWNER_DELETION_SCHEDULE_KEY, email);
  const expected = addCalendarMonthsJST(endedAtSec * 1000, OWNER_DELETION_RETENTION_MONTHS);
  assert.equal(score, expected);
});

test('Pass3a: 顧客なしオーナーは検知時刻を起点に削除予定が登録される', async () => {
  const email = 'no-customer-owner@example.com';
  await setCompany(email);
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  const before = Date.now();
  await callCron();
  const after = Date.now();

  const score = __getZScore(OWNER_DELETION_SCHEDULE_KEY, email);
  assert.ok(score !== null);
  assert.ok(score >= addCalendarMonthsJST(before, OWNER_DELETION_RETENTION_MONTHS));
  assert.ok(score <= addCalendarMonthsJST(after, OWNER_DELETION_RETENTION_MONTHS));
});

test('Pass3a: 既に削除予定登録済みのオーナーはStripeに問い合わせない', async () => {
  const email = 'already-scheduled@example.com';
  await setCompany(email);
  const farFuture = Date.now() + 200 * DAY_MS;
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: farFuture, member: email });

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const custListCalls = fakeStripe.__getCallLog().filter((name) => name === 'customers.list');
  assert.equal(custListCalls.length, 0, '既登録オーナーなのにStripeに問い合わせている');
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), farFuture, 'スコアは変更されない');
});

test('Pass3a: Stripe障害(status不明)のオーナーは削除予定を登録しない', async () => {
  const email = 'degraded-owner@example.com';
  await setCompany(email);
  fakeStripe.__setHandler('customers.list', async () => {
    throw new Error('stripe unavailable (test)');
  });

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), null);
});

test('Pass3a: company未設定・tos:のみのオーナーもSCAN対象になり削除予定が登録される', async () => {
  const email = 'tos-only@example.com';
  await setTos(email);
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  await callCron();

  assert.ok(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email) !== null);
});

// --- Pass 3b: 期日到来分の処理 --------------------------------------------

test('Pass3b: 期日到来・解約継続 → ドライラン既定では対象を記録するだけで削除しない', async () => {
  const email = 'due-dryrun@example.com';
  const logoUrl = 'https://blob.example/logo.png';
  await setCompany(email, { logoUrl });
  await setTos(email);
  const record = await createCase(email, { customerName: 'X' }, { caseLimit: 5 });

  const dueScore = Date.now() - 1000;
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: dueScore, member: email });

  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));
  fakeStripe.__setHandler('subscriptions.list', async () => {
    throw new Error('顧客が無いのにsubscriptions.listが呼ばれた');
  });

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ownerDeletion.dryRunTargets.length, 1);
  const target = res.body.ownerDeletion.dryRunTargets[0];
  assert.equal(target.email, email);
  assert.deepEqual(target.caseIds, [record.id]);
  assert.equal(target.hasCompany, true);
  assert.equal(target.hasTos, true);
  assert.equal(target.logoUrl, logoUrl);
  assert.deepEqual(res.body.ownerDeletion.deleted, []);

  // 何も実際には消えていないこと
  assert.ok(await redis.get(redisKey('company', email)));
  assert.ok(await redis.get(redisKey('tos', email)));
  assert.ok(await getCase(record.id));
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), dueScore, '予定は変更されない');
});

test('Pass3b: ドライラン無効時は案件・company・tos・Blobロゴ・スケジュールが実際に削除される', async () => {
  process.env.OWNER_DELETION_DRY_RUN = 'false';
  const email = 'due-real@example.com';
  const logoUrl = 'https://blob.example/logo2.png';
  await setCompany(email, { logoUrl });
  await setTos(email);
  const record = await createCase(email, { customerName: 'X' }, { caseLimit: 5 });
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - 1000, member: email });

  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  const res = await callCron();

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.ownerDeletion.deleted, [email]);
  assert.equal(await redis.get(redisKey('company', email)), null);
  assert.equal(await redis.get(redisKey('tos', email)), null);
  assert.equal(await getCase(record.id), null);
  assert.deepEqual(fakeBlob.__getDeletedUrls(), [logoUrl]);
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), null, '削除完了後は予定エントリも消える');
});

test('Pass3b: 期日到来時に有効な契約が見つかれば削除せず予定を取り消す(再契約)', async () => {
  const email = 'reactivated@example.com';
  await setCompany(email);
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - 1000, member: email });

  fakeStripe.__setHandler('customers.list', async () => ({ data: [{ id: 'cus_reactivated' }] }));
  fakeStripe.__setHandler('subscriptions.list', async () => ({
    data: [subscriptionWith({ status: 'active' })],
  }));

  const res = await callCron();

  assert.deepEqual(res.body.ownerDeletion.canceled, [email]);
  assert.deepEqual(res.body.ownerDeletion.deleted, []);
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), null);
  assert.ok(await redis.get(redisKey('company', email)), '削除されていないこと');
});

test('Pass3b: 再契約→再解約でended_atが更新されていれば削除せず予定を先送りする', async () => {
  const email = 'recanceled@example.com';
  await setCompany(email);

  // 最初の解約(古い)を起点にした予定。既に期日到来扱いになるよう過去にしておく。
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - 1000, member: email });

  const oldEndedSec = Math.floor((Date.now() - 200 * DAY_MS) / 1000); // 約200日前(6か月超)
  const newEndedSec = Math.floor((Date.now() - 10 * DAY_MS) / 1000); // 10日前(まだ6か月経っていない)

  fakeStripe.__setHandler('customers.list', async () => ({
    data: [{ id: 'cus_old' }, { id: 'cus_new' }],
  }));
  fakeStripe.__setHandler('subscriptions.list', async (params) => {
    if (params.customer === 'cus_old') {
      return {
        data: [subscriptionWith({ id: 'sub_old', customer: 'cus_old', status: 'canceled', endedAt: oldEndedSec, canceledAt: oldEndedSec })],
      };
    }
    if (params.customer === 'cus_new') {
      return {
        data: [subscriptionWith({ id: 'sub_new', customer: 'cus_new', status: 'canceled', endedAt: newEndedSec, canceledAt: newEndedSec })],
      };
    }
    throw new Error(`想定外のcustomerで呼ばれた: ${params.customer}`);
  });

  const res = await callCron();

  assert.deepEqual(res.body.ownerDeletion.postponed.map((p) => p.email), [email]);
  assert.deepEqual(res.body.ownerDeletion.deleted, []);
  assert.deepEqual(res.body.ownerDeletion.canceled, []);

  const expectedNewDeleteAt = addCalendarMonthsJST(newEndedSec * 1000, OWNER_DELETION_RETENTION_MONTHS);
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), expectedNewDeleteAt);
  assert.ok(await redis.get(redisKey('company', email)), '削除されていないこと');
});

test('Pass3b: Blobロゴ削除の失敗は続行し、Redis側は削除されスケジュールも消える', async () => {
  process.env.OWNER_DELETION_DRY_RUN = 'false';
  const email = 'blob-fail@example.com';
  const logoUrl = 'https://blob.example/broken.png';
  await setCompany(email, { logoUrl });
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - 1000, member: email });
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));
  fakeBlob.__setHandler(async () => {
    throw new Error('blob unavailable (test)');
  });

  const res = await callCron();

  assert.deepEqual(res.body.ownerDeletion.deleted, [email]);
  assert.equal(res.body.ownerDeletion.errors.length, 1);
  assert.equal(res.body.ownerDeletion.errors[0].step, 'blob-logo');
  assert.equal(res.body.ownerDeletion.errors[0].logoUrl, logoUrl);
  assert.equal(await redis.get(redisKey('company', email)), null, 'company側は削除される');
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), null, 'Blobのみの失敗なので予定は消してよい');
});

test('Pass3b: Redis側の削除に失敗したら予定を残し翌日再試行する', async () => {
  process.env.OWNER_DELETION_DRY_RUN = 'false';
  const email = 'redis-fail@example.com';
  await setCompany(email);
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - 1000, member: email });
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));
  __makeDelFail(redisKey('company', email));

  const res = await callCron();

  assert.deepEqual(res.body.ownerDeletion.deleted, []);
  assert.ok(res.body.ownerDeletion.errors.some((e) => e.step === 'redis-cleanup'));
  assert.ok(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email) !== null, '予定は残る(翌日再試行のため)');
});

test('Pass3b: 削除直前のStripe再確認が失敗したら予定を残し翌日再試行する', async () => {
  const email = 'recheck-fail@example.com';
  await setCompany(email);
  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - 1000, member: email });
  fakeStripe.__setHandler('customers.list', async () => {
    throw new Error('stripe unavailable (test)');
  });

  const res = await callCron();

  assert.deepEqual(res.body.ownerDeletion.deleted, []);
  assert.deepEqual(res.body.ownerDeletion.dryRunTargets, []);
  assert.ok(res.body.ownerDeletion.errors.some((e) => e.step === 'recheck'));
  assert.ok(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email) !== null, '予定は残る(翌日再試行のため)');
});

test('Pass3b: 1回のcronで実削除(ドライラン含む)する件数はMAX_OWNER_DELETIONS_PER_RUNまでで、残りは翌日に回る', async () => {
  const totalDue = MAX_OWNER_DELETIONS_PER_RUN + 1;
  const dueEmails = [];
  for (let i = 0; i < totalDue; i++) {
    const email = `cap-owner-${i}@example.com`;
    dueEmails.push(email);
    await setCompany(email);
    // scoreを1msずつずらし、昇順(古い順)の処理順を検証できるようにする。
    await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - (totalDue - i) * 1000, member: email });
  }
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  const res = await callCron();

  assert.equal(res.body.ownerDeletion.dryRunTargets.length, MAX_OWNER_DELETIONS_PER_RUN);

  const processedEmails = new Set(res.body.ownerDeletion.dryRunTargets.map((t) => t.email));
  const untouchedEmail = dueEmails[dueEmails.length - 1]; // 最もscoreが大きい(=最後に期日到来した)もの
  assert.ok(!processedEmails.has(untouchedEmail), '上限を超えた分は処理されないはず');
  assert.ok(__getZScore(OWNER_DELETION_SCHEDULE_KEY, untouchedEmail) !== null, '翌日再試行のため予定は残る');
});

// --- Preview環境の名前空間分離 --------------------------------------------

test('Preview環境: SCANが preview: 接頭辞のキーだけを対象にし、本番のcompany/tosを列挙しない', async () => {
  const prodEmail = 'prod-owner@example.com';
  const previewEmail = 'preview-owner@example.com';

  // 本番環境として先にcompany:を作る(VERCEL_ENV未設定のまま)
  await setCompany(prodEmail);

  // ここからPreview環境として振る舞う
  process.env.VERCEL_ENV = 'preview';
  await setCompany(previewEmail);
  await setTos(previewEmail);

  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  const res = await callCron();

  // previewEmailだけがscheduledに載り、かつ取り出せたemailにpreview:等が
  // 混入していない(extractEmailFromCompanyKey/extractEmailFromTosKeyが
  // 接頭辞を正しく剥がせている)ことを確認する。
  assert.deepEqual(
    res.body.ownerDeletion.scheduled.map((s) => s.email),
    [previewEmail]
  );
  assert.ok(__getZScore(OWNER_DELETION_SCHEDULE_KEY, previewEmail) !== null);

  // 本番のprodEmailは preview:company:* のSCANでは見つからず、登録されないこと
  // (Preview/本番は同一Upstashをprefixだけで分けているため、ここが漏れると
  // Previewの検証操作で本番オーナーのデータを削除予定に載せてしまう事故になる)
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, prodEmail), null);
});

// --- deleteCase()の冪等性 --------------------------------------------------

test('executeOwnerDeletion(): 既に削除済みの案件(CASE_NOT_FOUND)は成功扱いになり、エラーにならない', async () => {
  process.env.OWNER_DELETION_DRY_RUN = 'false';
  const email = 'already-deleted-case@example.com';
  await setCompany(email);
  const record = await createCase(email, { customerName: 'X' }, { caseLimit: 5 });
  // 前回の実行で案件本体だけ先に消えていた状況を模す(索引ZSETにはIDが残ったまま)。
  await redis.del(redisKey('case', record.id));

  await redis.zadd(OWNER_DELETION_SCHEDULE_KEY, { score: Date.now() - 1000, member: email });
  fakeStripe.__setHandler('customers.list', async () => ({ data: [] }));

  const res = await callCron();

  assert.deepEqual(res.body.ownerDeletion.deleted, [email]);
  assert.equal(res.body.ownerDeletion.errors.length, 0, 'CASE_NOT_FOUNDはエラーとして報告されないはず');
  assert.equal(__getZScore(OWNER_DELETION_SCHEDULE_KEY, email), null);
});
