// server/test/checkpoint-chunk-txn.test.mjs — Task 5: server/lib/checkpoint-chunk-txn.mjs
//
// Pins spec §4.5's per-chunk transaction, in particular I5 (cursor advance
// strictly after the summary's durable rename, strictly before reindex): a
// crash/failure between rename and cursor-advance must re-digest the chunk
// next run (duplicate, never loss); a crash/failure after cursor-advance
// must leave a durable-but-unindexed doc. All DI-mocked — no real LLM calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { tempDir } from './helpers/tmpdir.mjs';
import { runChunkTransaction } from '../lib/checkpoint-chunk-txn.mjs';
import { _setLogStreamForTest } from '../lib/logger.mjs';
import { ProviderError } from '../lib/provider/errors.mjs';
import { CAPTURE_EVENTS } from '../lib/capture-events.mjs';

const PROJECT = 'chunk-txn-test-proj';

// ---- log capture (pattern from checkpoint.test.mjs) ------------------------
function _attachLogCapture() {
  const captured = [];
  _setLogStreamForTest(new Writable({
    write(chunk, enc, cb) {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        try { captured.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
      cb();
    },
  }));
  return captured;
}
function _detachLogCapture() {
  _setLogStreamForTest(null);
}

// ---- fixture helpers ---------------------------------------------------------

function makeVault() {
  return tempDir('um-chunk-txn-test-');
}

function cursorPath(vault, project = PROJECT) {
  return path.join(vault, 'state', project, 'checkpoint-cursor.json');
}

function summaryPathFor(vault, id, project = PROJECT) {
  return path.join(vault, 'sessions', project, `${id}.md`);
}

/** Mirrors checkpoint-chunk-txn.mjs's deterministicSummaryId — used by tests to predict paths. */
function computeId(project, chunk) {
  const hash = createHash('sha256')
    .update(`${project}|${chunk.startFile}|${chunk.startOffset}|${chunk.endFile}|${chunk.endOffset}`)
    .digest('hex')
    .slice(0, 8);
  return `session-${chunk.coversFrom.slice(0, 10)}-${hash}`;
}

function baseConfig(overrides = {}) {
  return {
    schema_version: 1,
    cost_cap_usd_per_day_per_project: 0.50,
    summary_model: 'gpt-4o-mini',
    // #185 gate OFF by default — these tests exercise transaction mechanics,
    // not admission semantics (mirrors checkpoint.test.mjs's BASE_CONFIG).
    min_transcript_bytes: 0,
    min_transcript_turns: 0,
    ...overrides,
  };
}

function baseChunkingCfg(overrides = {}) {
  return {
    chunkMaxBytes: 200_000,
    maxChunksPerRun: 3,
    summarizeTimeoutMs: 5_000,
    autosupersedeTimeoutMs: 5_000,
    stateMergeTimeoutMs: 5_000,
    ...overrides,
  };
}

/** A chunk-builder.mjs-shaped chunk. Default window: 2026-08-10.md[0:500), 2 turns. */
function makeChunk(overrides = {}) {
  return {
    text: '## 2026-08-10T00:00:00.000Z user\nhi\n\n## 2026-08-10T00:01:00.000Z assistant\nhello\n\n',
    turnCount: 2,
    startFile: '2026-08-10.md',
    startOffset: 0,
    endFile: '2026-08-10.md',
    endOffset: 500,
    boundary: 'turn',
    coversFrom: '2026-08-10T00:00:00.000Z',
    coversUntil: '2026-08-10T00:01:00.000Z',
    ...overrides,
  };
}

function makeSummarizeFn(overrides = {}) {
  return async () => ({
    summary: overrides.summary ?? 'Mock chunk summary.',
    costUsd: overrides.costUsd ?? 0.001,
    tokensIn: overrides.tokensIn ?? 100,
    tokensOut: overrides.tokensOut ?? 50,
  });
}

function makeUpdateStateFn(overrides = {}) {
  return async ({ oldStateMd, newSummary }) => ({
    schema_version: 1,
    ok: true,
    mergedMd: overrides.mergedMd ?? `${oldStateMd}\n\n${newSummary}`,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    llmFailure: false,
  });
}

function baseArgs(vault, overrides = {}) {
  return {
    vaultDir: vault,
    project: PROJECT,
    chunk: makeChunk(),
    prevCursor: null,
    config: baseConfig(),
    chunkingCfg: baseChunkingCfg(),
    lane: null,
    persona: null,
    surface: 'test',
    skipStateMerge: false,
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    summarizeFn: makeSummarizeFn(),
    updateStateFn: makeUpdateStateFn(),
    reindexFn: async () => {},
    ...overrides,
  };
}

// ===========================================================================
// Section A — happy path + deterministic id + full ordering (I5) pin.
// ===========================================================================

test('happy path: steps run in order (I5 pinned via disk-state spies), committed shape complete', async () => {
  const vault = makeVault();
  const chunk = makeChunk();
  const summaryId = computeId(PROJECT, chunk);
  const order = [];

  const summarizeFn = async () => {
    order.push('summarize');
    assert.equal(fsSync.existsSync(cursorPath(vault)), false, 'cursor must not exist before summarize');
    assert.equal(fsSync.existsSync(summaryPathFor(vault, summaryId)), false, 'final summary must not exist before summarize');
    return { summary: 'Chunk summary body.', costUsd: 0.002, tokensIn: 120, tokensOut: 60 };
  };

  const updateStateFn = async ({ oldStateMd, newSummary }) => {
    order.push('stateMerge');
    assert.ok(order.indexOf('summarize') < order.indexOf('stateMerge'), 'state merge must run after summarize');
    assert.equal(fsSync.existsSync(summaryPathFor(vault, summaryId) + '.tmp'), true, 'summary .tmp must exist during state merge (phase 1 already ran)');
    assert.equal(fsSync.existsSync(summaryPathFor(vault, summaryId)), false, 'final summary must NOT exist yet during state merge (I5: rename is after)');
    assert.equal(fsSync.existsSync(cursorPath(vault)), false, 'cursor must NOT exist yet during state merge (I5: cursor advance is after rename)');
    return { schema_version: 1, ok: true, mergedMd: `${oldStateMd}\n\n${newSummary}`, costUsd: 0, tokensIn: 0, tokensOut: 0, llmFailure: false };
  };

  const reindexFn = async (relPath) => {
    order.push('reindex');
    assert.equal(relPath, `sessions/${PROJECT}/${summaryId}.md`);
    assert.equal(fsSync.existsSync(summaryPathFor(vault, summaryId)), true, 'final summary must already exist before reindex (I5: rename is before)');
    assert.equal(fsSync.existsSync(cursorPath(vault)), true, 'cursor must already be advanced before reindex (I5: cursor is before reindex)');
  };

  const result = await runChunkTransaction(
    baseArgs(vault, { chunk }),
    baseDeps({ summarizeFn, updateStateFn, reindexFn }),
  );

  assert.ok(result.committed, `expected committed, got: ${JSON.stringify(result)}`);
  assert.deepEqual(order, ['summarize', 'stateMerge', 'reindex']);
  assert.equal(result.committed.summaryId, summaryId);
  assert.equal(result.committed.summaryPath, `sessions/${PROJECT}/${summaryId}.md`);
  assert.equal(result.committed.costUsd, 0.002);
  assert.equal(result.committed.tokensIn, 120);
  assert.equal(result.committed.tokensOut, 60);
  assert.ok(result.committed.nextCursor);
  assert.equal(result.committed.nextCursor.file, chunk.endFile);
  assert.equal(result.committed.nextCursor.offset, chunk.endOffset);
  assert.equal(result.committed.nextCursor.boundary, chunk.boundary);
  assert.equal(result.committed.nextCursor.last_summary_id, summaryId);

  // Deterministic id: identical window (fresh vault) -> same id.
  const vault2 = makeVault();
  const result2 = await runChunkTransaction(baseArgs(vault2, { chunk }), baseDeps());
  assert.equal(result2.committed.summaryId, summaryId, 'same content window must yield the same id');

  // Different window (same project, different end offset) -> different id.
  const differentChunk = makeChunk({ endOffset: 999 });
  const result3 = await runChunkTransaction(baseArgs(vault2, { chunk: differentChunk }), baseDeps());
  assert.notEqual(result3.committed.summaryId, summaryId, 'a different window must yield a different id');

  await fs.rm(vault, { recursive: true, force: true });
  await fs.rm(vault2, { recursive: true, force: true });
});

// ===========================================================================
// Section B — ordering / crash-safety failure shapes.
// ===========================================================================

test('summarize failure: nothing written, cursor untouched, failed/summarize + capture.checkpoint failed emit', async () => {
  const vault = makeVault();
  const captured = [];

  const result = await runChunkTransaction(
    baseArgs(vault),
    baseDeps({
      summarizeFn: async () => { throw new Error('boom'); },
      recordCaptureEvent: (evt) => captured.push(evt),
    }),
  );

  assert.equal(result.committed, undefined);
  assert.equal(result.failed?.stage, 'summarize');
  assert.equal(result.failed.providerClass, 'upstream');
  assert.match(result.failed.message, /boom/);

  const sessionEntries = await fs.readdir(path.join(vault, 'sessions', PROJECT)).catch(() => []);
  assert.deepEqual(sessionEntries, [], 'no summary file (tmp or final) may exist');
  const cursorExists = await fs.stat(cursorPath(vault)).then(() => true, () => false);
  assert.equal(cursorExists, false, 'cursor must not be created');

  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, CAPTURE_EVENTS.CHECKPOINT);
  assert.equal(captured[0].outcome, 'failed');

  await fs.rm(vault, { recursive: true, force: true });
});

