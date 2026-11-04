// lib/welcomeEmail.js
// 照明サーチの契約が有効(active/trialing)になったときに送る「ご契約ありがとうございます」
// メール。送信元はResend(SDKは使わずfetchのみ、lib/otpMail.jsと同じ方針)。
//
// 【呼び出し元】
//   - api/stripe-webhook.js の handleSubscriptionEvent()。会員番号の採番
//     (assignMemberNoIfMissing)のあとに呼ぶ(メール本文に会員番号を載せるため)。
//   - api/cron/process-cases.js ステップ5(会員番号の採番の保険)。Webhookが届かな
//     かった場合の保険として、同じcandidatesを使い回して未送信なら送る。
//     【cron側は送信済みフラグを先に見てから呼ぶ】cronは候補一覧(candidates)が
//     既にsubscription.idを持っているため、maybeSendWelcomeEmail()を呼ぶ前に
//     welcomeEmailSentKey(sub.id)だけを確認し、フラグが無い場合だけ呼ぶ。
//     maybeSendWelcomeEmail()自体は呼ばれるたびにStripeへ契約を取り直すため、
//     送信済みの契約者にも毎日Stripeへ問い合わせてしまうと、2026-11-02に行った
//     「cronのStripe問い合わせを減らす」方針(会員番号採番保険の全件取得・問い合わせ
//     削減)と食い違う。
//
// 【送信済みの管理をsubscription.id単位にする理由】メール単位だと、プラン変更
// (アップグレード/ダウングレード)や将来の契約変更で誤って再送してしまう事故を
// 防ぎにくい。契約(Stripeのsubscription.id)が変わらない限り二度と送らない、
// という単純な規則にするため、メールアドレスではなくsubscription.idをキーにする。
// これにより:
//   - 解約後に同じメールで申し込み直した場合は、新しいsubscription.idになるため送る
//   - 同じ契約内でのプラン変更(subscriptions.update/Subscription Schedule経由、
//     どちらもsubscription.id自体は変わらない)では送らない
//
// 【ロックと送信済みフラグを分ける理由】Webhookの同時到達(created/updatedが
// ほぼ同時に届く、Stripeの再送等)で二重送信するのを防ぐためのロック
// (welcome-email:lock:{subscriptionId}、短TTL)と、送信が実際に成功したことを
// 示す永続フラグ(welcome-email:sent:{subscriptionId}、TTL無し)を分けている。
// 送信が失敗した場合はフラグを立てないため、次の呼び出し(Webhookの再送・次の
// updatedイベント・翌日のcronの保険)が再試行できる。
//
// 【会員番号が取れない場合】メールは送らず、フラグも立てない(次回に再試行させる)。
// Webhookハンドラは内部エラーに関わらず常にStripeへ200を返すため、Stripe自身の
// 再送には頼れない。実際の再試行は翌日のcronの保険(同じcandidatesを使い回す
// ステップ5)に委ねる想定。

import { redis, redisKey } from './redis';
import { stripe, getActiveSubscriptionWithItem } from './subscription';
import { getMemberNo, formatMemberNo } from './memberNo';

/**
 * 送信済みフラグのRedisキー。api/cron/process-cases.jsの保険ステップが、
 * maybeSendWelcomeEmail()を呼ぶ前にこのキーだけを先に確認できるよう公開する
 * (候補一覧が既に持っているsubscription.idで判定できるため、送信済みの契約者には
 * Stripeへの追加往復(customers.list/subscriptions.list/prices.retrieve)を
 * 発生させずに済む。2026-11-02の「cronのStripe問い合わせを減らす」方針と合わせる)。
 */
export function welcomeEmailSentKey(subscriptionId) {
  return redisKey('welcome-email', 'sent', subscriptionId);
}

const RESEND_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8000;
const WELCOME_EMAIL_SUBJECT = '【照明サーチ】ご契約ありがとうございます';
const WELCOME_EMAIL_LOCK_TTL_SECONDS = 30;

// public/index.htmlの?helpクエリパラメータ(DOMContentLoaded)を汎用化し、ログイン前
// でも開けるようにした上での固定URL。利用規約・プライバシーポリシー・特定商取引法に
// 基づく表記は実在する静的ページ(public/terms.html・privacy.html・tokushoho.html)。
const APP_URL = 'https://lighting.ma-system.co.jp';
const HELP_URL = `${APP_URL}/?help`;
const TERMS_URL = `${APP_URL}/terms.html`;
const PRIVACY_URL = `${APP_URL}/privacy.html`;
const TOKUSHOHO_URL = `${APP_URL}/tokushoho.html`;

/**
 * プランの表示名。api/checkout.jsのplanDisplayName()と同じ方針
 * (StripeのProduct名を使い、取れなければプラン識別子にフォールバック)。
 * item.price.productは展開されていない(getActiveSubscriptionWithItem()の
 * subscriptions.listにexpandを付けていない)ため、ここで1回prices.retrieveする。
 */
async function resolvePlanDisplayName(item) {
  const priceId = item?.price?.id;
  const fallbackPlan = item?.price?.metadata?.plan || null;
  if (!priceId) return fallbackPlan;

  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const product = price?.product;
    const name = product && typeof product === 'object' ? product.name : null;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  } catch (err) {
    console.error(`[welcomeEmail] Price ${priceId} の表示名取得に失敗しました:`, err);
  }

  return fallbackPlan;
}

