// server/test/oauth-idp-policy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOperatorPolicy } from '../lib/oauth/idp/policy.mjs';

test('numeric config matches the numeric id only, exact-string', () => {
  const p = makeOperatorPolicy({ UM_OAUTH_OPERATOR_GITHUB: '5550123' });
  assert.equal(p.isOperator('github', { subject: '5550123', displayName: 'goldenwo' }), true);
  assert.equal(p.isOperator('github', { subject: '5550124', displayName: 'x' }), false);
  // no == coercion / whitespace / leading +
  assert.equal(p.isOperator('github', { subject: ' 5550123 ', displayName: 'x' }), false);
});

test('non-numeric config matches login case-insensitively', () => {
  const p = makeOperatorPolicy({ UM_OAUTH_OPERATOR_GITHUB: 'GoldenWo' });
  assert.equal(p.isOperator('github', { subject: '5550123', displayName: 'goldenwo' }), true);
  assert.equal(p.isOperator('github', { subject: '5550123', displayName: 'someoneelse' }), false);
});

test('canonical sub: numeric config → github:<id> on EVERY path', () => {
  const p = makeOperatorPolicy({ UM_OAUTH_OPERATOR_GITHUB: '5550123' });
  // identity path (verified live id)
  assert.equal(p.subForIdentity('github', { subject: '5550123' }), 'github:5550123');
  // token / cookie path (no live identity) → canonical operator sub
  assert.equal(p.operatorSub(), 'github:5550123');
  assert.ok(p.allow.has('github:5550123')); // allow-set stores the canonical sub, not the raw id
});

test('canonical sub: unconfigured → owner (zero change for token-only installs)', () => {
  const p = makeOperatorPolicy({});
  assert.equal(p.operatorSub(), 'owner');
});

test('canonical sub: login-only config → owner on token/cookie path (degraded)', () => {
  const p = makeOperatorPolicy({ UM_OAUTH_OPERATOR_GITHUB: 'goldenwo' });
  assert.equal(p.operatorSub(), 'owner');                                   // no id known
  assert.equal(p.subForIdentity('github', { subject: '5550123' }), 'github:5550123'); // live id known
});
