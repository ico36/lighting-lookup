// api/stripe-webhook.js
// Stripeの会社アカウント全体のWebhookを受ける。現時点の用途は会員番号(ls_member_no)の
// 即時採番のみ(customer.subscription.created / customer.subscription.updated)。
//
// 【他のイベント・他製品(KYノート等)は無視する】ここでは何もフィルタしない。
// handleSubscriptionEvent() が呼ぶ assignMemberNoIfMissing() の内部で、
// 照明サーチの3Priceへの絞り込み・有効ステータス判定を行っているため、
// 対象外のイベント/顧客は自動的に何もせず終わる(lib/memberNo.js参照)。
//
// 【created/updatedの両方を受ける理由】Checkout完了直後は決済が同期的に確定する
// (createdの時点でactive)ケースが大半だが、3Dセキュア等で確認が遅れる場合は
// created時点でincompleteのままで、後からupdatedでactiveに変わる。createdだけだと
// そのケースを拾えずログイン/cronフォールバックのみに依存してしまうため、両方を受ける。
//
// 【raw bodyが必要】署名検証(stripe.webhooks.constructEvent)には生のリクエストボディが
// 要る。Vercel既定のJSONパースを無効化するため、下のconfig exportが必須。
//
// 必要な環境変数: STRIPE_WEBHOOK_SECRET（StripeダッシュボードでこのURLを
// Webhookエンドポイントとして登録した際に発行される signing secret）。

import { stripe } from '../lib/subscription';
import { assignMemberNoIfMissing } from '../lib/memberNo';

export const config = {
  api: {
    bodyParser: false,
  },
};

const HANDLED_EVENT_TYPES = ['customer.subscription.created', 'customer.subscription.updated'];

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
