// tests/support/fakes/stripe.mjs
// 実際に Stripe へ問い合わせない Stripe SDK のフェイク。tests/support/loader.mjs が
// `stripe` の import をここへ差し替える。
//
// 各メソッドは呼び出しごとに擬似的な遅延(DELAY_MS)を挟んでから解決する。
// 遅延を入れないと Promise.all の中身が実際には直列実行でも見かけ上「同時に
// 呼ばれた」ことになってしまい、並列性テストが意味を持たない
// （このリポジトリで一度踏んだ地雷。Obsidianログ「並列性のテストが並列を
// 検出できていなかった」参照）。

const DELAY_MS = 15;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let callLog = [];
let concurrent = 0;
let maxConcurrent = 0;
let handlers = {};

function defaultHandlers() {
  return {
    coupons: {
      retrieve: async () => ({
        valid: true,
        percent_off: 50,
        duration_in_months: 6,
        max_redemptions: 10,
        times_redeemed: 3,
      }),
    },
    customers: {
      list: async () => ({ data: [{ id: 'cus_test' }] }),
    },
    subscriptions: {
      list: async () => ({ data: [defaultSubscription()] }),
      update: async () => {
        throw new Error('fake stripe: subscriptions.update は E-5 のテスト対象外です');
      },
    },
    prices: {
      retrieve: async (id) => defaultPrice(id),
    },
    invoices: {
      createPreview: async (params) => defaultPreview(params),
    },
    checkout: {
      sessions: {
        create: async (params) => ({ url: `https://checkout.test/session?params=${encodeURIComponent(JSON.stringify(params))}` }),
        // 既定は「完了済みセッションなし」。lib/legalConsent.jsのテストが
        // __setHandlerで同意ありのセッションを差し込む。
        list: async () => ({ data: [] }),
      },
    },
    subscriptionSchedules: {
      create: async (params) => defaultScheduleCreate(params),
      update: async (id, params) => defaultScheduleUpdate(id, params),
      retrieve: async (id) => defaultScheduleRetrieve(id),
      release: async (id) => defaultScheduleRelease(id),
    },
  };
}

// Subscription Scheduleのフェイク永続化(インメモリ)。create→update→retrieve→release
// の一連の呼び出しが1テスト内で整合するよう、簡易的なMapで状態を持つ。
// __reset()で必ずクリアする(テスト間の汚染防止)。
let scheduleStore = new Map();
let scheduleIdCounter = 0;

function defaultScheduleCreate(params) {
  const nowSec = Math.floor(Date.now() / 1000);
  const id = `sub_sched_test_${++scheduleIdCounter}`;
  const schedule = {
    id,
    status: 'active',
    subscription: params?.from_subscription || null,
    metadata: {},
    end_behavior: 'release',
    // from_subscriptionでの作成直後は、現在のサブスクをそのまま引き継いだ
    // 1フェーズだけが入っている、という実際のStripeの挙動を模す。
    // 呼び出し側(handleScheduleDowngrade)はこの直後にupdate()でphasesを
    // 2フェーズに置き換えるため、items の中身自体はテストで参照されない。
    phases: [
      {
        start_date: nowSec,
        end_date: nowSec + 30 * 24 * 60 * 60,
        items: [{ price: 'price_light_test' }],
      },
    ],
  };
  scheduleStore.set(id, schedule);
  return schedule;
}

function defaultScheduleUpdate(id, params) {
  const existing = scheduleStore.get(id);
  if (!existing) {
    throw new Error(`[fake stripe] 未知のsubscription scheduleです: ${id}`);
  }
  const updated = {
    ...existing,
    ...(params?.end_behavior ? { end_behavior: params.end_behavior } : {}),
    ...(params?.metadata ? { metadata: { ...existing.metadata, ...params.metadata } } : {}),
    ...(params?.phases ? { phases: params.phases } : {}),
  };
  scheduleStore.set(id, updated);
  return updated;
}