test('summarize failure: ProviderError class maps to providerClass (ratelimit/config)', async () => {
  const vault = makeVault();

  const rl = await runChunkTransaction(baseArgs(vault), baseDeps({
    summarizeFn: async () => { throw new ProviderError({ class: 'PROVIDER_RATELIMIT', provider: 'test', status: 429, message: 'rate limited', retryable: true }); },
  }));
  assert.equal(rl.failed?.providerClass, 'ratelimit');

  const cfg = await runChunkTransaction(baseArgs(vault), baseDeps({
    summarizeFn: async () => { throw new ProviderError({ class: 'PROVIDER_CONFIG', provider: 'test', status: 400, message: 'bad key' }); },
  }));
  assert.equal(cfg.failed?.providerClass, 'config');

  const up = await runChunkTransaction(baseArgs(vault), baseDeps({
    summarizeFn: async () => { throw new ProviderError({ class: 'PROVIDER_UPSTREAM', provider: 'test', status: 503, message: 'down' }); },
  }));
  assert.equal(up.failed?.providerClass, 'upstream');

  await fs.rm(vault, { recursive: true, force: true });
});

test('summarize timeout: short ms + never-resolving fn -> failed/summarize (providerClass upstream), failed emit', async () => {
  const vault = makeVault();
  const captured = [];
  const result = await runChunkTransaction(
    baseArgs(vault, { chunkingCfg: baseChunkingCfg({ summarizeTimeoutMs: 20 }) }),
    baseDeps({
      summarizeFn: () => new Promise(() => {}), // never resolves
      recordCaptureEvent: (evt) => captured.push(evt),
    }),
  );
  assert.equal(result.failed?.stage, 'summarize');
  assert.equal(result.failed.providerClass, 'upstream');
  assert.match(result.failed.message, /timed out/i);
  assert.equal(captured[0]?.outcome, 'failed');
  await fs.rm(vault, { recursive: true, force: true });
});

