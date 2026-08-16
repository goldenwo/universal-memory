// server/test/checkpoint-chunked.test.mjs — Task 6: doCheckpoint orchestration
// integration tests over the default (cursor-driven) chunked run loop
// (spec §4.5/§4.6/§4.7, docs/plans/2026-08-15-checkpoint-chunked-
// summarization-spec.md). Complements checkpoint.test.mjs's reconciled
// pinned suite (§8) — these are NEW integration pins the chunking rewrite
// introduces: cursor threading across chunks, summed run totals,
// backlog_remaining/chunk_cap semantics, raw_lock stop, the whole-run lock
// heartbeat, and thin_tail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { doCheckpoint } from '../lib/checkpoint.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

// ---- helpers (mirrors checkpoint.test.mjs's conventions) ------------------

function makeVault() {
  return tempDir('um-ck-chunked-');
}

async function seedCapture(vaultDir, project, filename, content) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, filename), content);
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
  // #185 gate OFF — these tests exercise chunk-loop orchestration mechanics,
  // not admission semantics (mirrors checkpoint.test.mjs's BASE_CONFIG).
  min_transcript_bytes: 0,
  min_transcript_turns: 0,
};

/** A real append-turn-shaped turn header + filler body. */
function makeTurn(iso, role, filler) {
  return `## ${iso} ${role}\n${filler}\n\n`;
}

