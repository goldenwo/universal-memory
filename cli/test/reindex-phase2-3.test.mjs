import test from 'node:test';
import assert from 'node:assert/strict';
import { runPhase3Rebuild } from '../reindex.mjs';
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