function buildWelcomeEmailText({ memberNoFormatted, planName, email }) {
  return `照明サーチをご契約いただき、誠にありがとうございます。
ご契約内容は以下のとおりです。

会員番号：${memberNoFormatted}
ご契約プラン：${planName}
ご登録メールアドレス：${email}

■ ご利用の始め方
1. ${APP_URL} を開き、ご登録のメールアドレスを入力してください。
2. メールで届く確認コードを入力するとログインできます。
3. 最初のログイン時に、自社情報（社名・住所など）をご登録ください。
   登録した社名は、見積書の発行元と、請求書・領収書の宛名に使われます。

■ 請求書・領収書
お支払いのたびに、決済サービスのStripeから請求書と領収書を添付したメールが届きます。
宛名は、お申し込み時に入力された社名・屋号です。
変更する場合は、アプリの自社情報で社名を変更してください（次回のお支払いの書類から反映されます）。

■ ヘルプ・規約
ヘルプ：${HELP_URL}
利用規約：${TERMS_URL}
プライバシーポリシー：${PRIVACY_URL}
特定商取引法に基づく表記：${TOKUSHOHO_URL}

■ お問い合わせ
info@ma-system.co.jp（このメールへの返信でも届きます）

――――――――――
エムエーシステム株式会社　照明サーチ`;
}

/**
 * Resend APIへ1通送る(テキストのみ)。失敗時は例外を投げる
 * (呼び出し側のmaybeSendWelcomeEmail()が、送信済みフラグを立てずに終える)。
 * lib/otpMail.jsのsendOtpEmail()と同じ構造。
 *
 * @param {{to: string, memberNoFormatted: string, planName: string}} params
 */
export async function sendWelcomeEmail({ to, memberNoFormatted, planName }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM,
        to: [to],
        // SUPPORT_EMAILが未設定ならJSON.stringifyがキー自体を落とす(undefined)。
        reply_to: process.env.SUPPORT_EMAIL,
        subject: WELCOME_EMAIL_SUBJECT,
        text: buildWelcomeEmailText({ memberNoFormatted, planName, email: to }),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error('[welcomeEmail] Resendへのリクエストに失敗しました:', err.name, err.message);
    throw new Error('ウェルカムメールの送信に失敗しました(リクエストエラー)');
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let detail = null;
    try {
      detail = await response.json();
    } catch (e) {
      // Resendが非JSONを返した場合はステータスのみで組み立てる
    }
    console.error('[welcomeEmail] Resendがエラーを返しました:', response.status, detail?.name, detail?.message);
    throw new Error(`ウェルカムメールの送信に失敗しました(status: ${response.status})`);
  }
}

/**
 * 契約(subscription.id)ごとに1回だけウェルカムメールを送る。
 *
 * @param {string} rawEmail
 * @returns {Promise<{sent: boolean, reason?: string}>}
 *   reason: 'no_active_subscription' | 'already_sent' | 'lock_busy' | 'no_member_no' | 'send_failed'
 */
export async function maybeSendWelcomeEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return { sent: false, reason: 'no_active_subscription' };

  // event.data.objectの中身は信用せず、現在の状態をStripeから取り直す
  // (lib/memberNo.jsのassignMemberNoIfMissing()と同じ考え方)。これにより、
  // 照明サーチ以外のPrice(KYノート等)・有効(active/trialing)でないサブスクは
  // subscriptionがnullになり自動的に対象外になる。
  const { subscription, item } = await getActiveSubscriptionWithItem(email);
  if (!subscription) return { sent: false, reason: 'no_active_subscription' };

  const subscriptionId = subscription.id;
  const sentKey = welcomeEmailSentKey(subscriptionId);
  if (await redis.get(sentKey)) return { sent: false, reason: 'already_sent' };

  const lockKey = redisKey('welcome-email', 'lock', subscriptionId);
  const acquired = await redis.set(lockKey, '1', { nx: true, ex: WELCOME_EMAIL_LOCK_TTL_SECONDS });
  if (!acquired) return { sent: false, reason: 'lock_busy' };

  try {
    // ロック待ちの間に別の呼び出しが送信を完了させている可能性があるため再確認する。
    if (await redis.get(sentKey)) return { sent: false, reason: 'already_sent' };

    const memberNoFormatted = formatMemberNo(await getMemberNo(email));
    if (!memberNoFormatted) {
      console.warn(
        `[welcomeEmail] ${email} の会員番号が未採番のため、ウェルカムメールの送信を` +
          `見送りました(subscription=${subscriptionId})。翌日のcronの保険で再試行されます。`
      );
      return { sent: false, reason: 'no_member_no' };
    }

    const planName = await resolvePlanDisplayName(item);

    try {
      await sendWelcomeEmail({ to: email, memberNoFormatted, planName });
    } catch (err) {
      console.error(
        `[welcomeEmail] ${email} へのウェルカムメール送信に失敗しました(subscription=${subscriptionId}):`,
        err
      );
      return { sent: false, reason: 'send_failed' };
    }

    await redis.set(sentKey, '1');
    return { sent: true };
  } finally {
    await redis.del(lockKey);
  }
}
