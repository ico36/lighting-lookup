// tests/lib/featureRestrictedBody.test.mjs
// lib/responses.js の featureRestrictedBody() の形を固定する(工程P3-1)。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { featureRestrictedBody } from '../../lib/responses.js';

test('error は feature_restricted、feature に渡したfeatureKeyがそのまま入る', () => {
  const body = featureRestrictedBody({ featureKey: 'archiveSearch' });
  assert.equal(body.error, 'feature_restricted');
  assert.equal(body.feature, 'archiveSearch');
});

test('limitsキーを持たない(caseLimitExceededBody()のlimitsと混同しないため)', () => {
  const body = featureRestrictedBody({ featureKey: 'archiveSearch' });
  assert.equal('limits' in body, false);
});

test('messageに具体的なプラン名(ライト/スタンダード/プロ)を含まない(工程E-1の決定)', () => {
  const body = featureRestrictedBody({ featureKey: 'archiveSearch' });
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
  for (const planName of ['ライト', 'スタンダード', 'プロ', 'light', 'standard', 'pro']) {
    assert.ok(
      !body.message.includes(planName),
      `messageに具体的なプラン名(${planName})が含まれている`
    );
  }
});
