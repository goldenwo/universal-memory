import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runPhase2Snapshot, runPhase3Rebuild, installSigintHandler } from '../reindex.mjs';
import { parseFrontmatter } from '../../server/lib/frontmatter.mjs';
import { indexRecord } from '../../server/lib/index-record.mjs';
import { ProviderError } from '../../server/lib/provider/errors.mjs';
import { tempDir } from '../../server/test/helpers/tmpdir.mjs';

// T21: rebuildOne now calls umAdd instead of newMemory.add, so newMemory must
// carry config.vectorStore.config.collectionName. Inject _qdrantClient and
// _embedProviderOverride via runPhase3Rebuild to avoid real Qdrant/embed calls.
function makeMemory() {
  return {
    config: { vectorStore: { config: { collectionName: 'test', host: 'localhost', port: 6333 } } },
  };
}

// A vault doc as parseFrontmatter returns it, with the type/id/title every indexed doc carries
// (#362: phase 3 refuses anything else, as reindexDoc does). id = the filename stem.
const vaultDoc = (relPath, extra = {}) => ({
  frontmatter: { type: 'note', id: path.posix.basename(relPath, '.md'), title: `Doc ${relPath}`, ...extra },
  body: 't',
});

// Default no-op embed seam (infer:false paths only need embed, not facts).
function makeEmbed() {
  return {
    embed: async () => ({ vector: [0, 0, 0], usage: { tokensIn: 0, tokensOut: 0 } }),
    supports: { embeddings: true },
  };
}

test('Phase 3 rebuilds entries; writes checkpoint after each', async () => {
  const writes = [];
  const newMemory = makeMemory();
  // Capture the metadata.id from each upsert point payload.
  const _qdrantClient = { upsert: async (_col, { points }) => { writes.push(points[0].payload.id); } };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md', 'b.md'], fact_ids: ['f1'] }, processed_ids: [] };
  const checkpoint = { write: async () => {} };
  await runPhase3Rebuild({
    newMemory, state, checkpoint,
    vault: { read: async (p) => (p.endsWith('.md') ? vaultDoc(p) : { frontmatter: { id: p }, body: 'text' }) },
    _qdrantClient,
    _embedProviderOverride: makeEmbed(),
  });
  assert.deepEqual(writes.sort(), ['a', 'b', 'f1'], 'a vault doc is stored under its frontmatter id');
  assert.equal(state.phase_completed, 3);
});

// Issue #37 audit follow-up: the conditional read at rebuildOne (`frontmatter.userId
// ?? RESOLVED_USER_ID`) is forward-compat for callers that supply explicit camel
// `userId` in frontmatter. The canonical schema does not define userId, so
// production today always takes the fallback. This test keeps the conditional
// branch alive: if frontmatter carries an explicit userId, it MUST win over
// RESOLVED_USER_ID and reach the qdrant payload unchanged.
test('Phase 3: explicit frontmatter.userId overrides RESOLVED_USER_ID fallback', async () => {
  const captured = [];
  const newMemory = makeMemory();
  const _qdrantClient = { upsert: async (_col, { points }) => { captured.push(points[0].payload.userId); } };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async () => {} };
  await runPhase3Rebuild({
    newMemory, state, checkpoint,
    vault: { read: async (p) => vaultDoc(p, { userId: 'fm-explicit-user' }) },
    _qdrantClient,
    _embedProviderOverride: makeEmbed(),
  });
  assert.deepEqual(captured, ['fm-explicit-user'], 'explicit camel userId from frontmatter must reach qdrant payload');
});

test('Phase 3 retries on PROVIDER_RATELIMIT (429-then-success)', async () => {
  let attempts = 0;
  const newMemory = makeMemory();
  // Throw PROVIDER_RATELIMIT on first embed call, succeed on second.
  const _embedProviderOverride = {
    embed: async () => {
      attempts++;
      if (attempts < 2) throw new ProviderError({ class: 'PROVIDER_RATELIMIT', provider: 'openai', status: 429, message: '429', retryable: true });
      // success on second attempt
      return { vector: [0, 0, 0], usage: { tokensIn: 0, tokensOut: 0 } };
    },
    supports: { embeddings: true },
  };
  const _qdrantClient = { upsert: async () => {} };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async () => {} };
  await runPhase3Rebuild({
    newMemory, state, checkpoint,
    vault: { read: async (p) => vaultDoc(p) },
    maxRetries: 3,
    _qdrantClient,
    _embedProviderOverride,
  });
  assert.equal(attempts, 2, 'retried once after 429');
  assert.deepEqual(state.processed_ids, ['a.md']);
});

