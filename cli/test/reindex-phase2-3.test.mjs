import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runPhase2Snapshot, runPhase3Rebuild } from '../reindex.mjs';
import { ProviderError } from '../../server/lib/provider/errors.mjs';

test('Phase 3 rebuilds entries; writes checkpoint after each', async () => {
  const writes = [];
  const newMemory = { add: async (text, opts) => writes.push(opts.metadata.id) };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md', 'b.md'], fact_ids: ['f1'] }, processed_ids: [] };
  const checkpoint = { write: async () => {} };
  await runPhase3Rebuild({ newMemory, state, checkpoint, vault: { read: async (p) => ({ frontmatter: { id: p }, body: 'text' }) } });
  assert.deepEqual(writes.sort(), ['a.md', 'b.md', 'f1']);
  assert.equal(state.phase_completed, 3);
});

test('Phase 3 retries on PROVIDER_RATELIMIT (429-then-success)', async () => {
  let attempts = 0;
  const newMemory = {
    add: async () => {
      attempts++;
      if (attempts < 2) throw new ProviderError({ class: 'PROVIDER_RATELIMIT', provider: 'openai', status: 429, message: '429', retryable: true });
      // success on second attempt
    },
  };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async () => {} };
  await runPhase3Rebuild({ newMemory, state, checkpoint, vault: { read: async () => ({ frontmatter: { id: 'a.md' }, body: 't' }) }, maxRetries: 3 });
  assert.equal(attempts, 2, 'retried once after 429');
  assert.deepEqual(state.processed_ids, ['a.md']);
});

test('Phase 3 surfaces RATELIMIT after exhausting retries with resume hint', async () => {
  const newMemory = {
    add: async () => { throw new ProviderError({ class: 'PROVIDER_RATELIMIT', provider: 'openai', status: 429, message: '429 always', retryable: true }); },
  };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async () => {} };
  await assert.rejects(
    () => runPhase3Rebuild({ newMemory, state, checkpoint, vault: { read: async () => ({ frontmatter: { id: 'a.md' }, body: 't' }) }, maxRetries: 2 }),
    (err) => err.class === 'PROVIDER_RATELIMIT' && /--resume/.test(err.message),
  );
});

test('Phase 3 final-entry recordPhase + processed_id batched in one writeCheckpoint call', async () => {
  const writeCalls = [];
  const newMemory = { add: async () => {} };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async (s) => writeCalls.push({ phase: s.phase_completed, processed: [...s.processed_ids] }) };
  await runPhase3Rebuild({ newMemory, state, checkpoint, vault: { read: async () => ({ frontmatter: { id: 'a.md' }, body: 't' }) } });
  // The LAST write must have BOTH the final processed_id AND phase_completed=3.
  const last = writeCalls[writeCalls.length - 1];
  assert.equal(last.phase, 3);
  assert.deepEqual(last.processed, ['a.md']);
});

// I2 (durability): non-RATELIMIT errors must propagate, but progress made
// BEFORE the failed entry must be persisted so a `--resume` after the operator
// addresses the upstream/network issue picks up from the last completed entry.
test('Phase 3 persists progress before propagating non-RATELIMIT errors', async () => {
  const writes = [];
  let attempts = 0;
  const newMemory = {
    add: async () => {
      attempts++;
      if (attempts === 1) return; // first entry succeeds
      // Second entry fails with a non-rate-limit (PROVIDER_UPSTREAM) error.
      throw new ProviderError({ class: 'PROVIDER_UPSTREAM', provider: 'openai', status: 502, message: '502 bad gateway', retryable: true });
    },
  };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md', 'b.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async (s) => writes.push({ phase: s.phase_completed, processed: [...s.processed_ids] }) };
  await assert.rejects(
    () => runPhase3Rebuild({ newMemory, state, checkpoint, vault: { read: async (p) => ({ frontmatter: { id: p }, body: 't' }) } }),
    (err) => err instanceof ProviderError && err.class === 'PROVIDER_UPSTREAM',
  );
  // The LAST write must show 'a.md' processed (durability) but phase_completed != 3 (didn't finish).
  assert.ok(writes.length >= 1, 'a checkpoint write must have happened before the throw');
  const last = writes[writes.length - 1];
  assert.deepEqual(last.processed, ['a.md'], 'pre-error progress must be persisted');
  assert.notEqual(last.phase, 3, 'phase must not be marked complete on error');
});

// M4 (atomic-advance contract for phase 2): snapshot AND phase_completed=2
// MUST land in a single `checkpoint.write(state)` call. Any "write snapshot,
// then bump phase, then write again" pattern would open a crash window where
// resume sees inconsistent state.
test('Phase 2 snapshot + phase_completed=2 land in single atomic write', async () => {
  const writes = [];
  const state = { schema_version: 1, processed_ids: [] };
  const checkpoint = { write: async (s) => writes.push({ phase: s.phase_completed, snapshot: s.snapshot ? { ...s.snapshot } : undefined }) };
  // Empty temp dir → vault walk returns []. listFactIds stub returns two IDs.
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'reindex-phase2-'));
  try {
    await runPhase2Snapshot({
      vault: { dir: tmp },
      oldMemory: { listFactIds: async () => ['fact-1', 'fact-2'] },
      state,
      checkpoint,
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  // Single atomic write — both fields set in the SAME call.
  assert.equal(writes.length, 1, 'phase 2 must call checkpoint.write exactly once (atomic advance)');
  assert.equal(writes[0].phase, 2);
  assert.deepEqual(writes[0].snapshot, { vault_paths: [], fact_ids: ['fact-1', 'fact-2'] });
});
