import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorResponse, httpStatusFor, ERROR_CODES } from '../lib/error-envelope.mjs';

test('errorResponse returns spec-§5.1 wire shape', () => {
  const r = errorResponse('AUTH_INVALID', 'bad token');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'AUTH_INVALID');
  assert.equal(r.error.message, 'bad token');
  assert.equal(r.error.retryable, false);
});

test('httpStatusFor maps AUTH_INVALID to 401', () => {
  assert.equal(httpStatusFor('AUTH_INVALID'), 401);
  assert.equal(httpStatusFor('LIMIT_RATE_EXCEEDED'), 429);
  assert.equal(httpStatusFor('INPUT_TOO_LARGE'), 413);
  assert.equal(httpStatusFor('STATE_LOCK_CONTENTION'), 503);
  assert.equal(httpStatusFor('UPSTREAM_FAILURE'), 502);
  assert.equal(httpStatusFor('SERVER_INTERNAL'), 500);
});

test('ERROR_CODES all carry AUTH_|INPUT_|STATE_|LIMIT_|UPSTREAM_|SERVER_ prefix (§5.2)', () => {
  for (const c of Object.keys(ERROR_CODES)) {
    assert.match(c, /^(AUTH|INPUT|STATE|LIMIT|UPSTREAM|SERVER)_/);
  }
});

test('errorResponse: extras can add fields but CANNOT override code/message/retryable (§5.1 wire-stability)', () => {
  const r = errorResponse('AUTH_INVALID', 'bad token', {
    field: 'password',                 // should appear
    hint: 'check caps lock',           // should appear
    retryable: true,                   // MUST NOT override — AUTH_INVALID is non-retryable
    code: 'SERVER_INTERNAL',           // MUST NOT override — caller's authoritative code wins
    message: 'hijacked',               // MUST NOT override — caller's message wins
  });
  assert.equal(r.error.code, 'AUTH_INVALID', 'extras must not override code');
  assert.equal(r.error.message, 'bad token', 'extras must not override message');
  assert.equal(r.error.retryable, false, 'extras must not override retryable (AUTH_INVALID is non-retryable)');
  assert.equal(r.error.field, 'password', 'extras CAN add new fields');
  assert.equal(r.error.hint, 'check caps lock', 'extras CAN add new fields');
});
