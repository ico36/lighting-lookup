// lib/cases.js
// 案件管理機能のコアロジック。api/company.js と同じRedis接続設定を使う。
//
// Redisキー設計:
//   case:{caseId}            ... 案件本体(JSON。cartItems配列を含む)
//   case:{caseId}:logs       ... ステータス変更履歴(RPUSH)
//   case:{caseId}:searches   ... 紐づく検索履歴(RPUSH)
//
//   cases:{email}            ... 非アーカイブの案件一覧(ZSET, score=createdAt)
//   cases:{email}:active     ... 保存件数カウント対象(ZSET, score=createdAt)
//                                非アーカイブ かつ 失注・キャンセルでないもの
//   cases:{email}:archived   ... アーカイブ済み案件(ZSET, score=archivedAt)
//
//   cases:open       ... 下書き/承認待ち/承認済みの案件(ZSET, score=statusUpdatedAt)
//                        → 自動失注バッチの走査対象
//   cases:terminal   ... 完了/失注・キャンセルの案件(ZSET, score=statusUpdatedAt)
//                        → 自動アーカイブバッチの走査対象

import { randomUUID } from 'crypto';
import { Redis } from '@upstash/redis';
import { CASE_LIMITS } from './planLimits';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export const STATUS = {
  DRAFT: '下書き',
  PENDING_APPROVAL: '承認待ち',
  APPROVED: '承認済み',
  COMPLETED: '完了',
  LOST: '失注・キャンセル',
};

// 下書きはカート機能が「対象の案件が無い」場合に自動作成する、customerName未設定の
// 案件。承認待ち/承認済みと同じく「動きがなければ自動失注」の対象に含める。
export const OPEN_STATUSES = [STATUS.DRAFT, STATUS.PENDING_APPROVAL, STATUS.APPROVED];
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

function defaultEstimateMeta() {
  return { clientName: '', clientSite: '', laborPrice: 0, visitPrice: 0, bizNote: '' };
}

// 旧データ(cartItems/estimateMeta導入前に作成された案件)にも初期値を補う
function normalizeCase(record) {
  if (!record) return null;
  if (!Array.isArray(record.cartItems)) record.cartItems = [];
  if (!record.estimateMeta || typeof record.estimateMeta !== 'object') {
    record.estimateMeta = defaultEstimateMeta();
  }
  return record;
}

/**
 * 案件を新規作成する。保存件数上限を超える場合はエラーを投げる。
 * @param {string} email
 * @param {{customerName?: string, memo?: string}} data
 * @param {string} initialStatus - 通常は STATUS.PENDING_APPROVAL。カート機能からの
 *   自動作成時は STATUS.DRAFT を渡す（createDraftCase経由）。
 */
export async function createCase(email, data = {}, initialStatus = STATUS.PENDING_APPROVAL) {
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
    status: initialStatus,
    customerName: (data.customerName || '').trim(),
    memo: (data.memo || '').trim(),
    cartItems: [],
    estimateMeta: defaultEstimateMeta(),
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
      toStatus: initialStatus,
      changedBy: 'user',
      changedAt: now,
    })
  );

  return record;
}

/**
 * カート機能で「対象の案件がまだ無い」場合に自動作成する下書き案件。
 * customerNameは空のまま。後から承認待ちへ進めたり案件一覧から編集したりできる。
 */
export async function createDraftCase(email) {
  return createCase(email, {}, STATUS.DRAFT);
}

