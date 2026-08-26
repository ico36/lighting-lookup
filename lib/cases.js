// lib/cases.js
// 案件管理機能のコアロジック。Redis接続は lib/redis.js の共通クライアントを使う。
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
//   cases:terminal   ... 完了/失注・キャンセルの案件
//                        (ZSET, score=アーカイブ予定時刻=statusUpdatedAt + retentionDays日)
//                        → 自動アーカイブバッチの走査対象。スコアが「予定時刻」なので、
//                          cronは zrange(0, now) で期限が来たものだけを取り出せる。
//                          無期限(-1)の案件と保持期間が分からない案件は登録しない
//                          （期限が来ないものを走査対象に残さないため）
//
// キーはすべて lib/redis.js の redisKey() 経由で組み立てる。Preview環境では
// 先頭に `preview:` が付き、Productionのデータとは別の名前空間になる。

import { randomUUID } from 'crypto';
import { UNLIMITED, isUnlimited } from './subscription';
import { DAY_MS } from './planLimits';
import { redis, redisKey } from './redis';

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

export const GLOBAL_OPEN_KEY = redisKey('cases', 'open');
export const GLOBAL_TERMINAL_KEY = redisKey('cases', 'terminal');

const caseKey = (caseId) => redisKey('case', caseId);
const logsKey = (caseId) => redisKey('case', caseId, 'logs');
const searchesKey = (caseId) => redisKey('case', caseId, 'searches');
const visibleKey = (email) => redisKey('cases', email);
const activeKey = (email) => redisKey('cases', email, 'active');
const archivedKey = (email) => redisKey('cases', email, 'archived');

