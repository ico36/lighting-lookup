// api/stripe-webhook.js
// Stripeの会社アカウント全体のWebhookを受ける。現時点の用途は、会員番号(ls_member_no)の
// 即時採番、ウェルカムメールの送信、経営統計(lib/contractStats.js)の「現在有効」
// SETの更新(customer.subscription.created / updated / deleted)。
//
// 【他のイベント・他製品(KYノート等)は無視する】ここでは何もフィルタしない。
// handleSubscriptionEvent() が呼ぶ assignMemberNoIfMissing()・maybeSendWelcomeEmail()・
// syncContractStatus()の内部で、照明サーチの3Priceへの絞り込み・有効ステータス判定を
// 行っているため、対象外のイベント/顧客は自動的に何もせず終わる(各ファイル参照)。
//
// 【created/updated/deletedを受ける理由】Checkout完了直後は決済が同期的に確定する
// (createdの時点でactive)ケースが大半だが、3Dセキュア等で確認が遅れる場合は
// created時点でincompleteのままで、後からupdatedでactiveに変わる。createdだけだと
// そのケースを拾えずログイン/cronフォールバックのみに依存してしまうため、両方を受ける。
// deletedは、期間末解約などで契約が実際に終了したタイミングを即座に捉え、経営統計の
// 「現在有効」SETから速やかに外すために受ける(会員番号・ウェルカムメールの各関数は
// 有効な契約が無ければ自動的に何もしないため、deletedを追加しても副作用は増えない)。
//
// 【ウェルカムメールは会員番号の採番のあとに送る】本文に会員番号を載せるため。
// 送信に失敗しても会員番号の採番やこのハンドラの他の処理には影響させない
// (個別のtry/catchで受け止める。lib/welcomeEmail.jsが送信済みフラグの管理まで担う)。
//
// 【raw bodyが必要】署名検証(stripe.webhooks.constructEvent)には生のリクエストボディが
// 要る。Vercel既定のJSONパースを無効化するため、下のconfig exportが必須。
//
// 必要な環境変数: STRIPE_WEBHOOK_SECRET（StripeダッシュボードでこのURLを
// Webhookエンドポイントとして登録した際に発行される signing secret）。

import { stripe } from '../lib/subscription';
import { assignMemberNoIfMissing } from '../lib/memberNo';
import { maybeSendWelcomeEmail } from '../lib/welcomeEmail';
import { syncContractStatus } from '../lib/contractStats';

export const config = {
  api: {
    bodyParser: false,
  },
};

const HANDLED_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 署名検証済みのStripe Eventを受け取り、対象イベントなら会員番号を採番する。
 * raw body・署名検証から分離してあるのは、ここをフェイクStripe/フェイクRedisだけで
 * 単体テストできるようにするため(handler本体はStripe SDKの署名検証に依存し、
 * テストハーネスでは生のHTTPストリームを再現していない)。
 *
 * @param {import('stripe').Stripe.Event} event
 */
export async function handleSubscriptionEvent(event) {
  if (!HANDLED_EVENT_TYPES.includes(event?.type)) return;

  const subscription = event.data?.object;
  const customerRef = subscription?.customer;
  const customerId = typeof customerRef === 'string' ? customerRef : customerRef?.id;
  if (!customerId) return;

  let email;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    email = customer?.email;
  } catch (err) {
    console.error(`[stripe-webhook] customer(${customerId})の取得に失敗しました:`, err);
    return;
  }
  if (!email) return;

  try {
    await assignMemberNoIfMissing(email);
  } catch (err) {
    console.error(`[stripe-webhook] ${email} の会員番号採番に失敗しました:`, err);
  }

  // 会員番号の採番のあとに、ウェルカムメールの送信を検討する。失敗してもここまでの
  // 処理(会員番号の採番)やこのハンドラ自体の正常終了には影響させない。
  try {
    await maybeSendWelcomeEmail(email);
  } catch (err) {
    console.error(`[stripe-webhook] ${email} のウェルカムメール送信確認に失敗しました:`, err);
  }

  // 経営統計(lib/contractStats.js)の「現在有効」SETを更新する。他の処理の結果には
  // 影響させない(独立したtry/catch)。
  try {
    await syncContractStatus(email);
  } catch (err) {
    console.error(`[stripe-webhook] ${email} の契約状態の同期(経営統計)に失敗しました:`, err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET が未設定のため、リクエストを拒否しました');
    return res.status(500).json({ error: 'internal_error' });
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[stripe-webhook] 署名検証に失敗しました:', err.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  await handleSubscriptionEvent(event);

  return res.status(200).json({ received: true });
}
