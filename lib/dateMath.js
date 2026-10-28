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

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 文字列が「YYYY-MM-DD」の日付だけの形式(時刻・タイムゾーンの指定が無い)かどうか。
 * lib/subscription.js の isWithinCampaign2xSignupWindow() が、環境変数
 * (CAMPAIGN_2X_SIGNUP_START/END)にオフセット付きの日時("2026-10-28T00:00:00+09:00")
 * が来たのか、日付だけ("2026-10-28")が来たのかを区別するために使う。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDateOnlyString(value) {
  return typeof value === 'string' && DATE_ONLY_PATTERN.test(value);
}

/**
 * 「YYYY-MM-DD」の日付だけの文字列を、その日のJST(UTC+9)の始まり(00:00:00)または
 * 終わり(23:59:59)のms epochに変換する。
 *
 * 【なぜDate.parse()にそのまま渡さないか】日付だけの文字列をJSのDate.parse()に
 * 渡すとUTCの深夜0時として解釈される(ECMA-262の仕様)。このアプリの利用者・
 * 運用者は日本時間で日付を考えるため、オフセットを書き忘れた場合にJST時間で
 * 実質9時間早く開始・終了してしまう。日付だけの入力は常にJSTとして解釈する。
 *
 * @param {string} dateOnlyStr 「YYYY-MM-DD」形式の文字列(isDateOnlyString()で確認済みの前提)
 * @param {{endOfDay?: boolean}} [options] trueならその日の23:59:59(JST)、
 *   既定(false)なら00:00:00(JST)
 * @returns {number} ms epoch
 */
export function jstDateOnlyToEpochMs(dateOnlyStr, { endOfDay = false } = {}) {
  const [year, month, day] = dateOnlyStr.split('-').map(Number);
  const utcMs = endOfDay
    ? Date.UTC(year, month - 1, day, 23, 59, 59)
    : Date.UTC(year, month - 1, day, 0, 0, 0);
  return utcMs - JST_OFFSET_MS;
}
