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
import { makeLogger } from '../lib/logger.mjs';

test('pino redacts Authorization header in error context', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ err: { config: { headers: { authorization: 'Bearer sk-leak' } } } }, 'failed');
  assert.ok(!JSON.stringify(captured).includes('sk-leak'));
});

test('pino redacts Google query-param key in URL', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ err: { config: { url: 'https://...?key=AIza-LEAK' } } }, 'failed');
  assert.ok(!JSON.stringify(captured).includes('AIza-LEAK'));
});

test('pino redacts sk-ant-LEAK in arbitrary message strings (value-based censor)', () => {
  const captured = [];
  const log = makeLogger({ stream: { write: (l) => captured.push(JSON.parse(l)) } });
  log.error({ msg: 'failed with token sk-ant-LEAK in message' });
  assert.ok(!JSON.stringify(captured).includes('sk-ant-LEAK'));
});
