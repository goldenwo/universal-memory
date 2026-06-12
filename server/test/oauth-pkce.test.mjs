import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { verifyS256 } from '../lib/oauth/pkce.mjs';

test('round-trip: verifier matches its own S256 challenge', () => {
  const verifier = randomBytes(32).toString('base64url'); // 43 chars
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  assert.equal(verifyS256(verifier, challenge), true);
});
test('wrong verifier rejected', () => {
  const challenge = createHash('sha256').update('a'.repeat(43), 'ascii').digest('base64url');
  assert.equal(verifyS256('b'.repeat(43), challenge), false);
});
test('RFC 7636 length bounds enforced (43-128)', () => {
  for (const bad of ['short', 'a'.repeat(42), 'a'.repeat(129), '', null, undefined, 42]) {
    assert.equal(verifyS256(bad, 'x'), false);
  }
});
test('empty or non-string challenge rejected', () => {
  const verifier = 'a'.repeat(43);
  for (const bad of ['', null, undefined, 42]) {
    assert.equal(verifyS256(verifier, bad), false);
  }
});