test('phase-2 rename failure: .tmp orphan-marked, cursor unchanged, failed/phase2', async () => {
  const vault = makeVault();
  const chunk = makeChunk();
  const id = computeId(PROJECT, chunk);
  const finalPath = summaryPathFor(vault, id);
  // Pre-create a DIRECTORY at the deterministic final path: fs.rename(tmp, final)
  // then fails (portable across POSIX/Windows — no symlink privileges needed).
  await fs.mkdir(finalPath, { recursive: true });

  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, skipStateMerge: true }),
    baseDeps(),
  );

  assert.equal(result.failed?.stage, 'phase2', `expected phase2 failure, got: ${JSON.stringify(result)}`);
  assert.equal(result.committed, undefined);

  const tmpContent = await fs.readFile(finalPath + '.tmp', 'utf8');
  assert.match(tmpContent, /^status:\s*orphan_summary$/m, 'the .tmp must be marked orphan_summary');

  const cursorExists = await fs.stat(cursorPath(vault)).then(() => true, () => false);
  assert.equal(cursorExists, false, 'cursor must remain unwritten');

  await fs.rm(vault, { recursive: true, force: true });
});

test('cursor-write failure: doc durable, cursor unchanged, failed/cursor_write', async () => {
  const vault = makeVault();
  const chunk = makeChunk();
  const id = computeId(PROJECT, chunk);
  // Pre-create a DIRECTORY at the cursor's .tmp path so advanceCursor's
  // fs.open(O_CREAT|O_TRUNC) throws (EISDIR-class), portable cross-platform.
  await fs.mkdir(cursorPath(vault) + '.tmp', { recursive: true });

  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, skipStateMerge: true }),
    baseDeps(),
  );

  assert.equal(result.failed?.stage, 'cursor_write', `expected cursor_write failure, got: ${JSON.stringify(result)}`);
  assert.match(result.failed.message, /check free space on the vault volume/);

  const finalContent = await fs.readFile(summaryPathFor(vault, id), 'utf8');
  assert.ok(finalContent.includes('type: session_summary'), 'the summary doc must already be durable');

  const cursorExists = await fs.stat(cursorPath(vault)).then(() => true, () => false);
  assert.equal(cursorExists, false, 'the real cursor file (not the planted .tmp dir) must not exist');

  await fs.rm(vault, { recursive: true, force: true });
});

