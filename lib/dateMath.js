// lib/dateMath.js
// 日時計算の共通ユーティリティ。lib/ownerDeletion.js と lib/subscription.js の
// 両方が「暦月を加算する」計算を必要とし、ownerDeletion.js は subscription.js を
// import しているため、関数をどちらか一方に残すと循環importになる。
// 両者から参照できる独立したファイルに置く。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 指定した日時(ms epoch)に暦月を加算する。JST(UTC+9、日本にDSTは無いため固定
 * オフセットで正しい)の日付として計算する。月末を跨ぐ加算で、加算先の月に
 * 存在しない日になる場合(例: 8/31 + 6か月 → 平年の2月には31日が無い)は、
 * その月の末日に丸める(2/28、閏年なら2/29。JSのDate.setMonth()に任せると
 * 3月へ繰り上がってしまう既知の挙動を避けるため、末日を計算してから
 * Date.UTC()で組み立て直す)。
 *
 * @param {number} epochMs
 * @param {number} months
 * @returns {number} 加算後のms epoch
 */
export function addCalendarMonthsJST(epochMs, months) {
  const jst = new Date(epochMs + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth(); // 0-based
  const day = jst.getUTCDate();
  const hours = jst.getUTCHours();
  const minutes = jst.getUTCMinutes();
  const seconds = jst.getUTCSeconds();
  const ms = jst.getUTCMilliseconds();

  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  // 加算先の月の末日(翌月0日目=末日という常套手段)。dayがこれを超えるなら丸める。
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  const resultJstMs = Date.UTC(targetYear, targetMonth, clampedDay, hours, minutes, seconds, ms);
  return resultJstMs - JST_OFFSET_MS;
}
