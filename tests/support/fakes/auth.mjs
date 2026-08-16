// tests/support/fakes/auth.mjs
// api/checkout.js の `../_auth` をテスト用に差し替えるフェイク。
// requireAuthWithPlan の中身（セッション検証・Redis・Stripe再照会）はE-5の対象外なので、
// テストが { email, limits } を直接差し込めるようにする。

// 既定はライトプラン契約者。E-5がテストする移行先(UPGRADE_PATHS.light = ['standard', 'pro'])
// に合わせる。数値は Stripe Price metadata の実値（lib/subscription.js には数値を
// 持たない方針のため、フェイク側の値も実値に揃える）。
//   light    ... search_limit 20 / case_limit 5  / retention_days 30
//   standard ... search_limit 100 / case_limit 30 / retention_days 365
// fakes/stripe.mjs の defaultSubscription() が返す現行Price（price_light_test）と
// 必ず一致させること。ここだけ light で stripe.mjs 側が standard、のようなズレは
// UPGRADE_PATHS の分岐そのものを壊す。
//
// period は null にしない。null になるのは管理者・契約なし・Stripe障害の
// フェイルオープン・期間フィールド異常の4ケースだけで、いずれも異常系
// （lib/subscription.js の checkActiveSubscriptionLive() のコメント参照）。
// 既定は正常系の { start: 今, end: 30日後 }（ミリ秒）にし、null は
// __setAuth() で明示的に差し込むテストだけに限定する。
function defaultAuth() {
  const now = Date.now();
  return {
    email: 'tester@example.com',
    limits: { plan: 'light', searchLimit: 20, caseLimit: 5, retentionDays: 30 },
    period: { start: now, end: now + 30 * 24 * 60 * 60 * 1000 },
  };
}

let current = defaultAuth();

export function __setAuth(auth) {
  current = { ...current, ...auth };
}

export function __reset() {
  current = defaultAuth();
}

export async function requireAuth() {
  return current.email;
}

export async function requireAuthWithPlan() {
  return { ...current };
}
