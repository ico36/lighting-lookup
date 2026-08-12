// api/checkout.js
//
// 【SDKを上げるときの地雷】プラン変更(update-plan)は次の3つがAPIバージョンに依存する。
// lib/subscription.js の current_period_* と同じ性質の問題なので、SDKを上げるときは
// 3つとも型定義を確認すること。stripe 17.7.0 が固定するAPIバージョンは
// '2025-02-24.acacia'（node_modules/stripe/cjs/apiVersion.js）。
//
//   1. 日割り基準時刻のパラメータ名がプレビューと更新で非対称
//        プレビュー(invoices.createPreview) ... subscription_details.proration_date
//        更新(subscriptions.update)         ... proration_date（フラット）
//      揃えて書き間違えると、片方に効かず提示額と請求額がズレる。
//   2. プレビューは invoices.createPreview (POST /v1/invoices/create_preview) を使う。
//      invoices.retrieveUpcoming (GET /v1/invoices/upcoming) は
//      billing_mode = flexible のサブスクリプションでは使えず400になる
//      （Stripeのエラーメッセージが createPreview を使えと明示する）。実際に
//      テストモードの契約が flexible で、実機確認まで気づけなかった。
//      createPreview は classic でも動くので、billing_mode を問わずこちらに寄せる。
//      なお 17.7.0 の型定義には billing_mode という語自体が存在しない（SDKが概念より古い）。
//      戻り値の型も違う（retrieveUpcoming は UpcomingInvoice、createPreview は Invoice）が、
//      こちらが読む amount_due / currency / total_discount_amounts / total は同じキー。
//   3. 差し替えるアイテムのidの取り方(items.data)。取得は
//      lib/subscription.js の getActiveSubscriptionWithItem() に集約してある。
//
// クーポン(STRIPE_COUPON_ID)は subscriptions.update / createPreview の両方に
// 同じ discounts で渡す。片方だけだと「提示は定価・請求は割引後」またはその逆になる。
// なお update の coupon パラメータは型定義上deprecated（discountsを使えと明記）。

import Stripe from 'stripe';
import { requireAuth, requireAuthWithPlan } from './_auth';
import {
  getStripeCustomerIdByEmail,
  getActiveSubscriptionWithItem,
  getSubscriptionStateCached,
  invalidateSubscriptionCache,
  planLimitsFromPrice,
} from '../lib/subscription';
import { readQuota } from '../lib/quota';
import {
  createUpgradeQuote,
  verifyUpgradeQuote,
  idempotencyKeyFromQuote,
} from '../lib/upgradeQuote';

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 現在のプランから移行できる先。プランの識別子(Stripe の Price metadata の plan)を
// キーにする。ここに無いプラン(pro / unknown / admin)は候補なしで、フロントは
// お問い合わせ導線を出す。
//   pro     ... 最上位なので移行先が無い
//   unknown ... metadata未設定の旧契約者。現在のプランを判定できない以上、移行先を
//               機械的に決めるべきではない
//   admin   ... そもそも上限に到達しないのでボタン自体が出ない
const UPGRADE_PATHS = {
  light: ['standard', 'pro'],
  standard: ['pro'],
};

// プラン識別子 → Price IDの環境変数。クライアントからPrice IDを受け取らないための対応表。
const PRICE_ID_ENV = {
  light: 'STRIPE_PRICE_ID_LIGHT',
  standard: 'STRIPE_PRICE_ID_STANDARD',
  pro: 'STRIPE_PRICE_ID_PRO',
};

