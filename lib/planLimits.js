// lib/planLimits.js
// 案件管理まわりの「プランに依存しない」定数。
//
// 【CASE_LIMITS を廃止した理由】
// 以前このファイルに maxActiveCases / retentionDays を Infinity でハードコードして
// いたが、「上限値の唯一の出所は Stripe の Price metadata（plan / search_limit /
// case_limit / retention_days）」という方針と正面から衝突していた。上限値は
// lib/subscription.js（DEFAULT_PLAN_LIMITS / ADMIN_PLAN_LIMITS と Price metadata）に
// 一本化し、無制限の表現は -1（UNLIMITED）へ統一した。
//
// Infinity はリポジトリ内で使わない。JSON.stringify() で null に化けるため、
// 案件レコードへ焼き込む値としても Redis に保存する値としても成立しないのが理由。
// 判定は必ず lib/subscription.js の isUnlimited() を経由すること。
//
// 上限値を必要とする処理は、requireAuthWithPlan()（api/_auth.js）が返す limits を
// 呼び出し側から引数で渡す形にしてある。lib/cases.js 自身が認証情報やサブスク状態を
// 取りに行く形にはしない（cronのように「案件へ焼き込んだ値だけを見たい」呼び出し元が
// 困るのと、テスト時にStripe/セッションを用意しないと件数チェックを試せなくなるため）。

// 承認待ち/承認済みのまま動きがない案件を自動的に失注・キャンセルにするまでの猶予日数。
// これはプランごとの上限ではなく全アカウント共通の通常機能なので、Stripeのmetadataでは
// なくコード側に置いたままにする。
export const AUTO_LOSE_GRACE_DAYS = 30;

// 「日数」で表された設定値をミリ秒に直すための係数。
//   - AUTO_LOSE_GRACE_DAYS * DAY_MS      ... 自動失注のしきい値(api/cron/process-cases.js)
//   - retentionDays * DAY_MS             ... アーカイブ予定時刻(lib/cases.js)
// 上の2つは別ファイルで使うが、定義が分かれていると片方だけ直したときに気付けないため
// ここに1つだけ置く。AUTO_LOSE_GRACE_DAYS と同じファイル由来になるのも自然。
export const DAY_MS = 24 * 60 * 60 * 1000;