export async function getCase(caseId) {
  const raw = await redis.get(caseKey(caseId));
  return normalizeCase(parseJSON(raw));
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

/**
 * カートに器具を1点追加する。同じ器具を複数回追加した場合も統合せず、
 * 都度 itemId を新規発行した別アイテムとして追加する。
 * @param {string} caseId
 * @param {{name?, modelNumber?, manufacturer?, unitPrice?, quantity?, rawDetail?}} item
 */
export async function addCartItem(caseId, item = {}) {
  const record = await getCase(caseId);
  if (!record) {
    const err = new Error('CASE_NOT_FOUND');
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }

  const unitPrice = Number(item.unitPrice);
  const quantity = Number(item.quantity);

  const cartItem = {
    itemId: randomUUID(),
    name: item.name || '',
    modelNumber: item.modelNumber || '',
    manufacturer: item.manufacturer || '',
    unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    rawDetail: item.rawDetail ?? null,
  };

  record.cartItems.push(cartItem);
  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * カート内アイテムの単価・数量を更新する。
 * @param {string} caseId
 * @param {string} itemId
 * @param {{unitPrice?: number, quantity?: number}} updates
 */
export async function updateCartItem(caseId, itemId, updates = {}) {
  const record = await getCase(caseId);
  if (!record) {
    const err = new Error('CASE_NOT_FOUND');
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }

  const item = record.cartItems.find((i) => i.itemId === itemId);
  if (!item) {
    const err = new Error('CART_ITEM_NOT_FOUND');
    err.code = 'CART_ITEM_NOT_FOUND';
    throw err;
  }

  if (updates.unitPrice !== undefined) {
    const price = Number(updates.unitPrice);
    if (Number.isFinite(price) && price >= 0) item.unitPrice = price;
  }
  if (updates.quantity !== undefined) {
    const qty = Number(updates.quantity);
    if (Number.isFinite(qty) && qty > 0) item.quantity = qty;
  }

  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * カートからアイテムを1点削除する。
 * @param {string} caseId
 * @param {string} itemId
 */
export async function removeCartItem(caseId, itemId) {
  const record = await getCase(caseId);
  if (!record) {
    const err = new Error('CASE_NOT_FOUND');
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }

  record.cartItems = record.cartItems.filter((i) => i.itemId !== itemId);
  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * 見積書の付随情報（お客様名・工事場所・施工費・出張費・備考）を更新する。
 * cartItemsとは別に案件へ保存し、次回見積書フォームを開いたときに引き継ぐ。
 * @param {string} caseId
 * @param {{clientName?, clientSite?, laborPrice?, visitPrice?, bizNote?}} updates
 */
export async function updateEstimateMeta(caseId, updates = {}) {
  const record = await getCase(caseId);
  if (!record) {
    const err = new Error('CASE_NOT_FOUND');
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }

  const meta = record.estimateMeta;
  if (updates.clientName !== undefined) meta.clientName = String(updates.clientName).trim();
  if (updates.clientSite !== undefined) meta.clientSite = String(updates.clientSite).trim();
  if (updates.bizNote !== undefined) meta.bizNote = String(updates.bizNote).trim();
  if (updates.laborPrice !== undefined) {
    const v = Number(updates.laborPrice);
    if (Number.isFinite(v) && v >= 0) meta.laborPrice = v;
  }
  if (updates.visitPrice !== undefined) {
    const v = Number(updates.visitPrice);
    if (Number.isFinite(v) && v >= 0) meta.visitPrice = v;
  }

  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * ローカル保存したJSONファイルから、案件のcartItems・estimateMeta・
 * customerName・memoをまとめて復元する（ファイル読み込み機能用）。
 * ステータスはここでは変更しない（意図しない副作用を避けるため、
 * ステータス変更は既存の changeCaseStatus 経由でのみ行う）。
 * @param {string} caseId
 * @param {{customerName?, memo?, cartItems?, estimateMeta?}} data
 */
export async function restoreCaseFromImport(caseId, data = {}) {
  const record = await getCase(caseId);
  if (!record) {
    const err = new Error('CASE_NOT_FOUND');
    err.code = 'CASE_NOT_FOUND';
    throw err;
  }

  if (data.customerName !== undefined) record.customerName = String(data.customerName).trim();
  if (data.memo !== undefined) record.memo = String(data.memo).trim();

  if (Array.isArray(data.cartItems)) {
    record.cartItems = data.cartItems.map((item) => {
      const unitPrice = Number(item.unitPrice);
      const quantity = Number(item.quantity);
      return {
        itemId: randomUUID(), // インポート時は新規にitemIdを振り直す
        name: item.name || '',
        modelNumber: item.modelNumber || '',
        manufacturer: item.manufacturer || '',
        unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        rawDetail: null, // 見積書に不要なため、インポートでは復元しない
      };
    });
  }

  if (data.estimateMeta && typeof data.estimateMeta === 'object') {
    const meta = data.estimateMeta;
    const laborPrice = Number(meta.laborPrice);
    const visitPrice = Number(meta.visitPrice);
    record.estimateMeta = {
      clientName: String(meta.clientName || '').trim(),
      clientSite: String(meta.clientSite || '').trim(),
      laborPrice: Number.isFinite(laborPrice) && laborPrice >= 0 ? laborPrice : 0,
      visitPrice: Number.isFinite(visitPrice) && visitPrice >= 0 ? visitPrice : 0,
      bizNote: String(meta.bizNote || '').trim(),
    };
  }

  await redis.set(caseKey(caseId), JSON.stringify(record));
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