// action ごとのハンドラ。新しいアクションを足すときはここに1行追加する。
//
// 【以前はフォールスルーだった】action が未指定でも不明な値でも
// handleCreateCheckoutSession に落ちる形になっていた。タイプミスした action が
// 黙って新規登録フローに落ちるのを避けるため、全アクションを明示し、
// 未知のものは400で弾く。新規登録用のCheckout作成も
// 'create-checkout-session' という名前を付けた。
//
// フロント(public/index.html)から /api/checkout を叩いているのは
// 'create-portal-session' の1箇所だけで、action 無しで呼ぶ経路は存在しないため、
// この変更による既存導線への影響はない（新規申し込み導線を実装するときに
// 'create-checkout-session' を指定すること）。
const ACTIONS = {
  'create-portal-session': handleCreatePortalSession,
  'create-checkout-session': handleCreateCheckoutSession,
  'get-upgrade-options': handleGetUpgradeOptions,
  'update-plan': handleUpdatePlan,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};
  const handle = ACTIONS[action];

  if (!handle) {
    return res.status(400).json({
      error: 'unknown_action',
      message: `action は ${Object.keys(ACTIONS).join(' / ')} のいずれかを指定してください`,
    });
  }

  return handle(req, res);
}

// 既存契約者の解約導線。ログイン済みセッション(Authorization: Bearer)の
// メールアドレスからStripe顧客IDを解決するため、リクエストボディのemailは信用しない
// (他人のメールアドレスを渡して他社の契約を解約できてしまうことを防ぐ)。
async function handleCreatePortalSession(req, res) {
  const email = await requireAuth(req, res);
  if (!email) return; // requireAuth内で既に401/500レスポンス済み

  try {
    const customerId = await getStripeCustomerIdByEmail(email);
    if (!customerId) {
      return res.status(404).json({ error: '契約情報が見つかりませんでした' });
    }

    const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
    const host = req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      // ヘルプの「解約するには」セクションに戻ってくる
      return_url: `${baseUrl}/?help=cancel`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe Billing Portal エラー:', err);
    return res.status(500).json({ error: '解約ページの生成に失敗しました' });
  }
}

/**
 * アップグレード用のクーポン。プレビューと実際の変更の両方に同じものを渡す
 * （片方だけだと提示額と請求額がズレる）。未設定なら割引なしで動く。
 */
function couponDiscounts() {
  return process.env.STRIPE_COUPON_ID ? [{ coupon: process.env.STRIPE_COUPON_ID }] : null;
}

/**
 * 利用者に見せるプラン名。StripeのProduct名をそのまま使う。
 *
 * プラン識別子(light/standard/pro)は内部用で、画面に出すと意味が通らない。かといって
 * 識別子→日本語名の対応表をコードに持つと、上限値のハードコードを潰した方針
 * （数値も名称もStripeを唯一の出所にする）の逆行になる。Price を expand:['product']
 * で引けば往復を増やさずに名前が取れるので、そちらを使う。
 *
 * 取れない場合（Productが削除済み＝DeletedProductにはnameが無い、名前が空、
 * expandし忘れでIDの文字列のまま）は識別子へフォールバックする。表示が消えるより
 * 名前が不格好でも選べる方が実害が小さい。フォールバックしたことはwarnで残す。
 */
function planDisplayName(price, fallbackPlan) {
  const product = price?.product;
  const name = product && typeof product === 'object' ? product.name : null;

  if (typeof name === 'string' && name.trim() !== '') return name.trim();

  console.warn(
    `[checkout] Price ${price?.id || '(unknown)'} から表示名を取得できませんでした` +
      `（product=${typeof product}）。プラン識別子「${fallbackPlan}」を表示に使います。` +
      'StripeのProduct名が設定されているか確認してください。'
  );
  return fallbackPlan || null;
}

