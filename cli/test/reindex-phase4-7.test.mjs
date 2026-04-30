import test from 'node:test';
import assert from 'node:assert/strict';
import { runPhase4Stamp, runPhase5Swap } from '../reindex.mjs';

// Phase function signatures (export from cli/reindex.mjs):
//   runPhase4Stamp({ memory, stamp, targetCollection, newStampShape }) → void
//   runPhase5Swap({ qdrant, alias, targetCollection, stamp }) → void
//   runPhase6Verify({ memory, qdrant, alias, expectedCount }) → { matches: boolean, ... }
// Note: runPhase5Swap requires `stamp` for the resume-defensive read.

test('reindex calls writeStamp BEFORE alias swap', async () => {
  const calls = [];
  const stamp = {
    write: async () => calls.push('stamp'),
    read: async () => ({ provider: 'google', model: 'text-embedding-004', dim: 768 }),
  };
  const qdrant = { updateAlias: async () => calls.push('swap') };
  await runPhase4Stamp({ memory: {}, stamp, targetCollection: 'memories_a1b2c3d4', newStampShape: { provider: 'google', model: 'text-embedding-004', dim: 768 } });
  await runPhase5Swap({ qdrant, alias: 'memories', targetCollection: 'memories_a1b2c3d4', stamp });
  assert.deepEqual(calls, ['stamp', 'swap']);
});

test('runPhase4Stamp writes new stamp into target collection (not into alias)', async () => {
  let writtenTo;
  const stamp = { write: async ({ collection }) => { writtenTo = collection; } };
  await runPhase4Stamp({ memory: {}, stamp, targetCollection: 'memories_a1b2c3d4', newStampShape: { provider: 'google', model: 'text-embedding-004', dim: 768 } });
  assert.equal(writtenTo, 'memories_a1b2c3d4');
});

test('runPhase5Swap refuses if target collection has no stamp (resume defensive read)', async () => {
  const stamp = { read: async () => null };
  const qdrant = { updateAlias: async () => { throw new Error('should not reach swap'); } };
  await assert.rejects(
    () => runPhase5Swap({ qdrant, alias: 'memories', targetCollection: 'memories_a1b2c3d4', stamp }),
    /no stamp.*rerun --resume from phase 4/i,
  );
});

test('runPhase5Swap proceeds when stamp exists', async () => {
  const stamp = { read: async () => ({ provider: 'google', model: 'text-embedding-004', dim: 768 }) };
  let aliasUpdated = false;
  const qdrant = { updateAlias: async () => { aliasUpdated = true; } };
  await runPhase5Swap({ qdrant, alias: 'memories', targetCollection: 'memories_a1b2c3d4', stamp });
  assert.equal(aliasUpdated, true);
});
