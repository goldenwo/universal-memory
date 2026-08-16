// server/test/checkpoint-crash-matrix.test.mjs — Task 8: constructed
// post-crash disk-state matrix (spec §11.2(a)), I2 size-invariance property
// test, and the deterministic-summary-id golden-value pin
// (docs/plans/2026-08-15-checkpoint-chunked-summarization-spec.md;
// .superpowers/sdd/2026-08-15-checkpoint-chunked-summarization-plan/
// task-8-brief.md).
//
// CRASH-STATE MATRIX (§1 of the brief): for each spec §4.5 boundary, this
// file FABRICATES the exact on-disk state a hard kill leaves — never runs a
// real pipeline partway and interrupts it (there is no DI seam inside
// checkpoint-chunk-txn.mjs's two-phase write to interrupt at without touching
// production code, which this task may not do beyond two additive changes).
// A fabricated fixture is only meaningful if it lands on the SAME path a real
// run would independently compute, so several tests replicate
// checkpoint-chunk-txn.mjs's deterministicSummaryId algorithm locally
// (`computeId` below) purely to PREDICT that path — the same house pattern
// checkpoint-chunk-txn.test.mjs's own `computeId` helper already uses. That
// is deliberately NOT the same thing as this file's golden-value pin (bottom
// of the file), which asserts a hardcoded literal so an accidental
// hash-input reorder in production actually fails a test instead of both
// copies silently drifting together.
//
// Every case uses a mock summarizer that ECHOES its input verbatim (the
// produced summary IS the transcript) — so "no turn is ever lost" and "the
// crashed window got re-digested" are checkable directly: a turn's own
// marker text is searchable both in captured summarize-call inputs and in
// the resulting on-disk doc body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { doCheckpoint } from '../lib/checkpoint.mjs';
import { runChunkTransaction } from '../lib/checkpoint-chunk-txn.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

// ---- shared fixture helpers (mirrors checkpoint-chunked.test.mjs's conventions) ----

function makeVault() {
  return tempDir('um-ck-crash-');
}

async function seedCapture(vaultDir, project, filename, content) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, filename), content);
}

/** A real append-turn-shaped turn header + filler body. */
function makeTurn(iso, role, filler) {
  return `## ${iso} ${role}\n${filler}\n\n`;
}

function makeUpdateStateFn() {
  return async ({ oldStateMd, newSummary }) => ({
    schema_version: 1,
    ok: true,
    mergedMd: `${oldStateMd}\n\n${newSummary}`,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    llmFailure: false,
  });
}

const BASE_CONFIG = {
  schema_version: 1,
  cost_cap_usd_per_day_per_project: 0.50,
  summary_model: 'gpt-4o-mini',
  state_cap_chars: 3000,
  lockdir_stale_timeout_ms: 600000,
  // #185 gate OFF — these tests exercise crash-recovery mechanics, not
  // admission semantics (mirrors checkpoint-chunked.test.mjs's BASE_CONFIG).
  min_transcript_bytes: 0,
  min_transcript_turns: 0,
};

async function readCursor(vaultDir, project) {
  const cursorPath = path.join(vaultDir, 'state', project, 'checkpoint-cursor.json');
  return JSON.parse(await fs.readFile(cursorPath, 'utf8'));
}

/** Fabricate a pre-existing, VALID cursor.json — same schema advanceCursor writes. */
async function writeCursor(vaultDir, project, cursor) {
  const cursorPath = path.join(vaultDir, 'state', project, 'checkpoint-cursor.json');
  await fs.mkdir(path.dirname(cursorPath), { recursive: true });
  await fs.writeFile(cursorPath, JSON.stringify({
    schema_version: 1,
    last_summary_id: null,
    ...cursor,
  }, null, 2));
}

/**
 * Mirrors checkpoint-chunk-txn.mjs's deterministicSummaryId — a
 * PATH-PREDICTION duplicate (same house pattern as
 * checkpoint-chunk-txn.test.mjs's own `computeId`), used only to know where a
 * real run will independently compute the same doc, so fabricated fixtures
 * land where the real pipeline will look. NOT the golden-value pin at the
 * bottom of this file.
 */
