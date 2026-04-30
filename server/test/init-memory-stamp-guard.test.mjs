/**
 * server/test/init-memory-stamp-guard.test.mjs
 *
 * DE5 — startup guard wiring. The new `initMemoryWithGuard` function builds
 * Memory and then runs the embedding-stamp guard with three branches:
 *
 *   null      → writeStamp(currentEnv) + warn LEGACY_COLLECTION_STAMPED + verifyDim()
 *   match     → verifyDim()  (no write, no warn)
 *   mismatch  → fatal log per spec §6.2 + process.exit(1) — verifyDim NOT called
 *
 * The exported `initMemoryWithGuard({ memory, stamp, log, env, exit })` is a
 * DI seam used only for testing. Production callers use `initMemory()` which
 * builds the dependencies (memory, stamp, log, env=process.env) and delegates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { initMemoryWithGuard, initMemory } from '../mem0-mcp-http.mjs';

test('null stamp branch: writes stamp + emits LEGACY_COLLECTION_STAMPED warn + runs verifyDim', async () => {
  const stubMemory = {};
  const calls = [];
  const stamp = {
    read: async () => null,
    write: async (s) => calls.push(['write', s]),
    verifyDim: async () => calls.push(['verifyDim']),
  };
  const log = {
    warn: (obj, msg) => calls.push(['warn', obj.code, msg]),
    info: () => {},
    fatal: () => { throw new Error('should not fatal'); },
  };
  await initMemoryWithGuard({
    memory: stubMemory,
    stamp,
    log,
    env: { UM_EMBEDDING_PROVIDER: 'openai', UM_EMBEDDING_MODEL: 'text-embedding-3-small' },
  });
  assert.deepEqual(calls.map((c) => c[0]), ['write', 'warn', 'verifyDim']);
  assert.equal(calls.find((c) => c[0] === 'warn')[1], 'LEGACY_COLLECTION_STAMPED');
});

test('match branch: skips writeStamp, runs verifyDim', async () => {
  const stubMemory = {};
  const calls = [];
  const currentStamp = { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 };
  const stamp = {
    read: async () => currentStamp,
    write: async () => calls.push(['write']),
    verifyDim: async () => calls.push(['verifyDim']),
  };
  const log = {
    warn: () => calls.push(['warn']),
    info: () => {},
    fatal: () => { throw new Error('no fatal'); },
  };
  await initMemoryWithGuard({
    memory: stubMemory,
    stamp,
    log,
    env: { UM_EMBEDDING_PROVIDER: 'openai', UM_EMBEDDING_MODEL: 'text-embedding-3-small' },
  });
  assert.deepEqual(calls.map((c) => c[0]), ['verifyDim']);
});

test('mismatch branch: fatal log + does NOT run verifyDim + message contains spec §6.2 reindex pointer', async () => {
  const stubMemory = {};
  const calls = [];
  const stamp = {
    read: async () => ({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }),
    verifyDim: async () => calls.push(['verifyDim']),
  };
  let exited = false;
  const exit = () => { exited = true; throw new Error('process.exit'); };
  const log = {
    fatal: (obj, msg) => calls.push(['fatal', msg, obj]),
    info: () => {},
    warn: () => {},
  };
  await assert.rejects(
    () => initMemoryWithGuard({
      memory: stubMemory,
      stamp,
      log,
      env: { UM_EMBEDDING_PROVIDER: 'google', UM_EMBEDDING_MODEL: 'text-embedding-004' },
      exit,
    }),
    /process\.exit/,
  );
  assert.equal(exited, true);
  const fatal = calls.find((c) => c[0] === 'fatal');
  assert.ok(fatal, 'fatal log must be emitted');
  // Spec §6.2 commits the message to point at `um-cli reindex --confirm` and to surface
  // both stamped and configured shapes. Asserting these locks the DE→E coupling
  // (spec §13.1: guard's error message points at the CLI) at the contract level.
  assert.match(fatal[1], /um-cli reindex --confirm/, 'message must point at the CLI');
  assert.match(fatal[1], /Stamped:/i,                'must show stamped config');
  assert.match(fatal[1], /Configured:/i,             'must show configured env');
  assert.ok(!calls.some((c) => c[0] === 'verifyDim'), 'verifyDim must NOT run on mismatch');
});

test('null stamp branch with provider=google + no UM_EMBEDDING_MODEL uses registry default', async () => {
  // I1 regression: previous code's ternary returned the (already-falsy)
  // env.UM_EMBEDDING_MODEL on the non-openai branch, so google/anthropic/ollama
  // operators got model=undefined into the stamp + a downstream false fatal.
  // Fix sources the per-provider default from the registry (single SoT).
  const calls = [];
  const stamp = {
    read: async () => null,
    write: async (s) => calls.push(['write', s]),
    verifyDim: async () => calls.push(['verifyDim']),
  };
  const log = {
    warn: () => {},
    info: () => {},
    fatal: () => { throw new Error('should not fatal'); },
  };
  await initMemoryWithGuard({
    memory: {},
    stamp,
    log,
    env: { UM_EMBEDDING_PROVIDER: 'google' }, // no UM_EMBEDDING_MODEL
  });
  const writtenStamp = calls.find((c) => c[0] === 'write')[1];
  assert.ok(writtenStamp.model, 'model must be derived from registry default');
  assert.notEqual(writtenStamp.model, undefined, 'model must not be undefined');
  // Lock the contract to google's current registry default. If google.mjs
  // changes embeddingModel, this test forces the change to be intentional.
  assert.equal(writtenStamp.model, 'text-embedding-004');
});

test('verifyDim failure on match branch propagates as fatal', async () => {
  const stubMemory = {};
  const calls = [];
  const currentStamp = { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 };
  const stamp = {
    read: async () => currentStamp,
    verifyDim: async () => { throw new Error('observed dim 768, stamped 1536'); },
  };
  const log = {
    fatal: (obj, msg) => calls.push(['fatal', msg]),
    info: () => {},
    warn: () => {},
  };
  await assert.rejects(
    () => initMemoryWithGuard({
      memory: stubMemory,
      stamp,
      log,
      env: { UM_EMBEDDING_PROVIDER: 'openai', UM_EMBEDDING_MODEL: 'text-embedding-3-small' },
      exit: () => { throw new Error('process.exit'); },
    }),
    /dim/,
  );
});

// Live smoke test — confirms the no-arg `initMemory()` wrapper still constructs and
// returns a Memory instance for production callers. Skipped without UM_LIVE_TESTS
// (requires Qdrant + provider keys).
test('initMemory() with default deps still constructs and returns Memory instance', { skip: !process.env.UM_LIVE_TESTS }, async () => {
  const mem = await initMemory();
  assert.ok(mem);
});
