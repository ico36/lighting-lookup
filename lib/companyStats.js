// lib/companyStats.js
// 都道府県別の登録者数集計。api/info/[type].js（type=admin-prefecture-stats）が
// redis.scan()・redis.mget()で取得した生データをここに渡す。
// Redisに一切依存しない純粋関数のため、テストではSCAN/MGETの結果を直接組み立てて渡せる。

import { PREFECTURES } from './prefectures';
import { isAdminEmail } from './adminEmails';

const COMPANY_KEY_PREFIX = 'company:';
const PREVIEW_KEY_PREFIX = 'preview:';

// 'preview:company:foo@example.com' や 'company:foo@example.com' から
// メールアドレス部分だけを取り出す。redisKey()が付けるPreview接頭辞を
// 剥がす処理をここに集約する。
export function extractEmailFromCompanyKey(key) {
  const withoutPreview = key.startsWith(PREVIEW_KEY_PREFIX)
    ? key.slice(PREVIEW_KEY_PREFIX.length)
    : key;
  return withoutPreview.startsWith(COMPANY_KEY_PREFIX)
    ? withoutPreview.slice(COMPANY_KEY_PREFIX.length)
    : withoutPreview;
}

// redis.mget()の各要素は通常JSON自動デシリアライズ済みのオブジェクトで返るが、
// 保存されている値がJSONとして不正な場合(過去の手動編集など)は @upstash/redis が
// パースをあきらめて生の文字列のまま返す経路がある。そのケースをtry/catchで吸収し、
// パースできない・オブジェクトにならない値は「壊れたデータ」として無視する。
function parseCompanyValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * keysはredis.scan()で得たキー一覧、valuesは同じ順序・同じ長さのredis.mget(...keys)
 * の結果(自社情報のJSON、またはnull)を想定する。
 *
 * 管理者アカウント(isAdminEmail)は集計から除外する。prefectureが無い
 * (住所必須化前に登録した既存アカウントなど)ものは「未登録」に計上する。
 * totalは(管理者を除いた)集計対象の総数で、unregistered + byPrefectureの合計に一致する。
 *
 * @param {string[]} keys
 * @param {(object|string|null)[]} values
 * @returns {{ total: number, unregistered: number, byPrefecture: Record<string, number> }}
 */
export function buildPrefectureStats(keys, values) {
  const countByPrefecture = new Map();
  let total = 0;
  let unregistered = 0;

  keys.forEach((key, i) => {
    const company = parseCompanyValue(values[i]);
    if (!company) return; // scan後・mget前に削除された、または壊れた値は無視

    const email = extractEmailFromCompanyKey(key);
    if (isAdminEmail(email)) return;

    total++;

    const prefecture = company.prefecture;
    if (!prefecture) {
      unregistered++;
      return;
    }
    countByPrefecture.set(prefecture, (countByPrefecture.get(prefecture) || 0) + 1);
  });

  // byPrefectureはlib/prefectures.jsの47件の順(北から)で、0件の県は省く。
  const byPrefecture = {};
  for (const prefecture of PREFECTURES) {
    const count = countByPrefecture.get(prefecture) || 0;
    if (count > 0) byPrefecture[prefecture] = count;
  }

  return { total, unregistered, byPrefecture };
}