// 移行先の候補ごとに、Priceの内容と日割り額をまとめて返す。
// モーダルを開いたときに1回だけ叩かれる想定。
async function handleGetUpgradeOptions(req, res) {
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return;
  const { email, limits } = auth;

  try {
    const { subscription, item } = await getActiveSubscriptionWithItem(email);
    if (!subscription || !item) {
      return res.status(404).json({
        error: 'subscription_not_found',
        message: '契約情報が見つかりませんでした',
      });
    }

    // 現在のプランの表示名も同じ波で取る。subscriptions.list が返す price は
    // product がID文字列のままなので、名前を得るには expand した取得が要る。
    // 共有ヘルパー getActiveSubscriptionWithItem() 側にexpandを足す手もあるが、
    // あちらは認証のたびに通る経路(checkActiveSubscriptionLive)なので触らない。
    const currentPricePromise = item.price?.id
      ? stripe.prices.retrieve(item.price.id, { expand: ['product'] })
      : Promise.resolve(null);

    const targets = UPGRADE_PATHS[limits.plan] || [];

    // pro（最上位）/ unknown（metadata未設定で現在のプランが判定できない）/ admin。
    // 移行先を機械的に決められないので、フロントはお問い合わせ導線を出す。
    // この分岐でも表示名を返す。候補カードが出ないぶん、ここが利用者に見える
    // 唯一のプラン名になるため（特にunknownでは識別子を見せても意味が通らない）。
    if (targets.length === 0) {
      const currentPrice = await currentPricePromise;
      return res.status(200).json({
        currentPlan: limits.plan,
        currentPlanName: currentPrice ? planDisplayName(currentPrice, limits.plan) : null,
        currentLimits: limits,
        options: [],
        contactOnly: true,
      });
    }

    // 日割りの基準時刻は候補ごとに変えず、この呼び出し全体で1つに固定する。
    // 候補ごとに別の時刻を使うと、フロントが「選んだプラン」と「その時刻」を取り違える
    // 余地が生まれる（quoteで対にしているので事故にはならないが、揃える理由もない）。
    const prorationDate = Math.floor(Date.now() / 1000); // 秒エポック（Stripeの単位）
    const discounts = couponDiscounts();

    // 候補どうしは独立で、1候補の中の prices.retrieve と createPreview も
    // 互いに依存しない（前者はPriceの内容、後者は日割り計算）。全部まとめて1波で投げる。
    // 直列だと候補2つで4往復ぶん待つことになる。Promise.all は順序を保つので、
    // UPGRADE_PATHS の並び（standard → pro）はそのまま維持される。
    const settled = await Promise.all(targets.map(async (plan) => {
      const priceId = process.env[PRICE_ID_ENV[plan]];
      if (!priceId) {
        console.warn(
          `[checkout] ${PRICE_ID_ENV[plan]} が未設定のため、移行先候補「${plan}」を出せません。`
        );
        return null;
      }

      const [price, preview] = await Promise.all([
        stripe.prices.retrieve(priceId, { expand: ['product'] }),
        // プレビューにも同じ discounts を渡す。渡さないと割引前の額が出て、
        // 実際の請求（割引後）と食い違う。
        // preview_mode は既定（'next'＝いま発行される請求のプレビュー）のまま渡さない。
        // 'recurring' は次回以降の定期請求のプレビューで、日割りではなく月額が出る。
        stripe.invoices.createPreview({
          customer: subscription.customer,
          subscription: subscription.id,
          subscription_details: {
            items: [{ id: item.id, price: priceId }],
            proration_behavior: 'always_invoice',
            proration_date: prorationDate,
          },
          ...(discounts ? { discounts } : {}),
        }),
      ]);

      const couponApplied = (preview.total_discount_amounts || []).some((d) => d.amount > 0);

      return {
        plan,
        // 画面に出す名前。プラン識別子ではなくStripeのProduct名
        displayName: planDisplayName(price, plan),
        priceLabel: { unitAmount: price.unit_amount, currency: price.currency },
        // 上限値はPrice metadataから作る。フロントに数値を持たせないため
        // （工程DでCASE_LIMITSのハードコードを潰したのと同じ理由）。
        limits: planLimitsFromPrice(price),
        amountDueNow: preview.amount_due,
        currency: preview.currency,
        couponApplied,
        // 移行先とprorationDateの対、および変更前のPrice（二重アップグレード検出用）を
        // まとめて署名したもの。update-plan はこれだけを受け取る。
        quote: createUpgradeQuote({
          email,
          fromPriceId: item.price?.id || null,
          toPriceId: priceId,
          toPlan: plan,
          prorationDate,
          amountDue: preview.amount_due,
          currency: preview.currency,
          couponSent: !!discounts,
          couponApplied,
        }),
      };
    }));

    const options = settled.filter(Boolean);
    const currentPrice = await currentPricePromise;

    return res.status(200).json({
      currentPlan: limits.plan,
      // 現在のプランの表示名。候補カードだけ日本語名で「現在のプラン」が識別子のまま、
      // という不揃いを避ける。metadata未設定(plan='unknown')の契約者にとっては、
      // ここが唯一意味の通るプラン名になる（Product名は metadata と無関係に付いている）。
      currentPlanName: currentPrice ? planDisplayName(currentPrice, limits.plan) : null,
      currentLimits: limits,
      options,
      contactOnly: false,
    });
  } catch (err) {
    console.error('[checkout] アップグレード候補の取得に失敗しました:', err);
    return res.status(500).json({ error: 'internal_error', message: 'プラン情報の取得に失敗しました' });
  }
}