function newCaseId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseJSON(raw) {
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function defaultEstimateMeta() {
  return { clientName: '', clientSite: '', laborPrice: 0, visitPrice: 0, bizNote: '', extraItems: [] };
}

// 旧データ(cartItems/estimateMeta導入前に作成された案件)にも初期値を補う
function normalizeCase(record) {
  if (!record) return null;
  if (!Array.isArray(record.cartItems)) record.cartItems = [];
  if (!record.estimateMeta || typeof record.estimateMeta !== 'object') {
    record.estimateMeta = defaultEstimateMeta();
  }
  // estimateMeta自体は存在するがextraItems導入前に保存された旧データの場合、
  // 上のdefaultEstimateMeta()による丸ごと初期化を通らないため、ここで個別に補う。
  // cartItemsと同じく「配列であることの保証」のみで、中身(label/amount)の
  // 妥当性再検証はしない(値の検証はnormalizeExtraItems()が書き込み時に行う)。
  if (!Array.isArray(record.estimateMeta.extraItems)) {
    record.estimateMeta.extraItems = [];
  }
  // additionalKeyword導入前に作成された旧データにも初期値を補う
  if (typeof record.additionalKeyword !== 'string') {
    record.additionalKeyword = '';
  }
  // lastSearchResult導入前に作成された旧データにも初期値(未保存扱い)を補う
  if (record.lastSearchResult === undefined) {
    record.lastSearchResult = null;
  }
  return record;
}

// err.code を持つエラーを生成する。APIハンドラ側はこのcodeで分岐してレスポンスを組み立てる。
function codedError(code, extra) {
  const err = new Error(code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

// 案件取得＋存在チェックの共通化。見つからない場合は CASE_NOT_FOUND を投げる
// （archiveCaseのみ「見つからなければnullを返す」仕様のため、そちらは個別実装のまま）。
async function requireCase(caseId) {
  const record = await getCase(caseId);
  if (!record) throw codedError('CASE_NOT_FOUND');
  return record;
}

/**
 * 案件を新規作成する。保存件数上限を超える場合は CASE_LIMIT_REACHED を投げる。
 *
 * 上限値(caseLimit)は呼び出し側が渡す。requireAuthWithPlan()（api/_auth.js）が返す
 * limits.caseLimit をそのまま渡すこと。この関数自身がサブスク状態を取りに行かないのは
 * lib/planLimits.js のコメント参照。無制限は -1（UNLIMITED）で、判定は isUnlimited()。
 *
 * @param {string} email
 * @param {{customerName?: string, memo?: string}} data
 * @param {{caseLimit?: number, initialStatus?: string}} options
 *   caseLimit     ... 保存できる案件数。-1 で無制限
 *   initialStatus ... 通常は STATUS.PENDING_APPROVAL。カート機能からの自動作成時は
 *                     STATUS.DRAFT（createDraftCase経由）
 */
export async function createCase(email, data = {}, options = {}) {
  // 第3引数は以前 initialStatus の文字列だった（createCase(email, data, STATUS.DRAFT)）。
  // 古い形のまま呼ばれるとオブジェクトの分割代入が全て undefined になり、上限チェックが
  // 黙って無効化される（caseLimit が渡っていないのと同じ状態になる）。落として気付かせる。
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(
      '[cases] createCase() の第3引数は { caseLimit, initialStatus } のオブジェクトです' +
        `（受け取った値: ${JSON.stringify(options)}）。initialStatus を直接渡す旧形式は廃止しました。`
    );
  }

  const { caseLimit, initialStatus = STATUS.PENDING_APPROVAL } = options;

  // 上限が渡されなかった場合は無制限として通す。締め出す側に倒さないのは
  // lib/subscription.js の DEFAULT_PLAN_LIMITS と同じ考え方（metadata未設定の
  // 既存契約者が、ある日いきなり案件を作れなくなる事故を防ぐ）。ただし渡し忘れが
  // 黙って無制限になると上限が効かないので、必ずwarnを残す。
  let effectiveLimit = caseLimit;
  if (!Number.isInteger(effectiveLimit)) {
    console.warn(
      `[cases] createCase() に caseLimit が渡されていません（値: ${JSON.stringify(caseLimit)}）。` +
        '無制限として扱います。呼び出し側で requireAuthWithPlan() の limits.caseLimit を渡してください。'
    );
    effectiveLimit = UNLIMITED;
  }

  if (!isUnlimited(effectiveLimit)) {
    const used = await redis.zcard(activeKey(email));
    if (used >= effectiveLimit) {
      throw codedError('CASE_LIMIT_REACHED', { limit: effectiveLimit, used });
    }
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
    additionalKeyword: '',
    lastSearchResult: null,
    createdAt: now,
    statusUpdatedAt: now,
    archivedAt: null,
  };

  // case本体・案件一覧・保存件数カウント・自動失注バッチ対象・変更履歴は互いに
  // 依存しない別キーへの書き込みのため、1回のパイプラインにまとめて送信する。
  const pipeline = redis.pipeline();
  pipeline.set(caseKey(caseId), JSON.stringify(record));
  pipeline.zadd(visibleKey(email), { score: now, member: caseId });
  pipeline.zadd(activeKey(email), { score: now, member: caseId });
  pipeline.zadd(GLOBAL_OPEN_KEY, { score: now, member: caseId });
  pipeline.rpush(
    logsKey(caseId),
    JSON.stringify({
      fromStatus: null,
      toStatus: initialStatus,
      changedBy: 'user',
      changedAt: now,
    })
  );
  await pipeline.exec();

  return record;
}

/**
 * カート機能で「対象の案件がまだ無い」場合に自動作成する下書き案件。
 * customerNameは空のまま。後から承認待ちへ進めたり案件一覧から編集したりできる。
 *
 * 下書きも保存件数のカウント対象なので、caseLimit は素通しして同じ上限判定にかける。
 * @param {string} email
 * @param {{caseLimit?: number}} options
 */
export async function createDraftCase(email, options = {}) {
  return createCase(email, {}, { ...options, initialStatus: STATUS.DRAFT });
}

export async function getCase(caseId) {
  const raw = await redis.get(caseKey(caseId));
  return normalizeCase(parseJSON(raw));
}

/**
 * ステータスを変更する。承認待ち⇄承認済み、完了、失注・キャンセルへの
 * 手動変更をすべてこの関数経由で行う。
 *
 * 【retentionDaysの焼き込み】完了/失注・キャンセル(TERMINAL_STATUSES)へ遷移した時点で、
 * そのときのプランの保持期間を案件へ書き込む。あとからプランを変更しても、確定済み
 * 案件の期限が動かないようにするため。自動アーカイブのバッチ(api/cron/process-cases.js)は
 * 案件に焼き込まれたこの値だけを見る（全アカウントの完了案件を走査するので、そこで
 * 所有者のプランを引くと案件数だけ問い合わせが発生する）。
 * TERMINAL以外へ差し戻したときは焼き込んだ値を消す。再確定時にそのときのプランで
 * 書き直される。
 *
 * @param {string} caseId
 * @param {string} newStatus
 * @param {'user' | 'auto'} changedBy
 * @param {{retentionDays?: number}} options
 *   retentionDays ... 完了/失注へ遷移するときに焼き込む保持日数。-1 で無期限。
 *     呼び出し側が requireAuthWithPlan() の limits.retentionDays を渡す
 *     （lib/planLimits.js のコメント参照。この関数自身はサブスク状態を取りに行かない）
 */
export async function updateCaseStatus(caseId, newStatus, changedBy = 'user', options = {}) {
  const record = await requireCase(caseId);

  const now = Date.now();
  const fromStatus = record.status;
  record.status = newStatus;
  record.statusUpdatedAt = now;

  const isTerminal = TERMINAL_STATUSES.includes(newStatus);
  const { retentionDays } = options;

  // アーカイブ予定時刻。null は「予定を立てられない」＝ cases:terminal に載せない
  // （無期限、または保持期間が分からない場合）。
  let archiveDueAt = null;

  if (isTerminal) {
    if (Number.isInteger(retentionDays)) {
      record.retentionDays = retentionDays;
      if (!isUnlimited(retentionDays)) {
        archiveDueAt = now + retentionDays * DAY_MS;
      }
    } else {
      // 渡し忘れ。ここで -1(無期限)を書かないのは、-1 が「このアカウントは無期限
      // だった」という積極的な主張であり、渡し忘れの場合それが嘘になるため。
      // フィールドを書かなければ「保持期間が不明な案件」として自動アーカイブの
      // 対象外になり(cronのnoRetentionに計上される)、手動でステータスを触り直せば
      // 焼き直される。
      // createCase()のcaseLimit未指定は「無制限として通す」扱いにしているが、判断基準が
      // 違う。あちらは"利用者を締め出さない"、こちらは"事実でない値を残さない"。
      console.warn(
        `[cases] 案件 ${caseId} を ${newStatus} にする際に retentionDays が渡されませんでした` +
          `（値: ${JSON.stringify(retentionDays)}）。保持期間は焼き込まず、自動アーカイブの` +
          '対象外になります。呼び出し側で requireAuthWithPlan() の limits.retentionDays を渡してください。'
      );
      delete record.retentionDays;
    }
  } else {
    // 差し戻し。確定時に焼き込んだ値は、再確定時にそのときのプランで書き直す
    delete record.retentionDays;
  }

  // case本体・変更履歴・自動失注/自動アーカイブバッチ対象・保存件数カウント対象は
  // 互いに依存しない別キーへの書き込みのため、1回のパイプラインにまとめて送信する。
  const pipeline = redis.pipeline();
  pipeline.set(caseKey(caseId), JSON.stringify(record));
  pipeline.rpush(
    logsKey(caseId),
    JSON.stringify({ fromStatus, toStatus: newStatus, changedBy, changedAt: now })
  );

  if (OPEN_STATUSES.includes(newStatus)) {
    pipeline.zadd(GLOBAL_OPEN_KEY, { score: now, member: caseId });
  } else {
    pipeline.zrem(GLOBAL_OPEN_KEY, caseId);
  }

  // スコアは「アーカイブ予定時刻」。cronは zrange(0, now) で期限到来分だけを取れる。
  // 予定を立てられない案件（無期限、保持期間不明）は登録しない。差し戻し時と同じ
  // zremに落ちるが、元々入っていなければ何も起きない(no-op)だけ。
  if (isTerminal && archiveDueAt !== null) {
    pipeline.zadd(GLOBAL_TERMINAL_KEY, { score: archiveDueAt, member: caseId });
  } else {
    pipeline.zrem(GLOBAL_TERMINAL_KEY, caseId);
  }

  // 保存件数カウント対象からの除外/復帰（失注・キャンセルは即座にカウント対象外）
  if (newStatus === STATUS.LOST) {
    pipeline.zrem(activeKey(record.email), caseId);
  } else {
    pipeline.zadd(activeKey(record.email), { score: record.createdAt, member: caseId });
  }

  await pipeline.exec();

  return record;
}

/**
 * 案件をアーカイブ(非表示)にする。物理削除はしない。
 *
 * 【この関数はrecord.statusを検証しない】呼び出し元で、対象がTERMINAL_STATUSES
 * (完了・失注・キャンセル)であることを保証すること。この関数自身はどのステータスの
 * 案件を渡してもそのままアーカイブしてしまう(cases:openからのzremも行わないため、
 * 下書き等をここに通すとcases:openに残骸が残る)。
 *
 * 呼び出し元は2箇所: api/cron/process-cases.js(自動アーカイブ)は cases:terminal
 * ZSETから拾ったIDしか渡さないため、TERMINAL_STATUSESであることが暗黙に保証されて
 * いる。api/cases/[id].js(手動アーカイブ)は明示的にTERMINAL_STATUSES.includes()で
 * 検証してから呼ぶ。
 */
export async function archiveCase(caseId) {
  const record = await getCase(caseId);
  if (!record) return null;

  const now = Date.now();
  record.archivedAt = now;

  // case本体・案件一覧からの除外・保存件数カウント対象からの除外・アーカイブ一覧への
  // 追加は互いに依存しない別キーへの書き込みのため、1回のパイプラインにまとめて送信する。
  const pipeline = redis.pipeline();
  pipeline.set(caseKey(caseId), JSON.stringify(record));
  pipeline.zrem(visibleKey(record.email), caseId);
  pipeline.zrem(activeKey(record.email), caseId);
  pipeline.zrem(GLOBAL_TERMINAL_KEY, caseId);
  pipeline.zadd(archivedKey(record.email), { score: now, member: caseId });
  await pipeline.exec();

  return record;
}

/**
 * 案件を完全に削除する(archiveCaseとは異なり物理削除。取り消し不可)。
 * 案件本体・ステータス履歴・検索履歴と、非アーカイブ/保存件数カウント/アーカイブ/
 * 自動失注バッチ/自動アーカイブバッチの各ZSETからまとめて削除する。
 */
export async function deleteCase(caseId) {
  const record = await requireCase(caseId);

  const pipeline = redis.pipeline();
  pipeline.del(caseKey(caseId));
  pipeline.del(logsKey(caseId));
  pipeline.del(searchesKey(caseId));
  pipeline.zrem(visibleKey(record.email), caseId);
  pipeline.zrem(activeKey(record.email), caseId);
  pipeline.zrem(archivedKey(record.email), caseId);
  pipeline.zrem(GLOBAL_OPEN_KEY, caseId);
  pipeline.zrem(GLOBAL_TERMINAL_KEY, caseId);
  await pipeline.exec();

  return record;
}

/**
 * 案件を複製して新規案件を作る（アーカイブ済み案件の「この内容で新しい案件を作る」用）。
 *
 * 【複製元からコピーするフィールド】email・customerName・memo・cartItems・estimateMeta のみ。
 * id・status・statusUpdatedAt・archivedAt・createdAt・retentionDays はコピーしない
 * （createCase()が新規発行/初期化する値をそのまま使う）。
 *
 * 【新規案件に新しく焼き込むフィールド】duplicatedFrom: { caseId, createdAt }。
 * 複製元のidと作成日時(数値・エポックミリ秒。createdAtは複製元のものであり、新規案件
 * 自身の作成日時ではない)を持たせ、廃番注意表示の「◯年◯月に作成された案件をもとに
 * 複製」に使う。cartItems側の各アイテムには持たせない＝案件レコード直下のみ。
 *
 * 複製元がアーカイブ済みでも getCase() は case:{caseId} を直接読むため取得できる
 * （cases:{email} のvisible ZSETには依存しない）。
 *
 * createCase()以降（cartItems・estimateMetaのコピー中）に失敗した場合は、
 * 中途半端な複製を残さないよう新規案件を deleteCase() でロールバックする。
 * ロールバック自体が失敗してもログに残すだけにして、元のエラーを握りつぶさない
 * （saveEstimateMeta()と同様、複製元データは読み取りのみなので壊れる心配はない）。
 *
 * 保存件数上限は createCase() が内部で判定・CASE_LIMIT_REACHED を投げるため、
 * この関数では何もしなくても既存の上限チェックにそのまま乗る。
 *
 * @param {string} sourceCaseId 複製元の案件ID
 * @param {string} email 呼び出し元(認証済みユーザー)のメールアドレス。複製元の所有権確認に使う
 * @param {{caseLimit?: number}} options createCase()にそのまま渡す
 */
export async function duplicateCase(sourceCaseId, email, options = {}) {
  const original = await getCase(sourceCaseId);
  if (!original || original.email !== email) {
    throw codedError('CASE_NOT_FOUND');
  }

  // ここでCASE_LIMIT_REACHEDが投げられたら、まだ何も作っていないのでロールバック不要。
  // そのまま呼び出し元(api/cases/index.js)の共通catchへ伝播させる。
  const newRecord = await createCase(
    email,
    { customerName: original.customerName, memo: original.memo },
    options
  );

  try {
    // createdAtは複製元(original)自身の作成日時ではなく、複製の複製である場合に
    // original.duplicatedFrom.createdAtまで遡って最も古い日時を引き継ぐ。器具データの
    // 実際の古さを警告に反映するため（caseIdは辿る経路を保つため直前の複製元のまま）。
    newRecord.duplicatedFrom = {
      caseId: original.id,
      createdAt: original.duplicatedFrom?.createdAt ?? original.createdAt,
    };
    await redis.set(caseKey(newRecord.id), JSON.stringify(newRecord));

    await updateEstimateMeta(newRecord.id, original.estimateMeta);

    for (const item of original.cartItems) {
      await addCartItem(newRecord.id, item);
    }
  } catch (err) {
    try {
      await deleteCase(newRecord.id);
    } catch (cleanupErr) {
      console.error(
        '[cases] 複製失敗後のロールバックにも失敗しました。手動での後始末が必要です:',
        newRecord.id,
        cleanupErr
      );
    }
    throw err;
  }

  return await getCase(newRecord.id);
}

/**
 * カートに器具を1点追加する。同じ器具を複数回追加した場合も統合せず、
 * 都度 itemId を新規発行した別アイテムとして追加する。
 * @param {string} caseId
 * @param {{name?, modelNumber?, manufacturer?, unitPrice?, quantity?, rawDetail?}} item
 */
export async function addCartItem(caseId, item = {}) {
  const record = await requireCase(caseId);

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
  const record = await requireCase(caseId);

  const item = record.cartItems.find((i) => i.itemId === itemId);
  if (!item) throw codedError('CART_ITEM_NOT_FOUND');

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
 * カート内アイテムを、型番の再検索で見つかった新しい候補の内容に差し替える。
 * updateCartItem()と違い、name/modelNumber/manufacturer/rawDetail/unitPriceは
 * addCartItem()と同じ「無条件に上書きし、無効な値は安全な既定値にフォールバックする」
 * 扱いにする（部分更新ではない）。unitPriceを「有効な数値でなければ触らない」に
 * すると、新候補に価格が無い場合に名前・型番だけ新しくなり単価は前の器具のまま
 * 残ってしまい、見積書に古い金額が載る状態ができるため。quantityだけは意図的に
 * 触れず、既存の値を引き継ぐ。
 * @param {string} caseId
 * @param {string} itemId
 * @param {{name?, modelNumber?, manufacturer?, rawDetail?, unitPrice?}} patch
 */
export async function replaceCartItem(caseId, itemId, patch = {}) {
  const record = await requireCase(caseId);

  const item = record.cartItems.find((i) => i.itemId === itemId);
  if (!item) throw codedError('CART_ITEM_NOT_FOUND');

  const unitPrice = Number(patch.unitPrice);

  item.name = patch.name || '';
  item.modelNumber = patch.modelNumber || '';
  item.manufacturer = patch.manufacturer || '';
  item.rawDetail = patch.rawDetail ?? null;
  item.unitPrice = Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0;
  // replacedAtはクライアントから受け取らず、常にサーバー側の時刻で立てる
  item.replacedAt = Date.now();

  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * カートからアイテムを1点削除する。
 * @param {string} caseId
 * @param {string} itemId
 */
export async function removeCartItem(caseId, itemId) {
  const record = await requireCase(caseId);

  record.cartItems = record.cartItems.filter((i) => i.itemId !== itemId);
  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

// 【applyCaseName() / applyEstimateMeta() を切り出した理由】updateCaseName()・
// updateEstimateMeta()・updateCaseNameAndEstimateMeta()の3つが同じ「recordの該当
// フィールドを書き換える」ロジックを必要とする。Redisへの読み書き(requireCase()・
// redis.set())はそれぞれの関数が1回ずつ行う一方、フィールドの書き換え・バリデーション
// (trim・数値チェック等)だけをここに集約することで、3つの関数で挙動が食い違う
// (例えば新関数だけtrimし忘れる)事故を防ぐ。record自体を直接書き換える副作用のみを
// 持ち、Redisには一切触れない。

function applyCaseName(record, customerName) {
  record.customerName = String(customerName || '').trim();
}

// extraItems(任意の費用項目。値引きはマイナス金額の項目として同じ配列に乗せる)の検証。
// applyEstimateMeta()・restoreCaseFromImport()の両方から呼ぶ。estimateMetaの他フィールド
// (laborPrice/visitPriceの`>= 0`検証)は両関数がそれぞれ別々にロジックを持つ二重管理に
// なっており、extraItemsではこれを再発させないためにここへ切り出した。
//
// 【amountがマイナスを許容する理由】laborPrice/visitPriceと違い、値引き表現のために
// 意図的にマイナスを許容する。項目種別(値引き/加算)を分けるフィールドは設けない方針
// (マイナス金額であること自体が値引きの表現)。
//
// 【不正値をエラーにせず0にフォールバックする理由】unitPrice/laborPrice/visitPrice等
// 既存フィールドの「無効な値は行/項目ごと捨てず安全な既定値に補正する」方針を踏襲する。
// labelが入力済みの行がamountの不正値だけを理由に消えると、利用者から見て入力していた
// 項目が理由も分からず消えたように見えるため。
//
// 【labelを50文字で切り詰める(エラーにしない)理由】件数上限は設けない(cartItemsにも
// 配列長の上限が無く、estimateMetaだけに新設する理由が弱いため)一方、labelは
// clientName等と違い「見積書の表の1セルに収める文字列」という具体的な表示先がある。
// 長すぎるlabelは印刷される見積書の表レイアウトを崩す実害があるため、他の無効値と
// 同じ「エラーにせず安全な値に補正して行は残す」方針で切り詰める。
function normalizeExtraItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const amount = Number(item.amount);
      return {
        label: String(item.label || '').trim().slice(0, 50),
        amount: Number.isFinite(amount) ? amount : 0,
      };
    });
}

function applyEstimateMeta(record, updates = {}) {
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
  if (updates.extraItems !== undefined) meta.extraItems = normalizeExtraItems(updates.extraItems);
}

/**
 * 案件名（customerName）を変更する。案件一覧・案件詳細の表示名として使われる。
 * @param {string} caseId
 * @param {string} customerName
 */
export async function updateCaseName(caseId, customerName) {
  const record = await requireCase(caseId);

  applyCaseName(record, customerName);
  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * 追加キーワード（検索フォームの「追加キーワード」欄の内容）を更新する。
 * 型番・見積り内容とは別に案件へ直接保存し(estimateMetaには入れない。見積書
 * フォームの保存とはタイミングが異なり、検索フォーム側でフォーカスが外れる
 * たびに単独で保存されるため)、次回この案件をアクティブにしたときに
 * 検索フォームへ引き継ぐ。
 * @param {string} caseId
 * @param {string} additionalKeyword
 */
export async function updateAdditionalKeyword(caseId, additionalKeyword) {
  const record = await requireCase(caseId);

  record.additionalKeyword = String(additionalKeyword || '').trim();
  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * 検索結果(/api/analyzeのレスポンスをフロントがそのまま保持しているもの、
 * public/index.htmlのlastResult)を、案件が既にアクティブな状態で検索したときに
 * 自動保存する。案件切り替え時に検索結果画面を復元するためだけに使う参照用の
 * スナップショットで、cartItems・estimateMetaのように見積書の内容そのものには
 * 関わらない。サイズの妥当性チェック(上限)はAPI層(api/cases/[id].js)で行い、
 * ここでは受け取った値をそのまま(または未保存を表すnullを)書き込むだけにする。
 * @param {string} caseId
 * @param {object|null} lastSearchResult
 */
export async function updateLastSearchResult(caseId, lastSearchResult) {
  const record = await requireCase(caseId);

  record.lastSearchResult = (lastSearchResult && typeof lastSearchResult === 'object') ? lastSearchResult : null;
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
  const record = await requireCase(caseId);

  applyEstimateMeta(record, updates);
  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * 案件名(customerName)と見積書の付随情報(estimateMeta)を1回のread-modify-writeで
 * まとめて更新する。見積書フォーム画面の「保存」ボタン用。
 *
 * 【なぜ1回にまとめるか】updateCaseName()・updateEstimateMeta()はそれぞれ独立して
 * requireCase()→redis.set()を行うため、両方を別々のリクエストで直列に送ると
 * 安全だが、並列に送ると後勝ちで片方の更新が消えるレースコンディションが起きる
 * (どちらも「変更前のrecord全体を読み込み、該当フィールドだけ書き換えて丸ごと
 * 書き戻す」設計のため)。この関数はrequireCase()・redis.set()をそれぞれ1回だけ
 * 行い、その間に両方のフィールドを書き換えることで、部分保存(片方だけ成功し
 * 片方が失敗する状態)そのものを起こりえなくする。
 *
 * customerName・estimateMetaはどちらか一方だけの指定でも動く(!== undefinedで
 * 判定する)。両方省略した場合は何も書き換えずrecordをそのまま返す
 * (呼び出し側であらかじめ弾く想定だが、ここでも壊れない形にしておく)。
 *
 * @param {string} caseId
 * @param {{customerName?: string, estimateMeta?: {clientName?, clientSite?, laborPrice?, visitPrice?, bizNote?}}} data
 */
export async function updateCaseNameAndEstimateMeta(caseId, data = {}) {
  const { customerName, estimateMeta } = data;
  const record = await requireCase(caseId);

  if (customerName !== undefined) applyCaseName(record, customerName);
  if (estimateMeta !== undefined) applyEstimateMeta(record, estimateMeta);

  await redis.set(caseKey(caseId), JSON.stringify(record));
  return record;
}

/**
 * ローカル保存したJSONファイルから、案件のcartItems・estimateMeta・
 * customerName・memoをまとめて復元する（ファイル読み込み機能用）。
 * ステータスはここでは変更しない（意図しない副作用を避けるため、
 * ステータス変更は既存の changeCaseStatus 経由でのみ行う）。
 * @param {string} caseId
 * @param {{customerName?, memo?, cartItems?, estimateMeta?, duplicatedFrom?}} data
 */
export async function restoreCaseFromImport(caseId, data = {}) {
  const record = await requireCase(caseId);

  if (data.customerName !== undefined) record.customerName = String(data.customerName).trim();
  if (data.memo !== undefined) record.memo = String(data.memo).trim();

  if (Array.isArray(data.cartItems)) {
    record.cartItems = data.cartItems.map((item) => {
      const unitPrice = Number(item.unitPrice);
      const quantity = Number(item.quantity);
      const cartItem = {
        itemId: randomUUID(), // インポート時は新規にitemIdを振り直す
        name: item.name || '',
        modelNumber: item.modelNumber || '',
        manufacturer: item.manufacturer || '',
        unitPrice: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        rawDetail: null, // 見積書に不要なため、インポートでは復元しない
      };
      // replacedAt（差し替え済み表示用）。duplicatedFromと同じガード:
      // 壊れた値なら1970年表示のような破綻を出すより、フィールド自体を
      // セットしない方がましなので、有効なときだけ復元する。
      const replacedAt = Number(item.replacedAt);
      if (Number.isFinite(replacedAt) && replacedAt > 0) {
        cartItem.replacedAt = replacedAt;
      }
      return cartItem;
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
      extraItems: normalizeExtraItems(meta.extraItems),
    };
  }

  // duplicatedFrom（廃番注意表示用）。caseId・createdAtのどちらかが壊れている
  // （改変/破損したファイルを読んだ等）場合は、1970年表示のような壊れた警告を
  // 出すよりフィールド自体をセットしない方がましなので、両方有効なときだけ復元する。
  // ファイルに値が無い/不正な場合、対象案件が既に持っているduplicatedFromは
  // 他のフィールドと同じく明示的に削除せずそのまま残す。
  if (data.duplicatedFrom && typeof data.duplicatedFrom === 'object') {
    const sourceCaseId = String(data.duplicatedFrom.caseId || '').trim();
    const sourceCreatedAt = Number(data.duplicatedFrom.createdAt);
    if (sourceCaseId && Number.isFinite(sourceCreatedAt) && sourceCreatedAt > 0) {
      record.duplicatedFrom = { caseId: sourceCaseId, createdAt: sourceCreatedAt };
    }
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
  // ZRANGE ... BYSCORE REV では start(第1引数)が上限、stop(第2引数)が下限になる
  // （通常のBYSCORE昇順とは逆）。min, maxの順で渡すと start < stop になり常に空配列が返る。
  const ids = await redis.zrange(archivedKey(email), max, min, { byScore: true, rev: true });
  if (!ids.length) return [];
  const records = await Promise.all(ids.map((id) => getCase(id)));
  return records.filter(Boolean);
}