function computeId(project, chunk) {
  const hash = createHash('sha256')
    .update(`${project}|${chunk.startFile}|${chunk.startOffset}|${chunk.endFile}|${chunk.endOffset}`)
    .digest('hex')
    .slice(0, 8);
  return `session-${chunk.coversFrom.slice(0, 10)}-${hash}`;
}

function sessionPath(vaultDir, project, id) {
  return path.join(vaultDir, 'sessions', project, `${id}.md`);
}

/** Same frontmatter shape checkpoint-chunk-txn.mjs writes (spec §4.5 step 4). */
function makeFrontmatter({ id, project, coversFrom, coversUntil, extraLines = [] }) {
  return [
    '---',
    'type: session_summary',
    `id: ${id}`,
    `title: Session summary ${coversFrom.slice(0, 10)} for ${project}`,
    `project: ${project}`,
    `valid_from: ${new Date().toISOString()}`,
    `covers_from: ${coversFrom}`,
    `covers_until: ${coversUntil}`,
    'tokens_in: 100',
    'tokens_out: 50',
    'cost_usd: 0.001000',
    ...extraLines,
    '---',
    '',
  ].join('\n');
}

/** A summarizer that ECHOES its input verbatim — coverage is checkable via string search. */
function makeEchoSummarizer() {
  const calls = [];
  const fn = async (transcript) => {
    calls.push(transcript);
    return { summary: transcript, costUsd: 0.001, tokensIn: 10, tokensOut: 5 };
  };
  return { fn, calls };
}

// ===========================================================================
// Case 1 — crash after phase-1 .tmp write (spec §4.5 step 4, first half):
// orphan .tmp in sessions/, NO final doc, cursor unadvanced.
// ===========================================================================

