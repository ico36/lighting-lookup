// tests/lib/detectAndRecordCheckoutConsent.test.mjs
// lib/legalConsent.js の detectAndRecordCheckoutConsent() の分岐網羅。
//
// 【フェイクの構成】Stripe SDK全体は tests/support/fakes/stripe.mjs へ(loader.mjsの
// ルール1)、lib/legalConsent.js が読む `./redis` は同fakes/redis.mjsへ(loader.mjsの
// ルール2d)差し替わる。lib/subscription.js(getStripeCustomerIdByEmailの取得元)は
// フェイクにせず本物を読み込む(customers.listの呼び出し自体はフェイクStripe経由になる)。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as fakeStripe from '../support/fakes/stripe.mjs';
import { __resetFakeRedis } from '../support/fakes/redis.mjs';
import {
  detectAndRecordCheckoutConsent,
  getTosConsent,
  CURRENT_TOS_VERSION,
  CURRENT_TOS_EFFECTIVE_AT,
} from '../../lib/legalConsent.js';

const EMAIL = 'consent-test@example.com';

beforeEach(() => {
  fakeStripe.__reset();
  __resetFakeRedis();
});

test('同意付き(consent.terms_of_service === "accepted")の完了済みセッションがあれば記録される', async () => {
  fakeStripe.__setHandler('checkout.sessions.list', async () => ({
    data: [
      {
        id: 'cs_test_accepted',
        created: Math.floor(Date.now() / 1000),
        consent: { terms_of_service: 'accepted' },
      },
    ],
  }));

  const recorded = await detectAndRecordCheckoutConsent(EMAIL);
  assert.equal(recorded, true);

  const consent = await getTosConsent(EMAIL);
  assert.equal(consent.version, CURRENT_TOS_VERSION);
  assert.equal(consent.source, 'stripe_checkout');
  assert.equal(consent.sessionId, 'cs_test_accepted');
  assert.equal(typeof consent.acceptedAt, 'number');
});

test('完了済みセッションはあっても同意していなければ記録されない', async () => {
  fakeStripe.__setHandler('checkout.sessions.list', async () => ({
    data: [
      {
        id: 'cs_test_no_consent',
        created: Math.floor(Date.now() / 1000),
        consent: { terms_of_service: null },
      },
    ],
  }));

  const recorded = await detectAndRecordCheckoutConsent(EMAIL);
  assert.equal(recorded, false);
  assert.equal(await getTosConsent(EMAIL), null);
});

test('Stripe呼び出しが失敗しても例外を投げずfalseを返す', async () => {
  fakeStripe.__setHandler('checkout.sessions.list', async () => {
    throw new Error('stripe unavailable (test)');
  });

  const recorded = await detectAndRecordCheckoutConsent(EMAIL);
  assert.equal(recorded, false);
  assert.equal(await getTosConsent(EMAIL), null);
});

test('CURRENT_TOS_EFFECTIVE_AT より前に作られたセッションの同意は根拠として使わない', async () => {
  fakeStripe.__setHandler('checkout.sessions.list', async () => ({
    data: [
      {
        id: 'cs_test_before_effective',
        created: CURRENT_TOS_EFFECTIVE_AT - 1,
        consent: { terms_of_service: 'accepted' },
      },
    ],
  }));

  const recorded = await detectAndRecordCheckoutConsent(EMAIL);
  assert.equal(recorded, false);
  assert.equal(await getTosConsent(EMAIL), null);
});