test('reindex exhaustion: cursor ADVANCED, doc durable, outcome=error, failed/reindex with summaryId+summaryPath', async () => {
  const vault = makeVault();
  const chunk = makeChunk();
  const id = computeId(PROJECT, chunk);
  const captured = [];

  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, skipStateMerge: true }),
    baseDeps({
      reindexFn: async () => { throw new Error('mem0 unavailable'); },
      retryDelaysMs: [0, 0, 0],
      retryJitterMaxMs: 0,
      recordCaptureEvent: (evt) => captured.push(evt),
    }),
  );

  assert.equal(result.failed?.stage, 'reindex');
  assert.equal(result.failed.summaryId, id);
  assert.equal(result.failed.summaryPath, `sessions/${PROJECT}/${id}.md`);
  assert.match(result.failed.message, /after 3 retries/);

  const cursor = JSON.parse(await fs.readFile(cursorPath(vault), 'utf8'));
  assert.equal(cursor.file, chunk.endFile);
  assert.equal(cursor.offset, chunk.endOffset);
  assert.equal(cursor.last_summary_id, id);

  const finalContent = await fs.readFile(summaryPathFor(vault, id), 'utf8');
  assert.ok(finalContent.length > 0, 'the doc must be durable despite reindex exhaustion');

  const errEvt = captured.find((e) => e.outcome === 'error');
  assert.ok(errEvt, 'capture.checkpoint outcome=error must be emitted');

  await fs.rm(vault, { recursive: true, force: true });
});

// ===========================================================================
// Section C — #185 thin gate (AND-composition), applied to the chunk.
// ===========================================================================

test('thin gate: below both floors -> {thin:true}, no summarize call, cursor untouched', async () => {
  const vault = makeVault();
  let summarizeCalls = 0;
  const chunk = makeChunk({ text: 'short', turnCount: 1 });

  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, config: baseConfig({ min_transcript_bytes: 500, min_transcript_turns: 2 }) }),
    baseDeps({ summarizeFn: async () => { summarizeCalls += 1; return { summary: 'x', costUsd: 0, tokensIn: 0, tokensOut: 0 }; } }),
  );

  assert.deepEqual(result, { thin: true });
  assert.equal(summarizeCalls, 0, 'summarizer must never see a thin chunk');
  const cursorExists = await fs.stat(cursorPath(vault)).then(() => true, () => false);
  assert.equal(cursorExists, false);

  await fs.rm(vault, { recursive: true, force: true });
});

test('thin gate: turn floor alone clears (bytes low, turns high) -> proceeds (AND-composition)', async () => {
  const vault = makeVault();
  const chunk = makeChunk({ text: 'hi', turnCount: 2 }); // 2 bytes < 500; 2 turns >= 2
  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, config: baseConfig({ min_transcript_bytes: 500, min_transcript_turns: 2 }) }),
    baseDeps(),
  );
  assert.ok(result.committed, `expected committed, got: ${JSON.stringify(result)}`);
  await fs.rm(vault, { recursive: true, force: true });
});

