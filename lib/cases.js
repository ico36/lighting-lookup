// lib/cases.js
// 案件管理機能のコアロジック。api/company.js と同じRedis接続設定を使う。
//
// Redisキー設計:
//   case:{caseId}            ... 案件本体(JSON)
//   case:{caseId}:logs       ... ステータス変更履歴(RPUSH)
//   case:{caseId}:searches   ... 紐づく検索履歴(RPUSH)
//
//   cases:{email}            ... 非アーカイブの案件一覧(ZSET, score=createdAt)
//   cases:{email}:active     ... 保存件数カウント対象(ZSET, score=createdAt)
//                                非アーカイブ かつ 失注・キャンセルでないもの
//   cases:{email}:archived   ... アーカイブ済み案件(ZSET, score=archivedAt)
//
//   cases:open       ... 承認待ち/承認済みの案件(ZSET, score=statusUpdatedAt)
//                        → 自動失注バッチの走査対象
//   cases:terminal   ... 完了/失注・キャンセルの案件(ZSET, score=statusUpdatedAt)
//                        → 自動アーカイブバッチの走査対象

import { Redis } from '@upstash/redis';
import { CASE_LIMITS } from './planLimits';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export const STATUS = {
  PENDING_APPROVAL: '承認待ち',
  APPROVED: '承認済み',
  COMPLETED: '完了',
  LOST: '失注・キャンセル',
};

export const OPEN_STATUSES = [STATUS.PENDING_APPROVAL, STATUS.APPROVED];
export const TERMINAL_STATUSES = [STATUS.COMPLETED, STATUS.LOST];

export const GLOBAL_OPEN_KEY = 'cases:open';
export const GLOBAL_TERMINAL_KEY = 'cases:terminal';

const caseKey = (caseId) => `case:${caseId}`;
const logsKey = (caseId) => `case:${caseId}:logs`;
const searchesKey = (caseId) => `case:${caseId}:searches`;
const visibleKey = (email) => `cases:${email}`;
const activeKey = (email) => `cases:${email}:active`;
const archivedKey = (email) => `cases:${email}:archived`;

function newCaseId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseJSON(raw) {
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * 案件を新規作成する。保存件数上限を超える場合はエラーを投げる。
 * @param {string} email
 * @param {{customerName?: string, memo?: string}} data
 */
export async function createCase(email, data = {}) {
  const currentCount = await redis.zcard(activeKey(email));
  if (currentCount >= CASE_LIMITS.maxActiveCases) {
    const err = new Error('CASE_LIMIT_REACHED');
    err.code = 'CASE_LIMIT_REACHED';
    err.limit = CASE_LIMITS.maxActiveCases;
    throw err;
  }

  const now = Date.now();
  const caseId = newCaseId();
  const record = {
    id: caseId,
    email,
    status: STATUS.PENDING_APPROVAL,
    customerName: (data.customerName || '').trim(),
    memo: (data.memo || '').trim(),
    createdAt: now,
    statusUpdatedAt: now,
    archivedAt: null,
  };

  await redis.set(caseKey(caseId), JSON.stringify(record));
  await redis.zadd(visibleKey(email), { score: now, member: caseId });
  await redis.zadd(activeKey(email), { score: now, member: caseId });
  await redis.zadd(GLOBAL_OPEN_KEY, { score: now, member: caseId });

  await redis.rpush(
    logsKey(caseId),
    JSON.stringify({
      fromStatus: null,
      toStatus: STATUS.PENDING_APPROVAL,
      changedBy: 'user',
      changedAt: now,
    })
  );

  return record;
}

export async function getCase(caseId) {
  const raw = await redis.get(caseKey(caseId));
  return parseJSON(raw);
}

/**
 * ステータスを変更する。承認待ち⇄承認済み、完了、失注・キャンセルへの
 * 手動変更をすべてこの関数経由で行う。
 * @param {string} caseId
 * @param {string} newStatus
 * @param {'user' | 'auto'} changedBy
 */
export async function updateCaseStatus(caseId, newStatus, changedBy = 'user') {
  const record = await getCase(caseId);
  if (!record) {
    const err = new Error('CASE_NOT_FOUND');
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }

  const now = Date.now();
  const fromStatus = record.status;
  record.status = newStatus;
  record.statusUpdatedAt = now;

  await redis.set(caseKey(caseId), JSON.stringify(record));
  await redis.rpush(
    logsKey(caseId),
    JSON.stringify({ fromStatus, toStatus: newStatus, changedBy, changedAt: now })
  );

  if (OPEN_STATUSES.includes(newStatus)) {
    await redis.zadd(GLOBAL_OPEN_KEY, { score: now, member: caseId });
  } else {
    await redis.zrem(GLOBAL_OPEN_KEY, caseId);
  }

  if (TERMINAL_STATUSES.includes(newStatus)) {
    await redis.zadd(GLOBAL_TERMINAL_KEY, { score: now, member: caseId });
  } else {
    await redis.zrem(GLOBAL_TERMINAL_KEY, caseId);
  }

  // 保存件数カウント対象からの除外/復帰（失注・キャンセルは即座にカウント対象外）
  if (newStatus === STATUS.LOST) {
    await redis.zrem(activeKey(record.email), caseId);
  } else {
    await redis.zadd(activeKey(record.email), { score: record.createdAt, member: caseId });
  }

  return record;
}

/**
 * 案件をアーカイブ(非表示)にする。物理削除はしない。
 */
export async function archiveCase(caseId) {
  const record = await getCase(caseId);
  if (!record) return null;

  const now = Date.now();
  record.archivedAt = now;
  await redis.set(caseKey(caseId), JSON.stringify(record));

  await redis.zrem(visibleKey(record.email), caseId);
  await redis.zrem(activeKey(record.email), caseId);
  await redis.zrem(GLOBAL_TERMINAL_KEY, caseId);
  await redis.zadd(archivedKey(record.email), { score: now, member: caseId });

  return record;
}

export async function addSearchToCase(caseId, searchData) {
  await redis.rpush(
    searchesKey(caseId),
    JSON.stringify({ ...searchData, searchedAt: Date.now() })
  );
}

export async function listSearchesForCase(caseId) {
  const raw = await redis.lrange(searchesKey(caseId), 0, -1);
  return raw.map(parseJSON);
}

export async function listStatusLogs(caseId) {
  const raw = await redis.lrange(logsKey(caseId), 0, -1);
  return raw.map(parseJSON);
}

/**
 * 通常の案件一覧(非アーカイブ)。新しい順。
 */
export async function listVisibleCases(email) {
  const ids = await redis.zrange(visibleKey(email), 0, -1, { rev: true });
  if (!ids.length) return [];
  const records = await Promise.all(ids.map((id) => getCase(id)));
  return records.filter(Boolean);
}

/**
 * アーカイブ済み案件を日付範囲で検索する。
 * @param {string} email
 * @param {{ from?: Date, to?: Date }} range
 */
export async function searchArchivedCases(email, range = {}) {
  const min = range.from ? range.from.getTime() : 0;
  const max = range.to ? range.to.getTime() : Date.now();
  const ids = await redis.zrange(archivedKey(email), min, max, { byScore: true, rev: true });
  if (!ids.length) return [];
  const records = await Promise.all(ids.map((id) => getCase(id)));
  return records.filter(Boolean);
}