// 実際のプラン変更。受け取るのは get-upgrade-options が発行した quote だけ。
async function handleUpdatePlan(req, res) {
  const auth = await requireAuthWithPlan(req, res);
  if (!auth) return;
  const { email } = auth;

  const token = (req.body || {}).quote;
  const verified = verifyUpgradeQuote(token, email);

  if (!verified.ok) {
    if (verified.reason === 'expired') {
      return res.status(409).json({
        error: 'quote_expired',
        message: '見積の有効期限が切れました。もう一度プランを選び直してください。',
      });
    }
    return res.status(400).json({
      error: 'invalid_quote',
      message: 'プラン変更の情報が正しくありません。画面を開き直してください。',
    });
  }

  const quote = verified.quote;

  // プレビュー時にクーポンを渡していたのに、いまクーポンを用意できない
  // （環境変数が消えた・変わった）場合は中断する。ここを素通しすると、利用者には
  // 割引後の額を見せたまま定価で課金することになる。フロントは402と同じく
  // quoteを捨てて get-upgrade-options を叩き直す（取り直せば割引なしの正しい額が出る）。
  const discounts = couponDiscounts();
  if (quote.couponSent && !discounts) {
    console.error(
      '[checkout] 見積時にクーポンを適用したのに STRIPE_COUPON_ID が解決できません。' +
        'プラン変更を中断しました（定価で課金しないため）。'
    );
    return res.status(409).json({
      error: 'coupon_unavailable',
      message: '割引の適用状態が変わりました。もう一度プランを選び直してください。',
    });
  }

  try {
    const { subscription, item } = await getActiveSubscriptionWithItem(email);
    if (!subscription || !item) {
      return res.status(404).json({
        error: 'subscription_not_found',
        message: '契約情報が見つかりませんでした',
      });
    }

    // 見積を出したあとに別のタブ・端末でプランが変わっていないか。
    // 変わっていたら古い見積で上書きしてしまうので中断する。
    if (item.price?.id !== quote.fromPriceId) {
      return res.status(409).json({
        error: 'plan_changed',
        message: 'プランが変更されています。画面を更新してもう一度お試しください。',
      });
    }

    const updated = await stripe.subscriptions.update(
      subscription.id,
      {
        items: [{ id: item.id, price: quote.toPriceId }],
        proration_behavior: 'always_invoice',
        // プレビューと同じ基準時刻。これを渡さないと提示額と請求額がズレる
        proration_date: quote.prorationDate,
        // 支払いが完了しない場合はプラン変更自体を行わせない。既定(allow_incomplete)
        // だと「プランは上がったが未払い」という中途半端な状態になる。
        payment_behavior: 'error_if_incomplete',
        // プレビューで渡したかどうかに合わせる（片方だけだと額が食い違う）
        ...(quote.couponSent ? { discounts } : {}),
        // 実際に発行された請求書を突き合わせるため。往復は増えない
        expand: ['latest_invoice'],
      },
      { idempotencyKey: idempotencyKeyFromQuote(token) }
    );

    // 提示額と実請求額の突き合わせ。クーポンの枠切れ・日割り基準時刻のズレ・税率の変更
    // など原因を問わず「見せた額と違う額を請求した」ことを検知する。止めることはできない
    // （すでに課金済み）ので、ログに両方の値を残し、レスポンスにも実額を載せて
    // 完了画面で正直に出せるようにする。
    const invoice = updated?.latest_invoice || null;
    const amountCharged = invoice && Number.isFinite(invoice.amount_due) ? invoice.amount_due : null;

    if (amountCharged !== null && amountCharged !== quote.amountDue) {
      console.error(
        `[checkout] 提示額と実請求額が食い違いました（${email}）: ` +
          `提示 ${quote.amountDue} / 実請求 ${amountCharged}（invoice.total=${invoice.total}, ` +
          `invoice=${invoice.id}）。クーポンの引き換え枠切れ、日割り基準時刻のズレ、` +
          '税率の変更などが原因になりえます。'
      );
    } else if (amountCharged === null && quote.amountDue > 0) {
      console.warn(
        `[checkout] 請求書を確認できませんでした（${email}）。提示額 ${quote.amountDue} との突き合わせをスキップします。`
      );
    }

    // 新しい上限を次のリクエストが見られるようにキャッシュを捨てる
    await invalidateSubscriptionCache(email);

    // 変更後の値は getSubscriptionStateCached() で取り直す。自前で組み立てると
    // Price metadata → limits の変換が2経路になるため（工程Cで quota の形が
    // 2種類できた反省）。この呼び出しでStripeへ再照会が入るが、アップグレードは
    // 滅多に起きない操作なので許容する。
    const state = await getSubscriptionStateCached(email);
    const quota = await readQuota({ email, limits: state.limits, period: state.period });

    return res.status(200).json({
      success: true,
      plan: state.limits.plan,
      limits: state.limits,
      quota,
      // 完了画面には提示額ではなく実際に請求された額を出す
      amountCharged,
      currency: quote.currency,
    });
  } catch (err) {
    // カード拒否・3Dセキュア必須など、支払いが完了しなかった場合。
    // error_if_incomplete なのでプラン変更は行われていない（＝何も変わっていない）。
    if (err?.type === 'StripeCardError' || err?.statusCode === 402) {
      console.warn('[checkout] プラン変更の支払いが完了しませんでした:', err.code || err.message);
      return res.status(402).json({
        error: 'payment_failed',
        message: 'お支払いを完了できませんでした。支払い方法を更新してから、もう一度お試しください。',
        code: err.code || null,
      });
    }
    // err.code を明示的に出す。クーポンの引き換え枠が尽きた場合もここに落ちるが、
    // Stripeが返すコードを実測できていないため専用の分岐はまだ作っていない
    // （推測でコード名を書かない）。実際に起きたときにこのログでコードが分かるので、
    // そこで分岐を足すこと。この経路では課金は発生していない。
    console.error(
      `[checkout] プラン変更に失敗しました（code=${err?.code || 'なし'}, type=${err?.type || 'なし'}）:`,
      err
    );
    return res.status(500).json({ error: 'internal_error', message: 'プラン変更に失敗しました' });
  }
}