test('thin gate: byte floor alone clears (bytes high, turns low) -> proceeds (AND-composition)', async () => {
  const vault = makeVault();
  const chunk = makeChunk({ text: 'x'.repeat(600), turnCount: 0 }); // 600 bytes >= 500; 0 turns < 2
  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, config: baseConfig({ min_transcript_bytes: 500, min_transcript_turns: 2 }) }),
    baseDeps(),
  );
  assert.ok(result.committed, `expected committed, got: ${JSON.stringify(result)}`);
  await fs.rm(vault, { recursive: true, force: true });
});

// ===========================================================================
// Section D — §4.8 state-merge degrade matrix.
// ===========================================================================

test('state-merge degrade: updateStateFn resolves ok:false -> verbatim-append + marker, chunk still committed', async () => {
  const vault = makeVault();
  const oldState = 'Existing state content.';
  await fs.mkdir(path.join(vault, 'state', PROJECT), { recursive: true });
  await fs.writeFile(path.join(vault, 'state', PROJECT, 'state.md'), oldState, 'utf8');

  const result = await runChunkTransaction(
    baseArgs(vault),
    baseDeps({
      summarizeFn: makeSummarizeFn({ summary: 'New chunk summary body.' }),
      updateStateFn: async () => ({ schema_version: 1, ok: false, error: 'prompt missing' }),
    }),
  );
  assert.ok(result.committed, `expected committed despite degrade, got: ${JSON.stringify(result)}`);

  const stateMd = await fs.readFile(path.join(vault, 'state', PROJECT, 'state.md'), 'utf8');
  assert.ok(stateMd.includes(oldState), 'old state content preserved');
  assert.ok(stateMd.includes('New chunk summary body.'), 'new summary appended verbatim');
  assert.ok(stateMd.includes('<!-- state-merge-unavailable -->'), 'degrade marker present');

  await fs.rm(vault, { recursive: true, force: true });
});

test('state-merge degrade: updateStateFn resolves non-string mergedMd -> degrade', async () => {
  const vault = makeVault();
  const result = await runChunkTransaction(
    baseArgs(vault),
    baseDeps({
      summarizeFn: makeSummarizeFn({ summary: 'Body for non-string case.' }),
      updateStateFn: async () => ({ schema_version: 1, ok: true, mergedMd: 12345 }),
    }),
  );
  assert.ok(result.committed, `expected committed, got: ${JSON.stringify(result)}`);

  const stateMd = await fs.readFile(path.join(vault, 'state', PROJECT, 'state.md'), 'utf8');
  assert.ok(stateMd.includes('Body for non-string case.'));
  assert.ok(stateMd.includes('<!-- state-merge-unavailable -->'));

  await fs.rm(vault, { recursive: true, force: true });
});

test('state-merge degrade: updateStateFn hangs past stateMergeTimeoutMs -> degrade, no throw', async () => {
  const vault = makeVault();
  const result = await runChunkTransaction(
    baseArgs(vault, { chunkingCfg: baseChunkingCfg({ stateMergeTimeoutMs: 20 }) }),
    baseDeps({
      summarizeFn: makeSummarizeFn({ summary: 'Body for hang case.' }),
      updateStateFn: () => new Promise(() => {}), // never resolves
    }),
  );
  assert.ok(result.committed, `expected committed despite hang, got: ${JSON.stringify(result)}`);

  const stateMd = await fs.readFile(path.join(vault, 'state', PROJECT, 'state.md'), 'utf8');
  assert.ok(stateMd.includes('Body for hang case.'));
  assert.ok(stateMd.includes('<!-- state-merge-unavailable -->'));

  await fs.rm(vault, { recursive: true, force: true });
});

