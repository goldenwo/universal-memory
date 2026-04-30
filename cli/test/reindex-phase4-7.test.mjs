import test from 'node:test';
import assert from 'node:assert/strict';
import { runPhase4Stamp, runPhase5Swap, runPhase7Report } from '../reindex.mjs';

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

// ---------------------------------------------------------------------------
// Phase 7 archive contract — DE11 fix-pass (I1 + I2)
//
// I1: Windows-safe rename (EEXIST/EPERM → unlink + retry). I2: archive is
// best-effort; failure must NOT throw (phase_completed=7 already durable).
// ---------------------------------------------------------------------------

test('runPhase7Report archives state file via rename to .archive.json', async () => {
  const writes = [];
  const renames = [];
  const stdout = { write: (s) => { writes.push(s); } };
  const fakeFs = {
    rename: async (from, to) => { renames.push([from, to]); },
    unlink: async () => {},
  };
  const state = {
    schema_version: 1,
    phase_completed: 6,
    from: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 },
    to: { provider: 'google', model: 'text-embedding-004', dim: 768 },
    estimate: { entries: 100, tokens: 20000, cost_usd: 0.20 },
    verify: { matches: true, expected: 100, actual: 100 },
    target_collection: 'memories_a1b2c3d4',
  };
  const written = [];
  const result = await runPhase7Report({
    state,
    checkpoint: { write: async (s) => { written.push(s.phase_completed); } },
    statePath: '/tmp/state.json',
    io: { stdout },
    fs: fakeFs,
  });
  assert.deepEqual(renames, [['/tmp/state.json', '/tmp/state.json.archive.json']]);
  assert.equal(result.archivedTo, '/tmp/state.json.archive.json');
  // Atomic advance happened BEFORE archive (phase_completed=7 written)
  assert.deepEqual(written, [7]);
  // Restart instruction printed
  assert.ok(writes.some((s) => /restart the server/i.test(s)),
    `expected restart instruction in writes, got: ${JSON.stringify(writes)}`);
});

test('runPhase7Report continues if archive rename fails (best-effort warn)', async () => {
  const writes = [];
  const fakeFs = {
    // Always fail — never EEXIST so unlink fallback is not taken; assert the
    // top-level catch warns and does not throw.
    rename: async () => { throw new Error('persistent rename failure'); },
    unlink: async () => {},
  };
  const state = {
    schema_version: 1,
    phase_completed: 6,
    from: { provider: 'google', model: 'text-embedding-004', dim: 768 },
    to: { provider: 'google', model: 'text-embedding-004', dim: 768 },
    estimate: { entries: 0, tokens: 0, cost_usd: 0 },
  };
  const written = [];
  // Should NOT throw — archive failure is best-effort
  const result = await runPhase7Report({
    state,
    checkpoint: { write: async (s) => { written.push(s.phase_completed); } },
    statePath: '/tmp/state.json',
    io: { stdout: { write: (s) => writes.push(s) } },
    fs: fakeFs,
  });
  // Atomic advance still happened
  assert.deepEqual(written, [7]);
  // archivedTo is null because rename never succeeded
  assert.equal(result.archivedTo, null);
  // Warning printed about manual cleanup
  assert.ok(writes.some((s) => /archive rename failed.*manual cleanup/i.test(s)),
    `expected archive-failure warning, got: ${JSON.stringify(writes)}`);
});

test('runPhase7Report Windows EEXIST → unlink + retry recovers', async () => {
  const writes = [];
  const renameCalls = [];
  let unlinked = false;
  const fakeFs = {
    rename: async (from, to) => {
      renameCalls.push([from, to]);
      // First call throws EEXIST (Windows rename-over-existing); second succeeds.
      if (renameCalls.length === 1) {
        const err = new Error('EEXIST: file already exists');
        err.code = 'EEXIST';
        throw err;
      }
      // Second call: succeed (no throw).
    },
    unlink: async () => { unlinked = true; },
  };
  const state = { schema_version: 1, phase_completed: 6 };
  const result = await runPhase7Report({
    state,
    checkpoint: { write: async () => {} },
    statePath: '/tmp/state.json',
    io: { stdout: { write: (s) => writes.push(s) } },
    fs: fakeFs,
  });
  assert.equal(unlinked, true, 'unlink fallback was invoked on EEXIST');
  assert.equal(renameCalls.length, 2, 'rename retried after unlink');
  assert.equal(result.archivedTo, '/tmp/state.json.archive.json',
    'archivedTo set after successful retry');
  // No warning because retry succeeded
  assert.ok(!writes.some((s) => /archive rename failed/i.test(s)),
    `did not expect failure warning when retry succeeds, got: ${JSON.stringify(writes)}`);
});
