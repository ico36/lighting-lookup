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
      createPreview: async () => defaultPreview(),
    },
  };
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

function defaultPreview() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    // 既定は「早期割引が適用された状態」で自己矛盾なく揃える。
    // スタンダード定価8,800円の50%オフ→4,400円、割引額4,400円。
    // total_discount_amounts を空のままにすると、api/checkout.js の
    // couponApplied 判定（total_discount_amounts.some(d => d.amount > 0)）が
    // 既定値のままでも false になり、「枠切れ時に couponApplied が false になる」
    // テストが実装のバグでも通ってしまう（偽陰性）。枠切れのシナリオは
    // __setHandler('invoices.createPreview', ...) で discounts なし相当の
    // レスポンス（total_discount_amounts: []、amount_due: 8800）に差し替える。
    amount_due: 4400,
    currency: 'jpy',
    total_discount_amounts: [{ amount: 4400 }],
    lines: { data: [{ period: { end: nowSec + 30 * 24 * 60 * 60 } }] },
  };
}

export function __reset() {
  callLog = [];
  concurrent = 0;
  maxConcurrent = 0;
  handlers = defaultHandlers();
}
__reset();

/**
 * 特定メソッドの挙動を差し替える。
 *   __setHandler('coupons.retrieve', async () => { throw new Error('boom'); })
 */
export function __setHandler(path, fn) {
  const [obj, method] = path.split('.');
  if (!handlers[obj] || !(method in handlers[obj])) {
    throw new Error(`[fake stripe] 未知のメソッドです: ${path}`);
  }
  handlers[obj][method] = fn;
}

export function __getCallLog() {
  return callLog.slice();
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