test('state-merge degrade: degraded content over 3000 chars truncates like updateState\'s own cap', async () => {
  const vault = makeVault();
  const hugeSummary = 'x'.repeat(4000);
  const result = await runChunkTransaction(
    baseArgs(vault),
    baseDeps({
      summarizeFn: makeSummarizeFn({ summary: hugeSummary }),
      updateStateFn: async () => ({ schema_version: 1, ok: false }),
    }),
  );
  assert.ok(result.committed, `expected committed, got: ${JSON.stringify(result)}`);

  const stateMd = await fs.readFile(path.join(vault, 'state', PROJECT, 'state.md'), 'utf8');
  assert.ok(stateMd.length <= 3000, `expected <= 3000 chars, got ${stateMd.length}`);
  assert.ok(stateMd.endsWith('\n...'));

  await fs.rm(vault, { recursive: true, force: true });
});

// ===========================================================================
// Section E — 5b auto-supersede pass (warn-not-throw; commit unaffected).
// ===========================================================================

test('5b: detector hangs past autosupersedeTimeoutMs -> chunk still committed, warn logged', async () => {
  const vault = makeVault();
  const captured = _attachLogCapture();
  try {
    const result = await runChunkTransaction(
      baseArgs(vault, { lane: 'test-lane', chunkingCfg: baseChunkingCfg({ autosupersedeTimeoutMs: 20 }) }),
      baseDeps({
        isAutoSupersedeEnabled: () => true,
        detectContradictions: () => new Promise(() => {}), // never resolves
      }),
    );
    assert.ok(result.committed, `expected committed despite 5b hang, got: ${JSON.stringify(result)}`);
    assert.ok(
      captured.some((l) => l.level === 'warn' && /auto-supersede/i.test(l.msg ?? '')),
      `expected a warn log for the timed-out 5b pass, got: ${JSON.stringify(captured)}`,
    );
  } finally {
    _detachLogCapture();
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('5b: detector throws -> chunk still committed, warn logged', async () => {
  const vault = makeVault();
  const captured = _attachLogCapture();
  try {
    const result = await runChunkTransaction(
      baseArgs(vault, { lane: 'test-lane' }),
      baseDeps({
        isAutoSupersedeEnabled: () => true,
        detectContradictions: async () => { throw new Error('detector exploded'); },
      }),
    );
    assert.ok(result.committed, `expected committed despite detector throw, got: ${JSON.stringify(result)}`);
    assert.ok(
      captured.some((l) => l.level === 'warn' && /auto-supersede/i.test(l.msg ?? '')),
      `expected a warn log for the failed 5b pass, got: ${JSON.stringify(captured)}`,
    );
  } finally {
    _detachLogCapture();
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('5b: detector returns detections -> supersede called + digest appended before reindexFn sees the file', async () => {
  const vault = makeVault();
  const chunk = makeChunk();
  const supersedeCalls = [];
  let digestSeenByReindex = false;

  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, lane: 'test-lane', skipStateMerge: true }),
    baseDeps({
      isAutoSupersedeEnabled: () => true,
      detectContradictions: async () => [{ targetId: 'fact-1', supersededBy: 'fact-2', confidence: 0.9, reasoning: 'contradicts' }],
      supersedePoint: async (spArgs) => { supersedeCalls.push(spArgs); },
      reindexFn: async (relPath) => {
        const content = await fs.readFile(path.join(vault, relPath), 'utf8');
        digestSeenByReindex = content.includes('Auto-superseded');
      },
    }),
  );

  assert.ok(result.committed, `expected committed, got: ${JSON.stringify(result)}`);
  assert.equal(supersedeCalls.length, 1);
  assert.equal(supersedeCalls[0].id, 'fact-1');
  assert.equal(supersedeCalls[0].supersededBy, 'fact-2');
  assert.equal(digestSeenByReindex, true, 'reindexFn must see the digest already appended to the file (spy order)');

  await fs.rm(vault, { recursive: true, force: true });
});

test('5b: real detector eligibility gate no-ops when lane/persona are both absent (fast no-op, chunk still committed)', async () => {
  const vault = makeVault();
  // No detectContradictions/supersedePoint override here — this exercises the
  // REAL detectContradictionsInBatch's own eligibility gate (contradiction-
  // batch.mjs's FIRST LINE: `if (!lane && !persona) return [];`), which must
  // short-circuit before any I/O (no userId/qdrant client is supplied either —
  // a real detection attempt would throw without them).
  const result = await runChunkTransaction(
    baseArgs(vault), // lane/persona both null (default)
    baseDeps({ isAutoSupersedeEnabled: () => true }),
  );
  assert.ok(result.committed, `expected committed (gate no-op), got: ${JSON.stringify(result)}`);

  const finalContent = await fs.readFile(path.join(vault, result.committed.summaryPath), 'utf8');
  assert.ok(!finalContent.includes('Auto-superseded'), 'no digest should be appended when the gate no-ops');

  await fs.rm(vault, { recursive: true, force: true });
});

// ===========================================================================
// Section F — per-chunk cost telemetry.
// ===========================================================================

test('per-chunk cost: telemetry file incremented after success', async () => {
  const vault = makeVault();
  const result = await runChunkTransaction(
    baseArgs(vault),
    baseDeps({ summarizeFn: makeSummarizeFn({ costUsd: 0.01 }) }),
  );
  assert.ok(result.committed);

  const today = new Date().toISOString().slice(0, 10);
  const costFile = path.join(vault, '.telemetry', `${today}-${PROJECT}.count`);
  const spent = parseFloat(await fs.readFile(costFile, 'utf8'));
  assert.ok(Math.abs(spent - 0.01) < 1e-9, `expected ~0.01, got ${spent}`);

  await fs.rm(vault, { recursive: true, force: true });
});

test('per-chunk cost: pre-check stops when cap already reached (stopped:cost_cap, nothing consumed)', async () => {
  const vault = makeVault();
  const today = new Date().toISOString().slice(0, 10);
  const telemetryDir = path.join(vault, '.telemetry');
  await fs.mkdir(telemetryDir, { recursive: true });
  await fs.writeFile(path.join(telemetryDir, `${today}-${PROJECT}.count`), '0.50');

  let summarizeCalls = 0;
  const result = await runChunkTransaction(
    baseArgs(vault, { config: baseConfig({ cost_cap_usd_per_day_per_project: 0.50 }) }),
    baseDeps({ summarizeFn: async () => { summarizeCalls += 1; return { summary: 'x', costUsd: 0, tokensIn: 0, tokensOut: 0 }; } }),
  );

  assert.deepEqual(result, { stopped: { reason: 'cost_cap' } });
  assert.equal(summarizeCalls, 0);

  await fs.rm(vault, { recursive: true, force: true });
});

// ===========================================================================
// Section G — §4.1 last_turn_iso max-persist rule.
// ===========================================================================

test('last_turn_iso max-persist: prevCursor NEWER than chunk.coversUntil keeps the newer value', async () => {
  const vault = makeVault();
  const chunk = makeChunk({ coversUntil: '2026-08-10T00:01:00.000Z' });
  const prevCursor = { last_turn_iso: '2026-08-12T00:00:00.000Z' }; // newer than the chunk's own coversUntil
  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, prevCursor }),
    baseDeps(),
  );
  assert.ok(result.committed);
  assert.equal(result.committed.nextCursor.last_turn_iso, '2026-08-12T00:00:00.000Z');
  await fs.rm(vault, { recursive: true, force: true });
});

test('last_turn_iso max-persist: chunk.coversUntil newer than prevCursor advances the watermark', async () => {
  const vault = makeVault();
  const chunk = makeChunk({ coversUntil: '2026-08-14T00:00:00.000Z' });
  const prevCursor = { last_turn_iso: '2026-08-10T00:00:00.000Z' };
  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, prevCursor }),
    baseDeps(),
  );
  assert.ok(result.committed);
  assert.equal(result.committed.nextCursor.last_turn_iso, '2026-08-14T00:00:00.000Z');
  await fs.rm(vault, { recursive: true, force: true });
});

test('last_turn_iso max-persist: null/absent prevCursor falls back to chunk.coversUntil', async () => {
  const vault = makeVault();
  const chunk = makeChunk({ coversUntil: '2026-08-11T00:00:00.000Z' });
  const result = await runChunkTransaction(
    baseArgs(vault, { chunk, prevCursor: null }),
    baseDeps(),
  );
  assert.ok(result.committed);
  assert.equal(result.committed.nextCursor.last_turn_iso, '2026-08-11T00:00:00.000Z');
  await fs.rm(vault, { recursive: true, force: true });
});
