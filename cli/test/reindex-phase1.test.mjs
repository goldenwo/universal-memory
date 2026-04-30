import test from 'node:test';
import assert from 'node:assert/strict';
import { runPhase1Validate } from '../reindex.mjs';

const baseDeps = {
  env: { UM_EMBEDDING_PROVIDER: 'google', UM_EMBEDDING_MODEL: 'text-embedding-004' },
  pricing: { priceFor: () => ({ in: 0.00001, out: 0, type: 'embed' }) },
  fetch: async () => { throw new Error('ECONNREFUSED'); },
  prompt: async () => 'y',
};

test('mismatch detected → proceed=true', async () => {
  const stamp = { read: async () => ({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }) };
  const ck = { write: async () => {} };
  const r = await runPhase1Validate({ ...baseDeps, stamp, checkpoint: ck, noServerProbe: true, confirmInteractive: true });
  assert.equal(r.proceed, true);
});

test('match (no real mismatch) → refuses with no-op error', async () => {
  const stamp = { read: async () => ({ provider: 'google', model: 'text-embedding-004', dim: 768 }) };
  const ck = { write: async () => {} };
  await assert.rejects(
    () => runPhase1Validate({ ...baseDeps, stamp, checkpoint: ck, noServerProbe: true, confirmInteractive: true }),
    /no-op|stamp matches/i,
  );
});

test('server responsive → refuses with stop-server guidance', async () => {
  const stamp = { read: async () => ({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }) };
  const respondingFetch = async () => ({ ok: true, json: async () => ({}) });
  const ck = { write: async () => {} };
  await assert.rejects(
    () => runPhase1Validate({ ...baseDeps, stamp, fetch: respondingFetch, checkpoint: ck, confirmInteractive: true }),
    /server is responsive.*stop it before reindex/i,
  );
});

test('server unreachable + no --no-server-probe → refuses with explicit choices', async () => {
  const stamp = { read: async () => ({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }) };
  const ck = { write: async () => {} };
  await assert.rejects(
    () => runPhase1Validate({ ...baseDeps, stamp, checkpoint: ck, noServerProbe: false, confirmInteractive: true }),
    /could not probe.*--server-url.*--no-server-probe/i,
  );
});

test('server unreachable + --no-server-probe → continues', async () => {
  const stamp = { read: async () => ({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }) };
  const ck = { write: async () => {} };
  const r = await runPhase1Validate({ ...baseDeps, stamp, checkpoint: ck, noServerProbe: true, confirmInteractive: true });
  assert.equal(r.proceed, true);
});

test('estimate includes per-entry cost from pricing', async () => {
  const stamp = { read: async () => ({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }) };
  const ck = { write: async () => {} };
  const r = await runPhase1Validate({ ...baseDeps, stamp, checkpoint: ck, noServerProbe: true, confirmInteractive: true });
  assert.ok(r.estimate.cost_usd >= 0);
  assert.ok(typeof r.estimate.entries === 'number');
});

test('phase-1 success writes checkpoint with phase_completed=1 atomically', async () => {
  const stamp = { read: async () => ({ provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }) };
  const writes = [];
  const ck = { write: async (state) => writes.push({ phase: state.phase_completed, hasEstimate: !!state.estimate }) };
  await runPhase1Validate({ ...baseDeps, stamp, checkpoint: ck, noServerProbe: true, confirmInteractive: true });
  // The LAST write must have BOTH the estimate AND phase_completed=1 (atomic-advance contract).
  const last = writes[writes.length - 1];
  assert.equal(last.phase, 1);
  assert.equal(last.hasEstimate, true);
});