test('crash matrix 1: orphan .tmp after phase-1 write (valid pre-existing cursor) — next run overwrites/re-digests it, never treats it as durable', async () => {
  const vaultDir = await makeVault();
  const project = 'crash1proj';

  const t1 = makeTurn('2026-01-01T00:00:00.000Z', 'user', 'FILE1_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-01.md', t1);
  const t2 = makeTurn('2026-01-02T00:00:00.000Z', 'user', 'FILE2_TURN_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-02.md', t2);

  // A valid, pre-existing cursor: file1 already fully digested by an earlier
  // (un-crashed) chunk; file2's OWN chunk crashed right after its phase-1
  // .tmp write. updated_at is set comfortably in the future of both raw
  // files' mtimes so the §4.2 check-4 below-cursor-growth tripwire does not
  // (falsely) fire and reinit this cursor away.
  await writeCursor(vaultDir, project, {
    file: '2026-01-02.md', offset: 0, boundary: 'turn',
    last_turn_iso: '2026-01-01T00:00:00.000Z',
    updated_at: new Date(Date.now() + 5000).toISOString(),
  });

  const chunk2 = {
    startFile: '2026-01-02.md', startOffset: 0,
    endFile: '2026-01-02.md', endOffset: Buffer.byteLength(t2, 'utf8'),
    coversFrom: '2026-01-02T00:00:00.000Z', coversUntil: '2026-01-02T00:00:00.000Z',
  };
  const id2 = computeId(project, chunk2);

  // Fabricate EXACTLY what a hard kill leaves right after phase-1's .tmp
  // write: only the .tmp exists, no final doc, no orphan_summary marking
  // (markOrphanSummary never ran — the process died before any catch block
  // could run it).
  const tmpPath = sessionPath(vaultDir, project, id2) + '.tmp';
  await fs.mkdir(path.dirname(tmpPath), { recursive: true });
  await fs.writeFile(
    tmpPath,
    makeFrontmatter({ id: id2, project, coversFrom: chunk2.coversFrom, coversUntil: chunk2.coversUntil })
      + 'STALE ORPHAN CONTENT — must never survive',
  );

  const { fn: summarizeFn, calls } = makeEchoSummarizer();
  const result = await doCheckpoint(
    { project },
    { config: BASE_CONFIG, vaultDir, summarizeFn, updateStateFn: makeUpdateStateFn(), reindexFn: async () => {} },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'only file2 (the crashed window) is re-digested — the pre-existing cursor is honored');

  // No loss: this run's summarize input covers file2's turn; file1 (already
  // past the cursor) is never re-read.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('FILE2_TURN_MARKER'), 'the crashed window must be re-digested');
  assert.ok(!calls[0].includes('FILE1_MARKER'), 'file1 (already past the cursor) must not be re-read');

  // Orphan never treated as durable: overwritten, not left as stale content.
  const tmpStillThere = await fs.stat(tmpPath).catch(() => null);
  assert.equal(tmpStillThere, null, '.tmp must be gone (renamed away) after a successful re-digest');
  const finalDoc = await fs.readFile(sessionPath(vaultDir, project, id2), 'utf8');
  assert.ok(!finalDoc.includes('STALE ORPHAN CONTENT'), 'the orphan .tmp content must never survive into the durable doc');
  assert.ok(finalDoc.includes('FILE2_TURN_MARKER'), 'the durable doc must hold the real (re-digested) content');

  const cursor = await readCursor(vaultDir, project);
  assert.equal(cursor.file, '2026-01-02.md');
  assert.equal(cursor.offset, Buffer.byteLength(t2, 'utf8'), 'cursor ends sane: advanced to the end of the re-digested window');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Sub-case: "assert that path too by ALSO deleting the cursor first"
// (brief §1.1) — no cursor.json exists at all, exercising bootstrapInit's
// OWN session-file scan (a different code path than case 1's
// validateAndAdjust) against the same class of orphan .tmp litter.

test('crash matrix 1 sub-case: orphan .tmp litter does not fool the bootstrap scan into skipping real backlog (no cursor exists at all — Task-2 bootstrap fix)', async () => {
  const vaultDir = await makeVault();
  const project = 'crash1bproj';

  const t1 = makeTurn('2026-01-01T00:00:00.000Z', 'user', 'REAL_BACKLOG_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-01.md', t1);

  // Deceptive litter: an orphan .tmp whose filename embeds a far-future
  // date. bootstrapInit's session-file regex is anchored on `.md$`
  // (checkpoint-cursor.mjs: "Anchored to .md$ ... WITHOUT this, an orphan
  // session-....md.tmp ... would set the bootstrap boundary too high,
  // silently skipping the entire backlog below it"). If that anchor ever
  // regressed to match `.md.tmp` too, this fixture would set
  // newestDate='2099-12-31' and bootstrapInit would point the cursor at a
  // file that will never exist — silently skipping ALL real backlog below
  // it. That is the exact failure mode this sub-case falsifies.
  const sessionsDir = path.join(vaultDir, 'sessions', project);
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, 'session-2099-12-31-deadbeef.md.tmp'),
    makeFrontmatter({
      id: 'session-2099-12-31-deadbeef', project,
      coversFrom: '2099-12-31T00:00:00.000Z', coversUntil: '2099-12-31T00:00:00.000Z',
    }) + 'orphan litter, never a real chunk',
  );

  const cursorFile = await fs.stat(path.join(vaultDir, 'state', project, 'checkpoint-cursor.json')).catch(() => null);
  assert.equal(cursorFile, null, 'precondition: no cursor exists yet (the sub-case)');

  const { fn: summarizeFn, calls } = makeEchoSummarizer();
  const result = await doCheckpoint(
    { project },
    { config: BASE_CONFIG, vaultDir, summarizeFn, updateStateFn: makeUpdateStateFn(), reindexFn: async () => {} },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'real backlog must be digested — never silently skipped because of orphan .tmp litter');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('REAL_BACKLOG_MARKER'), 'the real (only) content must be summarized');

  const cursor = await readCursor(vaultDir, project);
  assert.equal(cursor.file, '2026-01-01.md', 'cursor must bootstrap to the REAL oldest raw file, not the litter .tmp file\'s embedded far-future date');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ===========================================================================
// Case 2 — crash after state.md merge, before rename (spec §4.5 step 4,
// second half): .tmp with status:orphan_summary frontmatter, state.md
// already merged, cursor unadvanced.
// ===========================================================================

test('crash matrix 2: crash after state.md merge, before rename (.tmp orphan_summary-marked, state.md already merged) — next run re-digests, duplicate-safe', async () => {
  const vaultDir = await makeVault();
  const project = 'crash2proj';

  const t1 = makeTurn('2026-01-01T00:00:00.000Z', 'user', 'FILE1_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-01.md', t1);
  const t2 = makeTurn('2026-01-02T00:00:00.000Z', 'user', 'FILE2_TURN_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-02.md', t2);

  await writeCursor(vaultDir, project, {
    file: '2026-01-02.md', offset: 0, boundary: 'turn',
    last_turn_iso: '2026-01-01T00:00:00.000Z',
    updated_at: new Date(Date.now() + 5000).toISOString(),
  });

  const chunk2 = {
    startFile: '2026-01-02.md', startOffset: 0,
    endFile: '2026-01-02.md', endOffset: Buffer.byteLength(t2, 'utf8'),
    coversFrom: '2026-01-02T00:00:00.000Z', coversUntil: '2026-01-02T00:00:00.000Z',
  };
  const id2 = computeId(project, chunk2);

  // Fabricate: .tmp already carries status:orphan_summary (as
  // markOrphanSummary would have applied it), AND state.md already carries a
  // merge that happened before the crash — the exact state a kill strictly
  // between "state.md merge" and "final rename" leaves.
  const tmpPath = sessionPath(vaultDir, project, id2) + '.tmp';
  await fs.mkdir(path.dirname(tmpPath), { recursive: true });
  await fs.writeFile(tmpPath, makeFrontmatter({
    id: id2, project, coversFrom: chunk2.coversFrom, coversUntil: chunk2.coversUntil,
    extraLines: ['status: orphan_summary'],
  }) + 'STALE ORPHAN-MARKED CONTENT');

  const statePath = path.join(vaultDir, 'state', project, 'state.md');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, '## Prior merged content (crash before rename)\n');

  const { fn: summarizeFn, calls } = makeEchoSummarizer();
  const result = await doCheckpoint(
    { project },
    { config: BASE_CONFIG, vaultDir, summarizeFn, updateStateFn: makeUpdateStateFn(), reindexFn: async () => {} },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('FILE2_TURN_MARKER'), 'no loss: the crashed window is re-digested');
  assert.ok(!calls[0].includes('FILE1_MARKER'), 'file1 (already past cursor) is not re-read');

  const finalDoc = await fs.readFile(sessionPath(vaultDir, project, id2), 'utf8');
  assert.ok(!finalDoc.includes('orphan_summary'), 'fresh phase-1 write (O_TRUNC) fully overwrites the stale orphan-marked .tmp — no leftover marker');
  assert.ok(!finalDoc.includes('STALE ORPHAN-MARKED CONTENT'));
  assert.ok(finalDoc.includes('FILE2_TURN_MARKER'));

  const tmpStillThere = await fs.stat(tmpPath).catch(() => null);
  assert.equal(tmpStillThere, null);

  // Duplicate-safe merge: pre-crash state.md content survives, new content
  // is appended on top — never silently wiped, never a hard failure.
  const mergedState = await fs.readFile(statePath, 'utf8');
  assert.ok(mergedState.includes('Prior merged content (crash before rename)'), 'pre-crash state.md content must survive the re-merge');
  assert.ok(mergedState.includes('FILE2_TURN_MARKER'), 'the re-digested content must also be present');

  const cursor = await readCursor(vaultDir, project);
  assert.equal(cursor.file, '2026-01-02.md');
  assert.equal(cursor.offset, Buffer.byteLength(t2, 'utf8'));

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ===========================================================================
// Case 3 — crash after rename, before cursor advance (spec §4.5 steps 4->5):
// final doc present, cursor lags.
// ===========================================================================

test('crash matrix 3: crash after rename, before cursor advance (final doc present, cursor lags) — re-digest yields the SAME deterministic id, no second doc, then cursor advances', async () => {
  const vaultDir = await makeVault();
  const project = 'crash3proj';

  const t1 = makeTurn('2026-01-01T00:00:00.000Z', 'user', 'CRASH3_TURN_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-01.md', t1);

  const chunk1 = {
    startFile: '2026-01-01.md', startOffset: 0,
    endFile: '2026-01-01.md', endOffset: Buffer.byteLength(t1, 'utf8'),
    coversFrom: '2026-01-01T00:00:00.000Z', coversUntil: '2026-01-01T00:00:00.000Z',
  };
  const id1 = computeId(project, chunk1);

  // Fabricate: the final doc IS present (rename already happened), but NO
  // cursor.json exists at all — a hard kill landed strictly between rename
  // and cursor advance (spec §4.5 steps 4->5). With no session summaries to
  // otherwise inform it, bootstrapInit lands the cursor at exactly this
  // file, offset 0 — precisely "cursor lags" (it does not know this day was
  // already partially digested; one boundary-day of duplication is the
  // accepted at-least-once cost, spec §4.3).
  const finalPath = sessionPath(vaultDir, project, id1);
  await fs.mkdir(path.dirname(finalPath), { recursive: true });
  await fs.writeFile(finalPath, makeFrontmatter({ id: id1, project, coversFrom: chunk1.coversFrom, coversUntil: chunk1.coversUntil }) + t1);

  const beforeFiles = await fs.readdir(path.join(vaultDir, 'sessions', project));
  assert.deepEqual(beforeFiles, [`${id1}.md`], 'precondition: exactly the one durable doc, no cursor');

  const { fn: summarizeFn, calls } = makeEchoSummarizer();
  const reindexCalls = [];
  const result = await doCheckpoint(
    { project },
    { config: BASE_CONFIG, vaultDir, summarizeFn, updateStateFn: makeUpdateStateFn(), reindexFn: async (relPath) => { reindexCalls.push(relPath); } },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'the SAME window is re-digested (the cursor never advanced past it)');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('CRASH3_TURN_MARKER'));

  // Deterministic id -> SAME summary path: no second doc file.
  const afterFiles = await fs.readdir(path.join(vaultDir, 'sessions', project));
  assert.deepEqual(afterFiles, [`${id1}.md`], 'no second doc file — the same deterministic id overwrote the same path');
  assert.equal(result.summary_id, id1);
  assert.equal(result.summary_path, `sessions/${project}/${id1}.md`);

  // reindexFn spy sees the SAME relPath again — no new point identity.
  assert.deepEqual(reindexCalls, [`sessions/${project}/${id1}.md`]);

  // Cursor now advances (previously absent/lagging).
  const cursor = await readCursor(vaultDir, project);
  assert.equal(cursor.file, '2026-01-01.md');
  assert.equal(cursor.offset, Buffer.byteLength(t1, 'utf8'));

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ===========================================================================
// Case 4 — crash after cursor advance, before reindex (spec §4.5 steps 5->6):
// doc present, cursor advanced, unindexed.
// ===========================================================================

test('crash matrix 4: crash after cursor advance, before reindex (doc present, cursor advanced, unindexed) — next run digests the NEXT window; earlier doc untouched, no loss', async () => {
  const vaultDir = await makeVault();
  const project = 'crash4proj';

  const t1 = makeTurn('2026-01-01T00:00:00.000Z', 'user', 'CRASH4_TURN1_MARKER '.repeat(20));
  const t2 = makeTurn('2026-01-01T00:00:01.000Z', 'assistant', 'CRASH4_TURN2_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-01.md', t1 + t2);

  const chunk1 = {
    startFile: '2026-01-01.md', startOffset: 0,
    endFile: '2026-01-01.md', endOffset: Buffer.byteLength(t1, 'utf8'),
    coversFrom: '2026-01-01T00:00:00.000Z', coversUntil: '2026-01-01T00:00:00.000Z',
  };
  const id1 = computeId(project, chunk1);

  // Fabricate chunk 1 as fully committed: final doc present, cursor advanced
  // past it — but reindexFn was NEVER invoked for it (this run's fixture
  // setup calls it zero times; the real pipeline's step 6 never ran before
  // the fabricated kill).
  const finalPath1 = sessionPath(vaultDir, project, id1);
  await fs.mkdir(path.dirname(finalPath1), { recursive: true });
  await fs.writeFile(finalPath1, makeFrontmatter({ id: id1, project, coversFrom: chunk1.coversFrom, coversUntil: chunk1.coversUntil }) + t1);

  await writeCursor(vaultDir, project, {
    file: '2026-01-01.md', offset: Buffer.byteLength(t1, 'utf8'), boundary: 'turn',
    last_turn_iso: chunk1.coversUntil, last_summary_id: id1,
    updated_at: new Date(Date.now() + 5000).toISOString(),
  });

  const { fn: summarizeFn, calls } = makeEchoSummarizer();
  const reindexCalls = [];
  const result = await doCheckpoint(
    { project },
    {
      config: BASE_CONFIG,
      vaultDir, summarizeFn, updateStateFn: makeUpdateStateFn(),
      reindexFn: async (relPath) => { reindexCalls.push(relPath); },
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'only the NEXT window (turn2) is digested this run');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('CRASH4_TURN2_MARKER'), 'the next pending window must be digested');
  assert.ok(!calls[0].includes('CRASH4_TURN1_MARKER'), 'chunk1\'s already-committed window must NOT be re-read');

  // Earlier doc untouched, content intact — no loss (its content is durably
  // on disk, exactly what a re-index retry would need).
  const doc1AfterRun = await fs.readFile(finalPath1, 'utf8');
  assert.ok(doc1AfterRun.includes('CRASH4_TURN1_MARKER'), 'chunk1\'s doc must still hold its original content, untouched');

  // reindexFn only called for the NEW chunk this run — chunk1 is never
  // re-submitted for reindex here (that retry is the drain's separate job,
  // spec §5's per-doc /api/reindex branch).
  assert.equal(reindexCalls.length, 1);
  assert.ok(!reindexCalls.includes(`sessions/${project}/${id1}.md`), 'chunk1 must not be re-indexed by this run');

  const sessionFiles = (await fs.readdir(path.join(vaultDir, 'sessions', project))).sort();
  assert.equal(sessionFiles.length, 2, 'chunk1 doc + the new chunk2 doc');

  const cursor = await readCursor(vaultDir, project);
  assert.equal(cursor.offset, Buffer.byteLength(t1 + t2, 'utf8'), 'cursor advances past both turns now');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ===========================================================================
// Case 5 — SIGKILL world: a HELD (stale) lockdir left behind, cursor
// unadvanced. With lockdir_stale_timeout_ms shortened via config DI, the
// next run recovers the lock, proceeds, and digests.
// ===========================================================================

test('crash matrix 5: SIGKILL world - HELD stale lockdir + cursor unadvanced -> next run recovers the lock and digests normally', async () => {
  const vaultDir = await makeVault();
  const project = 'crash5proj';

  const t1 = makeTurn('2026-01-01T00:00:00.000Z', 'user', 'CRASH5_TURN_MARKER '.repeat(20));
  await seedCapture(vaultDir, project, '2026-01-01.md', t1);

  // A HELD (stale) lockdir left behind by a SIGKILLed prior run — its
  // `finally` (which would call releaseLockdir) never ran. Backdate its
  // mtime past a shortened lockdir_stale_timeout_ms (config DI, exactly
  // acquireLockdir's own staleMs seam) so this run's stale-recovery path
  // genuinely fires rather than racing a live holder.
  const lockdirPath = path.join(vaultDir, 'state', project, 'state.md.lockdir');
  await fs.mkdir(lockdirPath, { recursive: true });
  const staleTimeoutMs = 100;
  const staleTime = new Date(Date.now() - 1000);
  await fs.utimes(lockdirPath, staleTime, staleTime);

  // Cursor unadvanced: no cursor.json (the crashed prior run never got as
  // far as step 5, if it ever got past acquiring the lock at all).
  const cursorFile = await fs.stat(path.join(vaultDir, 'state', project, 'checkpoint-cursor.json')).catch(() => null);
  assert.equal(cursorFile, null, 'precondition: cursor unadvanced');

  const { fn: summarizeFn, calls } = makeEchoSummarizer();
  const result = await doCheckpoint(
    { project },
    {
      config: { ...BASE_CONFIG, lockdir_stale_timeout_ms: staleTimeoutMs },
      vaultDir, summarizeFn, updateStateFn: makeUpdateStateFn(), reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true (stale lock recovered), got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'the pending backlog is digested once the stale lock is recovered');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('CRASH5_TURN_MARKER'), 'no loss: the pending content is digested');

  // The recovered run completes normally and releases the lock itself
  // (proves it is not stuck holding a takeover-recovered lock forever).
  const lockAfter = await fs.stat(lockdirPath).catch(() => null);
  assert.equal(lockAfter, null, 'lockdir released by this (recovered, completed) run');

  const cursor = await readCursor(vaultDir, project);
  assert.equal(cursor.file, '2026-01-01.md');
  assert.equal(cursor.offset, Buffer.byteLength(t1, 'utf8'));

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ===========================================================================
// I2 size-invariance property test (task-8-brief.md §2). Drives repeated
// doCheckpoint calls over a synthetic multi-day backlog whose TOTAL size
// exceeds the legacy 1MB MAX_TRANSCRIPT_BYTES cap (the exact ceiling this
// design replaces — spec §1) with a small chunk_max_bytes, and asserts every
// summarize input, across EVERY run, stayed within budget — and that the
// full corpus was eventually covered.
// ===========================================================================

test('I2 size-invariance: every summarize input stays <= chunk_max_bytes across a >1MB multi-day backlog and ALL runs; full corpus coverage', async () => {
  const vaultDir = await makeVault();
  const project = 'sizeinvariantproj';

  // Small relative to the 200_000 shipped default, comfortably above the
  // 1024 resolvePositiveInt usability floor.
  const CHUNK_MAX_BYTES = 32_768;
  // The transcript arg IS the whole budget here (a mocked summarizeFn never
  // concatenates a separate prompt onto it) — this allowance only guards
  // against a few bytes of test-fixture slop, not the invariant itself.
  const ALLOWANCE_BYTES = 8;

  const FILES = 3;
  const TURNS_PER_FILE = 1800;

  let totalBytes = 0;
  const turnMarkers = [];
  for (let f = 0; f < FILES; f += 1) {
    const day = `2026-02-${String(f + 1).padStart(2, '0')}.md`;
    let content = '';
    for (let i = 0; i < TURNS_PER_FILE; i += 1) {
      const marker = `T${f}_${i}`;
      turnMarkers.push(marker);
      const hh = String(i % 24).padStart(2, '0');
      const mm = String(i % 60).padStart(2, '0');
      const iso = `2026-02-${String(f + 1).padStart(2, '0')}T${hh}:${mm}:00.000Z`;
      content += makeTurn(iso, i % 2 === 0 ? 'user' : 'assistant', `MARK_${marker} ` + 'x'.repeat(200));
    }
    await seedCapture(vaultDir, project, day, content);
    totalBytes += Buffer.byteLength(content, 'utf8');
  }
  assert.ok(totalBytes > 1024 * 1024, `fixture must exceed the legacy 1MB cap to be meaningful, got ${totalBytes} bytes`);

  const allTranscripts = [];
  const summarizeFn = async (transcript) => {
    allTranscripts.push(transcript);
    return { summary: 'x', costUsd: 0.0001, tokensIn: 10, tokensOut: 5 };
  };

  let result;
  let runs = 0;
  const MAX_RUNS = 60; // safety cap — a hang/regression here must fail loudly, never hang the suite
  do {
    result = await doCheckpoint(
      { project },
      {
        config: { ...BASE_CONFIG, chunk_max_bytes: CHUNK_MAX_BYTES, max_chunks_per_run: 15 },
        vaultDir, summarizeFn, updateStateFn: makeUpdateStateFn(), reindexFn: async () => {},
      },
    );
    assert.equal(result.ok, true, `run #${runs} failed: ${JSON.stringify(result)}`);
    runs += 1;
    if (runs > MAX_RUNS) throw new Error(`backlog never drained after ${MAX_RUNS} runs — size-invariance regression`);
  } while (result.backlog_remaining);

  assert.ok(allTranscripts.length > FILES, 'the backlog must have required multiple chunks (proves chunking actually happened, not one giant transcript)');

  // I2, absolute, across EVERY run: no summarize input ever exceeded budget.
  for (const [i, t] of allTranscripts.entries()) {
    const len = Buffer.byteLength(t, 'utf8');
    assert.ok(len <= CHUNK_MAX_BYTES + ALLOWANCE_BYTES,
      `summarize call #${i} received ${len} bytes, exceeding chunk_max_bytes (${CHUNK_MAX_BYTES}) + allowance (${ALLOWANCE_BYTES}) — I2 VIOLATION`);
  }

  // Total digested coverage == corpus: every turn marker appears at least
  // once across the union of everything summarized this test (duplication
  // allowed across runs, loss never).
  const seen = new Set();
  const markerRe = /MARK_(\S+)/g;
  for (const t of allTranscripts) {
    for (const m of t.matchAll(markerRe)) seen.add(m[1]);
  }
  const missing = turnMarkers.filter((m) => !seen.has(m));
  assert.deepEqual(missing, [], `${missing.length} of ${turnMarkers.length} turns were never summarized — coverage gap`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ===========================================================================
// Micro-carry (task-8-brief.md §4, second bullet): golden-value pin for the
// deterministic summary-id hash inputs (spec §4.5 step 4:
// hash8(project|startFile|startOffset|endFile|endOffset)). The expected
// value below was computed ONCE, independently, from the CURRENT field
// order — via `sha256('goldenproj|2026-01-01.md|0|2026-01-01.md|100').hex
// .slice(0,8)` — NOT via a duplicated copy of checkpoint-chunk-txn.mjs's own
// algorithm (a duplicate would silently drift together with a production
// reorder and catch nothing). If deterministicSummaryId ever reorders,
// renames, or drops one of these five fields, the id it computes at runtime
// will differ from this pinned literal and the test fails loudly.
// ===========================================================================

test('golden-value pin: deterministic summary id = hash8(project|startFile|startOffset|endFile|endOffset) — an accidental hash-input reorder fails loudly', async () => {
  const vaultDir = await makeVault();
  const chunk = {
    text: 'golden pin content',
    turnCount: 1,
    startFile: '2026-01-01.md',
    startOffset: 0,
    endFile: '2026-01-01.md',
    endOffset: 100,
    boundary: 'turn',
    coversFrom: '2026-01-01T00:00:00.000Z',
    coversUntil: '2026-01-01T00:00:00.000Z',
  };

  const result = await runChunkTransaction(
    {
      vaultDir, project: 'goldenproj', chunk, prevCursor: null,
      config: BASE_CONFIG,
      chunkingCfg: { summarizeTimeoutMs: 5000, autosupersedeTimeoutMs: 5000, stateMergeTimeoutMs: 5000 },
      skipStateMerge: true,
    },
    {
      summarizeFn: async (t) => ({ summary: t, costUsd: 0, tokensIn: 1, tokensOut: 1 }),
      reindexFn: async () => {},
    },
  );

  assert.ok(result.committed, `expected a committed chunk, got: ${JSON.stringify(result)}`);
  assert.equal(result.committed.summaryId, 'session-2026-01-01-ec18f4df');

  await fs.rm(vaultDir, { recursive: true, force: true });
});