test('Phase 3 surfaces RATELIMIT after exhausting retries with resume hint', async () => {
  const newMemory = makeMemory();
  const _embedProviderOverride = {
    embed: async () => { throw new ProviderError({ class: 'PROVIDER_RATELIMIT', provider: 'openai', status: 429, message: '429 always', retryable: true }); },
    supports: { embeddings: true },
  };
  const _qdrantClient = { upsert: async () => {} };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async () => {} };
  await assert.rejects(
    () => runPhase3Rebuild({
      newMemory, state, checkpoint,
      vault: { read: async (p) => vaultDoc(p) },
      maxRetries: 2,
      _qdrantClient,
      _embedProviderOverride,
    }),
    (err) => err.class === 'PROVIDER_RATELIMIT' && /--resume/.test(err.message),
  );
});

test('Phase 3 final-entry recordPhase + processed_id batched in one writeCheckpoint call', async () => {
  const writeCalls = [];
  const newMemory = makeMemory();
  const _qdrantClient = { upsert: async () => {} };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async (s) => writeCalls.push({ phase: s.phase_completed, processed: [...s.processed_ids] }) };
  await runPhase3Rebuild({
    newMemory, state, checkpoint,
    vault: { read: async (p) => vaultDoc(p) },
    _qdrantClient,
    _embedProviderOverride: makeEmbed(),
  });
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
  const newMemory = makeMemory();
  // First embed call succeeds; second throws PROVIDER_UPSTREAM.
  const _embedProviderOverride = {
    embed: async () => {
      attempts++;
      if (attempts === 1) return { vector: [0, 0, 0], usage: { tokensIn: 0, tokensOut: 0 } };
      // Second entry fails with a non-rate-limit (PROVIDER_UPSTREAM) error.
      throw new ProviderError({ class: 'PROVIDER_UPSTREAM', provider: 'openai', status: 502, message: '502 bad gateway', retryable: true });
    },
    supports: { embeddings: true },
  };
  const _qdrantClient = { upsert: async () => {} };
  const state = { schema_version: 1, snapshot: { vault_paths: ['a.md', 'b.md'], fact_ids: [] }, processed_ids: [] };
  const checkpoint = { write: async (s) => writes.push({ phase: s.phase_completed, processed: [...s.processed_ids] }) };
  await assert.rejects(
    () => runPhase3Rebuild({
      newMemory, state, checkpoint,
      vault: { read: async (p) => vaultDoc(p) },
      _qdrantClient,
      _embedProviderOverride,
    }),
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
  const tmp = tempDir('reindex-phase2-');
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

// SIGINT (graceful cancel) — Phase 3 must check abortSignal between entries,
// persist progress made so far, and return cancelled=true without bumping
// phase_completed. Resume then picks up from the last completed entry.
test('Phase 3 honours abortSignal between entries: persists progress, returns cancelled, leaves phase_completed unset', async () => {
  const writes = [];
  const controller = new AbortController();
  let processedCount = 0;
  const newMemory = makeMemory();
  // After the first embed call succeeds, abort. The next loop iteration must
  // detect the signal BEFORE invoking umAdd for b.md.
  const _embedProviderOverride = {
    embed: async () => {
      processedCount++;
      if (processedCount === 1) controller.abort();
      return { vector: [0, 0, 0], usage: { tokensIn: 0, tokensOut: 0 } };
    },
    supports: { embeddings: true },
  };
  const _qdrantClient = { upsert: async () => {} };
  const state = {
    schema_version: 1,
    snapshot: { vault_paths: ['a.md', 'b.md', 'c.md'], fact_ids: [] },
    processed_ids: [],
  };
  const checkpoint = { write: async (s) => writes.push({ phase: s.phase_completed, processed: [...s.processed_ids] }) };
  const result = await runPhase3Rebuild({
    newMemory,
    state,
    checkpoint,
    vault: { read: async (p) => vaultDoc(p) },
    abortSignal: controller.signal,
    _qdrantClient,
    _embedProviderOverride,
  });
  // Only a.md was processed (b.md/c.md aborted before umAdd invoked).
  assert.equal(processedCount, 1, 'embed called exactly once before abort caught');
  assert.equal(result.cancelled, true, 'result.cancelled must be true on abort');
  assert.equal(result.processed, 1, 'result.processed reflects the single completed entry');
  // phase_completed must NOT advance to 3 — the phase did not finish.
  assert.notEqual(state.phase_completed, 3);
  // Durability: a.md is in processed_ids and at least one checkpoint was written
  // so --resume picks up from b.md.
  assert.deepEqual(state.processed_ids, ['a.md']);
  assert.ok(writes.length >= 1, 'at least one checkpoint write before bailing on abort');
  const last = writes[writes.length - 1];
  assert.notEqual(last.phase, 3, 'last checkpoint must not mark phase 3 complete');
  assert.deepEqual(last.processed, ['a.md']);
});

// SIGINT (pre-loop) — abortSignal already aborted before the loop body runs
// must short-circuit cleanly (no umAdd calls, write checkpoint, return
// cancelled=true).
test('Phase 3 honours pre-aborted signal: zero entries processed, cancelled=true', async () => {
  const controller = new AbortController();
  controller.abort();
  let embedCalls = 0;
  const newMemory = makeMemory();
  const _embedProviderOverride = {
    embed: async () => { embedCalls++; return { vector: [0, 0, 0], usage: { tokensIn: 0, tokensOut: 0 } }; },
    supports: { embeddings: true },
  };
  const _qdrantClient = { upsert: async () => {} };
  const state = {
    schema_version: 1,
    snapshot: { vault_paths: ['a.md', 'b.md'], fact_ids: [] },
    processed_ids: [],
  };
  const checkpoint = { write: async () => {} };
  const result = await runPhase3Rebuild({
    newMemory,
    state,
    checkpoint,
    vault: { read: async (p) => vaultDoc(p) },
    abortSignal: controller.signal,
    _qdrantClient,
    _embedProviderOverride,
  });
  assert.equal(embedCalls, 0, 'no umAdd calls when pre-aborted');
  assert.equal(result.cancelled, true);
  assert.equal(result.processed, 0);
  assert.notEqual(state.phase_completed, 3);
});

// installSigintHandler — first SIGINT calls controller.abort and logs a
// graceful-cancellation message. Disposer removes the listener so test
// processes don't leak handlers across tests.
test('installSigintHandler: first SIGINT aborts controller, logs message, disposer removes listener', () => {
  const out = { buf: '', write(s) { this.buf += s; } };
  const controller = new AbortController();
  const dispose = installSigintHandler({ controller, out, exitOnSecond: false });
  try {
    process.emit('SIGINT');
    assert.equal(controller.signal.aborted, true, 'first SIGINT aborts the controller');
    assert.match(out.buf, /cancellation requested/i, 'graceful-cancel message logged to out');
    // Second emit must not re-abort or re-log (already aborted; idempotent).
    const bufAfterFirst = out.buf;
    process.emit('SIGINT');
    assert.equal(out.buf, bufAfterFirst, 'second SIGINT is idempotent when exitOnSecond=false');
  } finally {
    dispose();
  }
  // After dispose, emitting SIGINT must NOT re-trigger our handler. node's
  // default SIGINT behavior would terminate the process — install a no-op
  // listener for the duration of this assertion to swallow it.
  const bufAfterDispose = out.buf;
  const swallow = () => {};
  process.on('SIGINT', swallow);
  try {
    process.emit('SIGINT');
    assert.equal(out.buf, bufAfterDispose, 'disposer must remove the listener — no further writes to out');
  } finally {
    process.off('SIGINT', swallow);
  }
});

// ---------- #362: the CLI admits and rebuilds vault docs by the server's own rule ----------

// The issue's probe: a raw capture (no frontmatter), state.md, an untitled note and one real doc.
const PROBE = {
  'captures/p/raw/2026-10-09.md': '## 2026-10-09T00:00:00.000Z user\n\nhello\n\n',
  'state/p/state.md': '---\ntype: state\nid: state-p\ntitle: State of play\n---\n\n# State\n',
  'notes/untitled.md': '---\ntype: note\nid: untitled\n---\n\nno title\n',
  'sessions/p/s1.md': '---\ntype: session_summary\nid: s1\ntitle: Session one\n---\n\nWhat happened.\n',
};

async function writeProbeVault() {
  const dir = tempDir('reindex-362-');
  for (const [rel, text] of Object.entries(PROBE)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

test('#362 Phase 2 snapshots only what reindexDoc would index; a raw capture, state.md and an untitled note are skipped and counted', async () => {
  const dir = await writeProbeVault();
  const lines = [];
  const factArgs = [];
  const state = { schema_version: 1, processed_ids: [] };
  try {
    const r = await runPhase2Snapshot({
      vault: { dir },
      oldMemory: { listFactIds: async (arg) => { factArgs.push(arg); return []; } },
      state,
      checkpoint: { write: async () => {} },
      out: { write: (s) => lines.push(s) },
    });
    assert.deepEqual(state.snapshot, { vault_paths: ['sessions/p/s1.md'], fact_ids: [] });
    assert.deepEqual(factArgs, [{ vaultIds: ['s1'] }], 'the admitted docs\' frontmatter ids decide which points are vault-backed');
    assert.deepEqual(r.skipped, { missing_fields: 2, state: 1 });
    assert.match(lines.join(''), /phase 2: 1 vault doc\(s\) to rebuild; skipped 3 not indexed by the server \(missing_fields 2, state 1\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('#362 Phase 3 rebuilds a vault doc exactly as reindexDoc writes it: the shared record\'s text and metadata', async () => {
  const payloads = [];
  const _qdrantClient = { upsert: async (_col, { points }) => { payloads.push(points[0].payload); } };
  const parsed = parseFrontmatter(PROBE['sessions/p/s1.md']);
  const state = { schema_version: 1, snapshot: { vault_paths: ['sessions/p/s1.md'], fact_ids: [] }, processed_ids: [] };
  await runPhase3Rebuild({
    newMemory: makeMemory(), state, checkpoint: { write: async () => {} },
    vault: { read: async () => parsed },
    _qdrantClient,
    _embedProviderOverride: makeEmbed(),
  });
  const rec = indexRecord(parsed);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].data, rec.text, 'title + body, not the bare body');
  for (const [k, v] of Object.entries(rec.metadata)) assert.equal(payloads[0][k], v, `metadata.${k}`);
});

test('#362 Phase 3 skips a snapshot path the rule refuses (a pre-#362 checkpoint resumed), counts it and completes', async () => {
  const payloads = [];
  const lines = [];
  const _qdrantClient = { upsert: async (_col, { points }) => { payloads.push(points[0].payload.id); } };
  const state = {
    schema_version: 1,
    snapshot: { vault_paths: ['captures/p/raw/2026-10-09.md', 'sessions/p/s1.md'], fact_ids: [] },
    processed_ids: [],
  };
  const r = await runPhase3Rebuild({
    newMemory: makeMemory(), state, checkpoint: { write: async () => {} },
    vault: { read: async (p) => parseFrontmatter(PROBE[p]) },
    _qdrantClient,
    _embedProviderOverride: makeEmbed(),
    out: { write: (s) => lines.push(s) },
  });
  assert.deepEqual(payloads, ['s1'], 'only the real doc is written');
  assert.equal(r.skipped, 1);
  assert.deepEqual(state.processed_ids, ['captures/p/raw/2026-10-09.md', 'sessions/p/s1.md'], 'the skipped path is not retried on resume');
  assert.equal(state.phase_completed, 3);
  assert.match(lines.join(''), /skipped captures\/p\/raw\/2026-10-09\.md: missing_fields/);
});