function defaultScheduleRetrieve(id) {
  const existing = scheduleStore.get(id);
  if (!existing) {
    throw new Error(`[fake stripe] 未知のsubscription scheduleです: ${id}`);
  }
  return existing;
}

function defaultScheduleRelease(id) {
  const existing = scheduleStore.get(id);
  if (!existing) {
    throw new Error(`[fake stripe] 未知のsubscription scheduleです: ${id}`);
  }
  const released = { ...existing, status: 'released' };
  scheduleStore.set(id, released);
  return released;
}

function defaultSubscription() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    id: 'sub_test',
    customer: 'cus_test',
    status: 'active',
    current_period_start: nowSec,
    current_period_end: nowSec + 30 * 24 * 60 * 60,
    items: {
      data: [
        {
          id: 'si_test',
          // E-5がテストするのは light → standard/pro のアップグレード。
          // fakes/auth.mjs の既定(limits.plan: 'light')と必ず一致させること。
          price: defaultPrice('price_light_test'),
        },
      ],
    },
  };
}

function defaultPrice(id) {
  const table = {
    price_light_test: {
      id: 'price_light_test',
      unit_amount: 3850,
      currency: 'jpy',
      metadata: { plan: 'light', search_limit: '20', case_limit: '5', retention_days: '30' },
      product: { id: 'prod_light', name: 'ライトプラン' },
    },
    price_standard_test: {
      id: 'price_standard_test',
      unit_amount: 8800,
      currency: 'jpy',
      metadata: { plan: 'standard', search_limit: '100', case_limit: '30', retention_days: '365' },
      product: { id: 'prod_standard', name: 'スタンダードプラン' },
    },
    price_pro_test: {
      id: 'price_pro_test',
      // 税抜18,000円 → 税込19,800円。Stripe の Price は税込で登録されている
      // （api/checkout.js の設計判断・Obsidianログ参照）。
      unit_amount: 19800,
      currency: 'jpy',
      metadata: { plan: 'pro', search_limit: '-1', case_limit: '-1', retention_days: '-1' },
      product: { id: 'prod_pro', name: 'プロプラン' },
    },
  };
  return table[id] || {
    id,
    unit_amount: 0,
    currency: 'jpy',
    metadata: {},
    product: { id: 'prod_unknown', name: null },
  };
}

function defaultPreview(params) {
  const nowSec = Math.floor(Date.now() / 1000);
  // params.discounts の有無で割引あり/なしを出し分ける。実際のStripeも
  // discountsを渡さなければ割引無しの請求になる。ここを固定値のままにすると、
  // 「未設定/枠切れでdiscountsを渡さなかった」ケースでも割引ありのレスポンスを
  // 返してしまい、couponApplied の判定テストが実装のバグを検出できなくなる
  // （偽陰性）。amount_due と total_discount_amounts は必ず同じ条件で揃える。
  const hasDiscount = Array.isArray(params?.discounts) && params.discounts.length > 0;
  return {
    // スタンダード定価8,800円の50%オフ→4,400円、割引額4,400円。
    amount_due: hasDiscount ? 4400 : 8800,
    currency: 'jpy',
    total_discount_amounts: hasDiscount ? [{ amount: 4400 }] : [],
    lines: { data: [{ period: { end: nowSec + 30 * 24 * 60 * 60 } }] },
  };
}

export function __reset() {
  callLog = [];
  concurrent = 0;
  maxConcurrent = 0;
  scheduleStore = new Map();
  scheduleIdCounter = 0;
  handlers = defaultHandlers();
}
__reset();

/**
 * 特定メソッドの挙動を差し替える。任意の深さのドット区切りパスに対応する
 * （例: 'coupons.retrieve' の2階層、'checkout.sessions.list' の3階層）。
 *   __setHandler('coupons.retrieve', async () => { throw new Error('boom'); })
 *   __setHandler('checkout.sessions.list', async () => ({ data: [...] }))
 */
