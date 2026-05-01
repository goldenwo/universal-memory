// server/test/log-redaction.test.mjs
//
// G1 / R11 layer 2 — credential redaction tests.
//
// Asserts the two-layer redaction provided by `makeLogger`:
//   1. Pino `redact.paths` strips structurally-known credential fields
//      (Authorization headers, Google query-param `key=`, etc.).
//   2. `formatters.log` value-based censor catches credentials embedded
//      in arbitrary message strings or other free-form positions where
//      no structural path would match (sk-*, sk-ant-*, AIza*, Bearer *).
//
// Each test injects a capture stream into `makeLogger({ stream })` so the
// emitted JSON line lands in an in-memory array — no real stdout, no
// runner interference.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLogger, getLogger, _setLogStreamForTest } from '../lib/logger.mjs';

test('pino redacts Authorization header in error context', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ err: { config: { headers: { authorization: 'Bearer sk-leak' } } } }, 'failed');
  assert.equal(captured.length, 1, 'expected exactly one log line emitted');
  assert.ok(!JSON.stringify(captured).includes('sk-leak'));
});

test('pino redacts Google query-param key in URL', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ err: { config: { url: 'https://...?key=AIza-LEAK' } } }, 'failed');
  assert.equal(captured.length, 1, 'expected exactly one log line emitted');
  assert.ok(!JSON.stringify(captured).includes('AIza-LEAK'));
});

test('pino redacts sk-ant-LEAK in arbitrary message strings (value-based censor)', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ msg: 'failed with token sk-ant-LEAK in message' });
  assert.equal(captured.length, 1, 'expected exactly one log line emitted');
  assert.ok(!JSON.stringify(captured).includes('sk-ant-LEAK'));
});

// PRODUCTION-PATH TESTS — getLogger() is what every server call site uses.
// These would have caught the v0.7 FIN-review bug where redaction was wired
// into makeLogger but NOT into the production base() builder. Without these
// tests, the parallel makeLogger config could drift again.

test('PRODUCTION getLogger() applies path-based redaction (Authorization)', () => {
  const captured = [];
  _setLogStreamForTest({ write: (l) => captured.push(JSON.parse(l)) });
  try {
    const log = getLogger();
    log.error({ err: { config: { headers: { authorization: 'Bearer sk-prodleak' } } } }, 'failed');
    assert.equal(captured.length, 1, 'expected exactly one log line emitted via getLogger()');
    assert.ok(
      !JSON.stringify(captured).includes('sk-prodleak'),
      'getLogger() must apply R11 redaction in production',
    );
  } finally {
    _setLogStreamForTest(null);
  }
});

test('PRODUCTION getLogger() applies value-based censor (sk-ant- in message)', () => {
  const captured = [];
  _setLogStreamForTest({ write: (l) => captured.push(JSON.parse(l)) });
  try {
    const log = getLogger();
    log.error({ msg: 'caught error: sk-ant-prodfreelink in cause' });
    assert.equal(captured.length, 1, 'expected exactly one log line via getLogger()');
    assert.ok(
      !JSON.stringify(captured).includes('sk-ant-prodfreelink'),
      'getLogger() must apply value-based censor in production',
    );
  } finally {
    _setLogStreamForTest(null);
  }
});

test('PRODUCTION getLogger() redacts AIza Google key in URL', () => {
  const captured = [];
  _setLogStreamForTest({ write: (l) => captured.push(JSON.parse(l)) });
  try {
    const log = getLogger();
    log.error({ err: { config: { url: 'https://generativelanguage.googleapis.com/v1/...?key=AIzaProdLeak' } } }, 'failed');
    assert.equal(captured.length, 1, 'expected exactly one log line via getLogger()');
    assert.ok(
      !JSON.stringify(captured).includes('AIzaProdLeak'),
      'getLogger() must redact Google API keys in production URLs',
    );
  } finally {
    _setLogStreamForTest(null);
  }
});
