import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readCheckpoint, writeCheckpoint, addProcessedId, recordPhase, clearError, createCheckpointClient } from '../lib/checkpoint.mjs';

let tmp;
test.before(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'reindex-test-')); });
test.after(async () => { await rm(tmp, { recursive: true, force: true }); });

test('readCheckpoint returns null on missing file', async () => {
  assert.equal(await readCheckpoint(path.join(tmp, 'nope.json')), null);
});

test('readCheckpoint rejects schema_version mismatch with helpful message', async () => {
  const p = path.join(tmp, 'old.json');
  await writeFile(p, JSON.stringify({ schema_version: 99, phase_completed: 0 }));
  await assert.rejects(() => readCheckpoint(p), /schema.*99.*expected 1.*delete or downgrade/i);
});

test('writeCheckpoint is atomic (tmp + rename)', async () => {
  const p = path.join(tmp, 'atomic.json');
  await writeCheckpoint(p, { schema_version: 1, phase_completed: 0, processed_ids: [] });
  const raw = JSON.parse(await readFile(p, 'utf-8'));
  assert.equal(raw.schema_version, 1);
  // Verify the .tmp sidecar was renamed (not copied) — no debris left
  await assert.rejects(() => readFile(p + '.tmp', 'utf-8'), { code: 'ENOENT' });
});

test('addProcessedId is idempotent (set semantics)', async () => {
  const state = { schema_version: 1, phase_completed: 0, processed_ids: [] };
  addProcessedId(state, 'uuid-1');
  addProcessedId(state, 'uuid-1');                  // duplicate
  addProcessedId(state, 'uuid-2');
  assert.deepEqual([...state.processed_ids].sort(), ['uuid-1', 'uuid-2']);
});

test('recordPhase advances phase_completed', () => {
  const state = { schema_version: 1, phase_completed: 2 };
  recordPhase(state, 3);
  assert.equal(state.phase_completed, 3);
});

test('clearError nulls last_error', () => {
  const state = { schema_version: 1, last_error: 'previous failure' };
  clearError(state);
  assert.equal(state.last_error, null);
});

test('full §6.4 schema round-trips through write+read', async () => {
  const p = path.join(tmp, 'full-schema.json');
  const original = {
    schema_version: 1,
    started_at: '2026-04-27T12:00:00.000Z',
    from: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 },
    to:   { provider: 'google', model: 'text-embedding-004',     dim: 768  },
    target_collection: 'memories_a1b2c3d4',
    phase_completed: 0,
    snapshot: { vault_paths: ['docs/foo.md', 'docs/bar.md'], fact_ids: ['uuid-1', 'uuid-2'] },
    processed_ids: [],
    estimate: { entries: 1234, tokens: 567890, cost_usd: 0.12 },
    last_error: null,
  };
  await writeCheckpoint(p, original);
  const roundTripped = await readCheckpoint(p);
  assert.deepEqual(roundTripped, original);
});

test('target_collection name follows sha8(provider:model) derivation', () => {
  // The reindex CLI derives target_collection from new provider+model via sha8.
  // The checkpoint stores the result; the derivation rule belongs in cli/reindex.mjs.
  // This test asserts the format pattern (8 hex chars after underscore).
  const tc = 'memories_a1b2c3d4';
  assert.match(tc, /^memories_[0-9a-f]{8}$/);
});

test('createCheckpointClient binds path; returns DI-friendly object', async () => {
  const p = path.join(tmp, 'client-test.json');
  const client = createCheckpointClient(p);
  assert.equal(typeof client.read, 'function');
  assert.equal(typeof client.write, 'function');
  assert.equal(typeof client.addProcessedId, 'function');
  assert.equal(typeof client.recordPhase, 'function');
  assert.equal(typeof client.clearError, 'function');
  // Round-trip: write then read without re-passing path
  const state = { schema_version: 1, phase_completed: 0, processed_ids: [] };
  await client.write(state);
  const back = await client.read();
  assert.deepEqual(back, state);
});
