// server/test/logger.test.mjs
// C.1 — pino logger module tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLogger, getRequestLogger } from '../lib/logger.mjs';

test('getLogger returns pino-like API', () => {
  const l = getLogger();
  assert.equal(typeof l.info, 'function');
  assert.equal(typeof l.warn, 'function');
  assert.equal(typeof l.error, 'function');
});

test('getRequestLogger binds request_id', () => {
  const l = getRequestLogger('req-abc');
  assert.equal(l.bindings().request_id, 'req-abc');
});