export function __setHandler(path, fn) {
  const parts = path.split('.');
  const method = parts.pop();
  let target = handlers;
  for (const part of parts) {
    if (!target || !(part in target)) {
      throw new Error(`[fake stripe] 未知のメソッドです: ${path}`);
    }
    target = target[part];
  }
  if (!target || !(method in target)) {
    throw new Error(`[fake stripe] 未知のメソッドです: ${path}`);
  }
  target[method] = fn;
}

export function __getCallLog() {
  return callLog.slice();
}

/**
 * defaultPrice()を外部のテストから使うための公開版。ダウングレード系のテストが
 * サブスクのitemsを自前で組み立てる際、price_light_test等の中身をこのファイルと
 * 二重管理しないために使う。
 */
export function __getDefaultPrice(id) {
  return defaultPrice(id);
}

/** subscriptionSchedules.create()で作られたスケジュールIDの一覧(作成順)。 */
export function __getScheduleStoreIds() {
  return [...scheduleStore.keys()];
}

/** テストの検証用。subscriptionSchedules.retrieve()と違い呼び出しログに乗らない。 */
export function __peekSchedule(id) {
  return scheduleStore.get(id) || null;
}

/**
 * subscriptionSchedules.create()を経由せず、既に存在するスケジュールとして
 * ストアへ直接登録する。「サブスクに既にscheduleが付いている」状態を作るテストで、
 * create()の呼び出し履歴を汚さずに済ませるために使う。
 */
export function __seedSchedule(id, data = {}) {
  scheduleStore.set(id, {
    id,
    status: 'active',
    subscription: null,
    metadata: {},
    end_behavior: 'release',
    phases: [],
    ...data,
  });
}

export function __getMaxConcurrent() {
  return maxConcurrent;
}

async function tracked(name, fn, args) {
  concurrent += 1;
  maxConcurrent = Math.max(maxConcurrent, concurrent);
  callLog.push(name);
  try {
    await delay(DELAY_MS);
    return await fn(...args);
  } finally {
    concurrent -= 1;
  }
}

export default function Stripe() {
  return {
    coupons: {
      retrieve: (...args) => tracked('coupons.retrieve', handlers.coupons.retrieve, args),
    },
    customers: {
      list: (...args) => tracked('customers.list', handlers.customers.list, args),
    },
    subscriptions: {
      list: (...args) => tracked('subscriptions.list', handlers.subscriptions.list, args),
      update: (...args) => tracked('subscriptions.update', handlers.subscriptions.update, args),
    },
    prices: {
      retrieve: (...args) => tracked('prices.retrieve', handlers.prices.retrieve, args),
    },
    checkout: {
      sessions: {
        create: (...args) => tracked('checkout.sessions.create', handlers.checkout.sessions.create, args),
        list: (...args) => tracked('checkout.sessions.list', handlers.checkout.sessions.list, args),
      },
    },
    subscriptionSchedules: {
      create: (...args) => tracked('subscriptionSchedules.create', handlers.subscriptionSchedules.create, args),
      update: (...args) => tracked('subscriptionSchedules.update', handlers.subscriptionSchedules.update, args),
      retrieve: (...args) => tracked('subscriptionSchedules.retrieve', handlers.subscriptionSchedules.retrieve, args),
      release: (...args) => tracked('subscriptionSchedules.release', handlers.subscriptionSchedules.release, args),
    },
    invoices: {
      createPreview: (...args) => tracked('invoices.createPreview', handlers.invoices.createPreview, args),
      // 番兵: billing_mode = flexible の契約では retrieveUpcoming が400を返す
      // （Obsidianログ「Stripe が createPreview を使えと明示」）。以前はスタブが
      // これを素通ししていたため実機まで気づけなかった。呼ばれたら即失敗させ、
      // 実装が誤って retrieveUpcoming に戻っていないかを検知する。
      // __setHandler の対象にしない（常に例外を投げることが目的のため）。
      retrieveUpcoming: async () => {
        throw new Error(
          '[fake stripe] invoices.retrieveUpcoming は使用禁止です。billing_mode=flexible では' +
            '400になるため、実装は invoices.createPreview を使うこと' +
            '（api/checkout.js 冒頭のコメント参照）。'
        );
      },
    },
  };
}
