// api/checkout.js
import Stripe from 'stripe';
import { requireAuth } from './_auth';
import { getStripeCustomerIdByEmail } from '../lib/subscription';

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  if (action === 'create-portal-session') {
    return handleCreatePortalSession(req, res);
  }

  return handleCreateCheckoutSession(req, res);
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
