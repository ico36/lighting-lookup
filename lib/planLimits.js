// lib/planLimits.js
// 案件管理機能の上限値。現状はプラン分岐なしで全アカウントがこの値を使う。
//
// 2026-07-21の設計ログ（Obsidian）での方針:
//   案件管理は基盤機能として、上限なしで先に全プランへ開放し、
//   利用状況を見てから premium プラン限定の上限（例: basic は5件まで）を
//   導入するかどうかを判断する。導入時はここをプラン別オブジェクトに拡張し、
//   呼び出し側でアカウントのプランを渡すように変更する。

export const CASE_LIMITS = {
  maxActiveCases: Infinity,
  retentionDays: Infinity,
};

// 承認待ち/承認済みのまま動きがない案件を自動的に失注・キャンセルにするまでの猶予日数
// （プラン共通の通常機能として全アカウントに適用する）
export const AUTO_LOSE_GRACE_DAYS = 30;