async function handleCreateCheckoutSession(req, res) {
  // ログイン時に入力されたメールアドレスを受け取る
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'メールアドレスが必要です' });
  }

  // ==========================================
  // 【追加】管理者制限（サービス公開前ロック）
  // ==========================================
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase());

  if (!adminEmails.includes(email.trim().toLowerCase())) {
    return res.status(403).json({ error: '現在サービス準備中のため、新規登録は受け付けておりません。' });
  }
  // ==========================================

  try {
    // サイトのURLを動的に取得（ローカル環境とVercel本番環境の両方に対応）
    const protocol = process.env.NODE_ENV === 'development' ? 'http' : 'https';
    const host = req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    // Stripe Checkout セッションを作成
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',       // 継続課金（サブスク）モード
      customer_email: email,      // 決済画面にメールアドレスを自動入力
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // 商品（サブスク）の価格ID
          quantity: 1,
        },
      ],
      discounts: [
        {
          coupon: process.env.STRIPE_COUPON_ID, // 【ここでクーポンを自動適用】
        },
      ],
      // 決済完了・キャンセル後のリダイレクト先
      success_url: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/`, 
    });

    // 生成されたStripeの決済画面URLを返す
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe Checkout エラー:', err);
    return res.status(500).json({ error: '決済画面の生成に失敗しました' });
  }
}