async function readCursor(vaultDir, project) {
  const cursorPath = path.join(vaultDir, 'state', project, 'checkpoint-cursor.json');
  return JSON.parse(await fs.readFile(cursorPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Cursor threading (Task 5 carry #1 — "the carry-1 pin"): each chunk's
// prevCursor must be the PREVIOUS chunk's returned nextCursor. Falsified by
// asserting every committed chunk's summarizeFn saw DISTINCT, sequential
// content (if threading were broken — e.g. every chunk re-reading from the
// initial bootstrap cursor — every chunk would see the SAME first turn
// forever, and the run would never converge on 3 chunks with 3 distinct
// bodies). Cross-checked against the final persisted cursor on disk.
// ---------------------------------------------------------------------------

test('multi-chunk run: 3 turns -> 3 chunks, cursor threaded (carry-1 pin), summed cost/tokens', async () => {
  const vaultDir = await makeVault();
  // Filler sized so ONE turn's byte length clears checkpoint-config.mjs's
  // resolvePositiveInt `min:1024` floor for chunk_max_bytes (a smaller
  // configValue silently falls through to the 200_000 shipped default
  // instead of being accepted — see resolvePositiveInt's own doc comment).
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  const t2 = makeTurn('2026-01-01T00:00:02.000Z', 'assistant', 'b'.repeat(1000));
  const t3 = makeTurn('2026-01-01T00:00:03.000Z', 'user', 'c'.repeat(1000));
  await seedCapture(vaultDir, 'multiproj', '2026-01-01.md', t1 + t2 + t3);

  // Sized so exactly one turn fits per chunk, never two.
  const chunkMaxBytes = Math.max(
    Buffer.byteLength(t1, 'utf8'),
    Buffer.byteLength(t2, 'utf8'),
    Buffer.byteLength(t3, 'utf8'),
  ) + 20;

  const seenTranscripts = [];
  const summarizeFn = async (transcript) => {
    seenTranscripts.push(transcript);
    return { summary: `Summary ${seenTranscripts.length}`, costUsd: 0.001, tokensIn: 10, tokensOut: 5 };
  };
  const reindexCalls = [];

  const result = await doCheckpoint(
    { project: 'multiproj' },
    {
      config: { ...BASE_CONFIG, chunk_max_bytes: chunkMaxBytes, max_chunks_per_run: 5 },
      vaultDir,
      summarizeFn,
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async (relPath) => { reindexCalls.push(relPath); },
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 3, 'all 3 turns committed as 3 separate chunks');
  assert.equal(result.backlog_remaining, false, 'backlog fully drained within this run');
  assert.equal(result.stopped, undefined, 'no stop reason when the backlog is exhausted');
  assert.equal(result.truncated, undefined, 'the alias only appears when backlog remains');

  // Summed across all 3 committed chunks (§4.6).
  assert.ok(Math.abs(result.cost_usd - 0.003) < 1e-9, `cost_usd should sum to 0.003, got ${result.cost_usd}`);
  assert.equal(result.tokens_in, 30);
  assert.equal(result.tokens_out, 15);

  // Cursor threading, proven directly: each chunk's transcript is DISTINCT
  // and covers exactly its own turn, in order — impossible unless each
  // chunk's prevCursor really was the previous chunk's committed nextCursor.
  assert.equal(seenTranscripts.length, 3);
  assert.ok(seenTranscripts[0].includes('aaa') && !seenTranscripts[0].includes('bbb') && !seenTranscripts[0].includes('ccc'),
    `chunk 1 must cover only turn 1: ${seenTranscripts[0].slice(0, 60)}`);
  assert.ok(seenTranscripts[1].includes('bbb') && !seenTranscripts[1].includes('aaa') && !seenTranscripts[1].includes('ccc'),
    `chunk 2 must cover only turn 2: ${seenTranscripts[1].slice(0, 60)}`);
  assert.ok(seenTranscripts[2].includes('ccc') && !seenTranscripts[2].includes('aaa') && !seenTranscripts[2].includes('bbb'),
    `chunk 3 must cover only turn 3: ${seenTranscripts[2].slice(0, 60)}`);

  // Cross-check: the persisted cursor after the run reflects the LAST
  // chunk's watermark (turn 3's ISO), not the first chunk's.
  const cursor = await readCursor(vaultDir, 'multiproj');
  assert.equal(cursor.last_turn_iso, '2026-01-01T00:00:03.000Z');

  // 3 distinct summary docs on disk, 3 reindex calls.
  assert.equal(reindexCalls.length, 3);
  assert.equal(new Set(reindexCalls).size, 3, 'each committed chunk mints a distinct summary path');
  const sessionFiles = await fs.readdir(path.join(vaultDir, 'sessions', 'multiproj'));
  assert.equal(sessionFiles.length, 3);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Task-6 review round 2 MINOR 10: the test above uses MONOTONICALLY
// increasing turn ISOs across chunks, so its final persisted last_turn_iso
// would come out correct even if prevCursor threading were completely
// broken (chunk N's own coversUntil is already the run's running max
// regardless of what prevCursor contributed) — it doesn't actually
// distinguish threaded from unthreaded. This fixture uses two turns with
// NON-MONOTONIC client-supplied ISOs across chunk boundaries (turn 1 is
// LATER than turn 2 — legal; turn timestamps are client-supplied and
// non-monotonic, spec §4.1/§4.2) so the two behaviors diverge: correctly
// threaded, chunk 2's txn call receives chunk 1's real committed nextCursor
// (last_turn_iso = turn 1's LATER iso) and maxIso keeps it (no regression);
// unthreaded (e.g. every chunk call reusing the initial/null prevCursor),
// chunk 2's txn would compute maxIso(null, turn2's EARLIER iso) and
// WRONGLY persist the earlier watermark — a regression §4.1's max-persist
// rule exists specifically to forbid.
test('cursor threading (non-monotonic fixture): persisted last_turn_iso does not regress across chunks — the pin the monotone fixture above cannot make', async () => {
  const vaultDir = await makeVault();
  const t1 = makeTurn('2026-01-01T12:00:00.000Z', 'user', 'a'.repeat(1000)); // LATER iso, positionally first
  const t2 = makeTurn('2026-01-01T06:00:00.000Z', 'assistant', 'b'.repeat(1000)); // EARLIER iso, positionally second
  await seedCapture(vaultDir, 'nonmonoproj', '2026-01-01.md', t1 + t2);

  const chunkMaxBytes = Math.max(Buffer.byteLength(t1, 'utf8'), Buffer.byteLength(t2, 'utf8')) + 20;

  const result = await doCheckpoint(
    { project: 'nonmonoproj' },
    {
      config: { ...BASE_CONFIG, chunk_max_bytes: chunkMaxBytes, max_chunks_per_run: 5 },
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 2, 'both turns committed as 2 separate chunks');

  const cursor = await readCursor(vaultDir, 'nonmonoproj');
  assert.equal(cursor.last_turn_iso, '2026-01-01T12:00:00.000Z',
    `last_turn_iso must stay at turn 1's LATER watermark, not regress to turn 2's earlier one (got ${cursor.last_turn_iso}) — proves chunk 2's txn call actually received chunk 1's committed nextCursor as prevCursor`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// chunk_cap: max_chunks_per_run reached with backlog left pending.
// ---------------------------------------------------------------------------

test('chunk_cap: max_chunks_per_run reached with backlog left -> stopped:chunk_cap, backlog_remaining:true', async () => {
  const vaultDir = await makeVault();
  // Filler sized above the resolvePositiveInt `min:1024` floor for
  // chunk_max_bytes — see the multi-chunk test above for the full rationale.
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  const t2 = makeTurn('2026-01-01T00:00:02.000Z', 'assistant', 'b'.repeat(1000));
  const t3 = makeTurn('2026-01-01T00:00:03.000Z', 'user', 'c'.repeat(1000));
  await seedCapture(vaultDir, 'capproj', '2026-01-01.md', t1 + t2 + t3);

  const chunkMaxBytes = Math.max(
    Buffer.byteLength(t1, 'utf8'), Buffer.byteLength(t2, 'utf8'), Buffer.byteLength(t3, 'utf8'),
  ) + 20;

  const result = await doCheckpoint(
    { project: 'capproj' },
    {
      config: { ...BASE_CONFIG, chunk_max_bytes: chunkMaxBytes, max_chunks_per_run: 2 }, // 3 turns pending, only 2 allowed
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.chunks_done, 2);
  assert.equal(result.backlog_remaining, true);
  assert.equal(result.stopped?.reason, 'chunk_cap');
  assert.equal(result.truncated, true);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

test('chunk_cap: exact-fit finish (max_chunks_per_run matches remaining backlog exactly) -> no stopped reason', async () => {
  const vaultDir = await makeVault();
  // Filler sized above the resolvePositiveInt `min:1024` floor for
  // chunk_max_bytes — see the multi-chunk test above for the full rationale.
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  const t2 = makeTurn('2026-01-01T00:00:02.000Z', 'assistant', 'b'.repeat(1000));
  await seedCapture(vaultDir, 'exactfitproj', '2026-01-01.md', t1 + t2);

  const chunkMaxBytes = Math.max(Buffer.byteLength(t1, 'utf8'), Buffer.byteLength(t2, 'utf8')) + 20;

  const result = await doCheckpoint(
    { project: 'exactfitproj' },
    {
      config: { ...BASE_CONFIG, chunk_max_bytes: chunkMaxBytes, max_chunks_per_run: 2 }, // exactly 2 turns, 2 allowed
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.chunks_done, 2);
  assert.equal(result.backlog_remaining, false, 'the cap was hit but nothing is actually left pending');
  assert.equal(result.stopped, undefined, 'chunk_cap is reported only when more backlog is pending (spec §4.6)');
  assert.equal(result.truncated, undefined);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Final whole-branch review MINOR 3: the post-loop PEEK (used only to
// distinguish exact-fit finish from real remaining backlog) must not
// flatten every non-exhausted peek result into 'chunk_cap' — when the peek
// itself lands on a genuinely locked next file, the more specific
// 'raw_lock' reason must pass through instead (the drain script, spec §5,
// branches on this exact value: chunk_cap continues immediately, raw_lock
// waits 30s first). max_chunks_per_run:1 forces the loop to stop after
// committing file1's single chunk, so the ONLY way `stopped` gets set here
// is via the peek — never the main loop's own raw_lock branch.
test('chunk_cap peek: cap reached AND the peeked next file is genuinely locked -> stopped:raw_lock, not chunk_cap (real lock contention, ~5s)', async () => {
  const vaultDir = await makeVault();
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  await seedCapture(vaultDir, 'peekrawlockproj', '2026-01-01.md', t1);
  // Second file must exist (so the peek's walk actually reaches it after
  // file1 is fully drained) and be genuinely, freshly locked.
  await seedCapture(vaultDir, 'peekrawlockproj', '2026-01-02.md', '# never read\n');
  const file2Lockdir = path.join(vaultDir, 'captures', 'peekrawlockproj', 'raw', '2026-01-02.md.lockdir');
  await fs.mkdir(file2Lockdir, { recursive: true });

  const result = await doCheckpoint(
    { project: 'peekrawlockproj' },
    {
      config: { ...BASE_CONFIG, max_chunks_per_run: 1 }, // exactly 1 chunk (file1) — the loop itself never sees raw_lock
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'file1 still committed before the cap was reached');
  assert.equal(result.backlog_remaining, true);
  assert.equal(result.stopped?.reason, 'raw_lock', `the peek hit a genuinely locked file — must report raw_lock, not chunk_cap; got: ${JSON.stringify(result.stopped)}`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// thin_tail: a thin trailing chunk AFTER >=1 committed chunk is a success
// with thin_tail:true — never the abstention envelope (spec §4.5.2).
// ---------------------------------------------------------------------------

test('thin_tail: a thin trailing chunk after 1 committed chunk -> success with thin_tail:true, backlog_remaining:false', async () => {
  const vaultDir = await makeVault();
  // t1's filler is both (a) above the #185 bytes floor alone (turnCount is
  // only 1 < the turns floor of 2, but bytes-floor clearance alone already
  // breaks the AND-composed gate) and (b) above resolvePositiveInt's
  // `min:1024` floor for chunk_max_bytes once chunkMaxBytes below adds
  // headroom (see the multi-chunk test above for that rationale).
  const t1 = makeTurn('2026-01-01T00:00:01.000Z', 'user', 'a'.repeat(1000));
  const t2 = makeTurn('2026-01-01T00:00:02.000Z', 'assistant', 'hi'); // well under the bytes floor, 1 turn
  await seedCapture(vaultDir, 'thintailproj', '2026-01-01.md', t1 + t2);

  // chunk_max_bytes sized so t1 alone fills a chunk, forcing t2 into its own
  // (thin) trailing chunk.
  const chunkMaxBytes = Buffer.byteLength(t1, 'utf8') + 20;

  const gatedConfig = {
    ...BASE_CONFIG,
    chunk_max_bytes: chunkMaxBytes,
    max_chunks_per_run: 5,
    min_transcript_bytes: 500,
    min_transcript_turns: 2,
  };

  const result = await doCheckpoint(
    { project: 'thintailproj' },
    {
      config: gatedConfig,
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.chunks_done, 1, 'only the first (non-thin) chunk actually committed');
  assert.equal(result.thin_tail, true);
  assert.equal(result.backlog_remaining, false, 'thin_tail never reports more backlog — the tail digests once it grows');
  assert.equal(result.skipped, undefined, 'thin_tail must never be the abstention envelope');
  assert.ok(result.summary_id, 'summary_id still reflects the LAST *committed* chunk (chunk 1), not the thin tail');

  // The cursor must NOT have advanced past the thin tail — it still sits at
  // the boundary after chunk 1, so the tail is re-digested once it grows.
  const cursor = await readCursor(vaultDir, 'thintailproj');
  assert.equal(cursor.last_turn_iso, '2026-01-01T00:00:01.000Z', 'cursor must reflect chunk 1 only, not the thin tail');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// raw_lock stop: a genuinely held (real, fresh) lockdir on the NEXT pending
// raw file stops the run there — no-skip-ahead (I3). Real filesystem lock
// contention, ~5s (RAW_LOCK_TIMEOUT_MS) — see the comment on the test itself.
// ---------------------------------------------------------------------------

test('raw_lock: a genuinely locked next file stops the run — backlog_remaining:true, stopped:raw_lock (real lock contention, ~5s)', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'rawlockproj', '2026-01-01.md', '# Session\nfile one, unlocked, commits fine.');
  await seedCapture(vaultDir, 'rawlockproj', '2026-01-02.md', '# Session\nfile two, never actually read.');

  // Pre-create a REAL, FRESH lockdir on file two. A fresh mtime means
  // acquireLockdir's stale-recovery path never fires (it only recovers a
  // lock whose mtime is older than the stale threshold) — this makes the
  // contention genuine: the run polls for the full RAW_LOCK_TIMEOUT_MS
  // (5s) before chunk-builder reports raw_lock, exactly as it would against
  // a live concurrent session holding that file's lock.
  const file2Lockdir = path.join(vaultDir, 'captures', 'rawlockproj', 'raw', '2026-01-02.md.lockdir');
  await fs.mkdir(file2Lockdir, { recursive: true });

  const result = await doCheckpoint(
    { project: 'rawlockproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `raw_lock stop is a success envelope, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'the unlocked first file still commits its own chunk');
  assert.equal(result.backlog_remaining, true);
  assert.equal(result.stopped?.reason, 'raw_lock', `expected raw_lock, got: ${JSON.stringify(result.stopped)}`);
  assert.equal(result.truncated, true);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Task-6 review round 2 finding: a raw-lock-stopped SUB-FLOOR chunk must
// never be classified as "complete" (thin_tail or abstention) — the builder
// stopped because the NEXT file is transiently locked, not because nothing
// more exists (spec §4.4: "only a TRUE end-of-corpus tail can ever be
// thin"). Both directions, both real (fresh) lockdir contention, ~5s each.

test('raw_lock + thin MID-RUN: chunk 1 commits, chunk 2 is sub-floor + next file locked -> backlog_remaining:true, stopped:raw_lock, NOT thin_tail', async () => {
  const vaultDir = await makeVault();
  // file1: big enough to be its own committed (non-thin) chunk.
  const t1 = makeTurn('2026-01-01T00:00:00.000Z', 'user', 'a'.repeat(1000));
  await seedCapture(vaultDir, 'midrawlockthinproj', '2026-01-01.md', t1);
  // file2: sub-floor on its own (well under the 500-byte / 2-turn gate).
  await seedCapture(vaultDir, 'midrawlockthinproj', '2026-01-02.md', makeTurn('2026-01-02T00:00:00.000Z', 'user', 'short'));
  // file3: must exist (so chunk-builder's walk reaches it after draining
  // file2) and be genuinely, freshly locked.
  await seedCapture(vaultDir, 'midrawlockthinproj', '2026-01-03.md', '# never read\n');

  const file3Lockdir = path.join(vaultDir, 'captures', 'midrawlockthinproj', 'raw', '2026-01-03.md.lockdir');
  await fs.mkdir(file3Lockdir, { recursive: true });

  // Sized so file1's turn alone fills a chunk (chunk 1 ends exactly at
  // file1's EOF, boundary:'turn') — file1 + file2's short turn together
  // would exceed it, so chunk 2 starts fresh at file2.
  const chunkMaxBytes = Buffer.byteLength(t1, 'utf8') + 20;

  const gatedConfig = {
    ...BASE_CONFIG,
    chunk_max_bytes: chunkMaxBytes,
    max_chunks_per_run: 5,
    min_transcript_bytes: 500,
    min_transcript_turns: 2,
  };

  const result = await doCheckpoint(
    { project: 'midrawlockthinproj' },
    {
      config: gatedConfig,
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 1, 'only file1 committed — the sub-floor file2 chunk never commits (thin, cursor untouched)');
  assert.equal(result.backlog_remaining, true, 'file3 is still pending behind the lock — this must never read as complete');
  assert.equal(result.stopped?.reason, 'raw_lock', `expected raw_lock (transient), got: ${JSON.stringify(result.stopped)}`);
  assert.equal(result.thin_tail, undefined, 'must NOT be thin_tail — that would falsely signal "nothing more to digest"');
  assert.equal(result.skipped, undefined, 'must not be the abstention envelope either');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

test('raw_lock + thin FIRST-CHUNK: sub-floor chunk + locked next file -> chunks_done:0, backlog_remaining:true, stopped:raw_lock, NOT abstention', async () => {
  const vaultDir = await makeVault();
  // file1: sub-floor on its own — this is the ONLY chunk this run ever
  // attempts (chunksDone stays 0 going into the thin check).
  await seedCapture(vaultDir, 'firstrawlockthinproj', '2026-01-01.md', makeTurn('2026-01-01T00:00:00.000Z', 'user', 'short'));
  // file2: must exist and be genuinely, freshly locked.
  await seedCapture(vaultDir, 'firstrawlockthinproj', '2026-01-02.md', '# never read\n');

  const file2Lockdir = path.join(vaultDir, 'captures', 'firstrawlockthinproj', 'raw', '2026-01-02.md.lockdir');
  await fs.mkdir(file2Lockdir, { recursive: true });

  const gatedConfig = {
    ...BASE_CONFIG,
    min_transcript_bytes: 500,
    min_transcript_turns: 2,
  };

  const result = await doCheckpoint(
    { project: 'firstrawlockthinproj' },
    {
      config: gatedConfig,
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, `expected ok:true (success-shaped, not an error), got: ${JSON.stringify(result)}`);
  assert.equal(result.chunks_done, 0, 'nothing committed — file1 alone is sub-floor');
  assert.equal(result.backlog_remaining, true, 'file2 is still pending behind the lock — this must never read as complete');
  assert.equal(result.stopped?.reason, 'raw_lock', `expected raw_lock (transient), got: ${JSON.stringify(result.stopped)}`);
  assert.equal(result.skipped, undefined, 'must NOT be the abstention envelope — that would tell the drain "nothing digestible pending" (§5), which is false: file2 is pending, just transiently locked');
  assert.equal(result.summary_id, null, 'no chunk was ever committed');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Heartbeat: the whole-run lockdir's mtime is refreshed while a slow chunk
// runs, and the timer is cleared on completion (spec §4.5).
// ---------------------------------------------------------------------------

test('heartbeat: lockdir mtime advances while a slow summarize runs, and stops advancing after completion', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'heartbeatproj', '2026-01-01.md', '# Session\nHeartbeat probe.');

  const lockdirPath = path.join(vaultDir, 'state', 'heartbeatproj', 'state.md.lockdir');

  let releaseSlow;
  const gate = new Promise((res) => { releaseSlow = res; });
  let sawAdvance = false;

  const checkpointPromise = doCheckpoint(
    { project: 'heartbeatproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      heartbeatIntervalMs: 40, // short injected interval (§4.5's ctx.heartbeatIntervalMs DI seam)
      summarizeFn: async () => {
        const before = (await fs.stat(lockdirPath)).mtimeMs;
        // Poll for a visible mtime advance while "slow work" holds the lock —
        // bounded wait so a broken heartbeat fails the test instead of hanging.
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 20));
          const now = (await fs.stat(lockdirPath)).mtimeMs;
          if (now > before) { sawAdvance = true; break; }
        }
        releaseSlow();
        return { summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 };
      },
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  await gate; // summarize has returned its result and signaled
  const result = await checkpointPromise;

  assert.equal(result.ok, true, `expected ok:true, got: ${JSON.stringify(result)}`);
  assert.ok(sawAdvance, 'lockdir mtime must advance at least once while the slow chunk runs (heartbeat live)');

  // Cleared on completion: the lockdir itself is released (rmdir'd) by the
  // same finally that clears the heartbeat timer — its absence is the
  // strongest available proof the interval was torn down (a leaked timer
  // refreshing a deleted path would throw ENOENT on every tick, caught and
  // warned, never visible from here — so we assert the release itself,
  // which the SAME finally block performs).
  const stat = await fs.stat(lockdirPath).catch(() => null);
  assert.equal(stat, null, 'lockdir must be released after the run completes');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Abstention envelope byte-compat on a fresh (never-checkpointed) thin
// project — dedicated smoke check alongside checkpoint.test.mjs's own #185
// "no captures dir" pin, using a THIN-BUT-PRESENT fixture this time (the
// generic "exhausted with zero pending files" case is covered there).
// ---------------------------------------------------------------------------

test('abstention envelope byte-compat: a thin-but-present chunk on a fresh project reads exactly like the legacy envelope', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'freshthinproj', '2026-01-01.md', 'too small');

  const result = await doCheckpoint(
    { project: 'freshthinproj' },
    {
      config: { ...BASE_CONFIG, min_transcript_bytes: 500, min_transcript_turns: 2 },
      vaultDir,
      summarizeFn: async () => ({ summary: 'x', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.skipped, 'thin_transcript');
  assert.equal(result.transcript_bytes, 'too small'.length);
  assert.equal(result.transcript_turns, 0);
  assert.equal(result.summary_id, undefined, 'abstention never carries a summary_id');
  assert.equal(result.chunks_done, undefined, 'abstention keeps the legacy shape — no chunked-mode fields');
  assert.equal(result.backlog_remaining, undefined);

  // Cursor must be untouched by an abstention (no cursor file written yet —
  // the whole pending window is thin, nothing was ever committed).
  const cursorPath = path.join(vaultDir, 'state', 'freshthinproj', 'checkpoint-cursor.json');
  const cursorFile = await fs.stat(cursorPath).catch(() => null);
  assert.equal(cursorFile, null, 'thin-on-first-chunk must never advance (or create) the cursor');

  await fs.rm(vaultDir, { recursive: true, force: true });
});
