// tests/support/fakes/redis.mjs
// lib/cases.js が使う Upstash Redis の操作(get/set/del/rpush/lrange/zadd/zrem/
// zcard/zrange/pipeline)だけを実装するin-memoryフェイク。Upstashの全APIを
// 再実装するのではなく、lib/cases.js が実際に呼んでいる範囲に絞る。
//
// 【redisKeyを再エクスポートする理由】lib/cases.js は `import { redis, redisKey }
// from './redis'` で両方を1回のimportで取る。このモジュールが './redis' の差し替え先
// になる以上、redis(クライアント)だけでなく redisKey(キー組み立て関数)も同じ場所から
// 提供しないと、lib/cases.js のモジュール読み込み自体が壊れる(GLOBAL_OPEN_KEY等の
// モジュール直下の定数がimport時点でredisKey()を呼んでいるため)。redisKey自体は
// 本物(../../../lib/redis.js)をそのまま使う(キーの組み立てロジックはフェイクの対象外)。
//
// 【なぜlib/cases.js自体はフェイクにしないか】lib/cases.jsをフェイクにすると、
// isArchived判定やduplicateCase()のロールバックといった本物の分岐ロジックまで
// テスト側で再実装する羽目になり、フェイクの正しさ自体を保証できなくなる。
// そのため lib/cases.js は本物のまま動かし、その下の永続化層(このファイル)だけを
// 差し替える。
//
// 【状態のリセットについて】lib/cases.js は `import { redis } from './redis'` で
// モジュールスコープのシングルトンを掴む。Node の `--test` は複数のテストファイルを
// 同一プロセス内で実行し、モジュールキャッシュも共有されるため、この redis
// オブジェクト自体はテスト全体で使い回される。テストどうしの汚染を防ぐため、
// 各テストの冒頭(またはbeforeEach)で __resetFakeRedis() を呼び、中身(Map)だけを
// クリアすること。

export { redisKey } from '../../../lib/redis.js';

const strings = new Map();
const lists = new Map();
const zsets = new Map();

function getZset(key) {
  if (!zsets.has(key)) zsets.set(key, new Map());
  return zsets.get(key);
}

async function get(key) {
  return strings.has(key) ? strings.get(key) : null;
}

async function set(key, value) {
  strings.set(key, value);
  return 'OK';
}

async function del(...keys) {
  let count = 0;
  for (const key of keys) {
    if (strings.delete(key)) count++;
    if (lists.delete(key)) count++;
    if (zsets.delete(key)) count++;
  }
  return count;
}

async function rpush(key, ...values) {
  if (!lists.has(key)) lists.set(key, []);
  const list = lists.get(key);
  list.push(...values);
  return list.length;
}

async function lrange(key, start, stop) {
  const list = lists.get(key) || [];
  const end = stop === -1 ? list.length : stop + 1;
  return list.slice(start, end);
}

async function zadd(key, { score, member }) {
  getZset(key).set(member, score);
  return 1;
}

async function zrem(key, member) {
  const z = zsets.get(key);
  return z && z.delete(member) ? 1 : 0;
}

async function zcard(key) {
  return (zsets.get(key) || new Map()).size;
}

// lib/cases.js の呼び出し方(searchArchivedCases()のByScore+rev、
// listVisibleCases()の素のrev)の2パターンだけをサポートする。
async function zrange(key, startArg, stopArg, opts = {}) {
  const z = getZset(key);
  let entries = [...z.entries()]; // [member, score][]

  if (opts.byScore) {
    // ZRANGE ... BYSCORE REV は start(第1引数)が上限・stop(第2引数)が下限になる
    // (lib/cases.js searchArchivedCases()のコメントと同じ仕様)。
    const [min, max] = opts.rev ? [stopArg, startArg] : [startArg, stopArg];
    entries = entries.filter(([, score]) => score >= min && score <= max);
    entries.sort((a, b) => a[1] - b[1]);
    if (opts.rev) entries.reverse();
    return entries.map(([member]) => member);
  }

  entries.sort((a, b) => a[1] - b[1]);
  if (opts.rev) entries.reverse();
  const end = stopArg === -1 ? entries.length : stopArg + 1;
  return entries.slice(startArg, end).map(([member]) => member);
}

function pipeline() {
  const queue = [];
  const chain = {
    set: (...args) => { queue.push(() => set(...args)); return chain; },
    zadd: (...args) => { queue.push(() => zadd(...args)); return chain; },
    zrem: (...args) => { queue.push(() => zrem(...args)); return chain; },
    rpush: (...args) => { queue.push(() => rpush(...args)); return chain; },
    del: (...args) => { queue.push(() => del(...args)); return chain; },
    async exec() {
      const results = [];
      for (const task of queue) results.push(await task());
      return results;
    },
  };
  return chain;
}

export const redis = { get, set, del, rpush, lrange, zadd, zrem, zcard, zrange, pipeline };

export function __resetFakeRedis() {
  strings.clear();
  lists.clear();
  zsets.clear();
}
