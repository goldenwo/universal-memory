// server/test/chunk-builder.test.mjs — boundary-math tests for
// server/lib/chunk-builder.mjs (Task 4, docs/plans/2026-08-15-checkpoint-
// chunked-summarization-plan). This module feeds the cursor — the arc's
// catastrophic-class surface (§4.1-4.4 of docs/plans/2026-08-15-checkpoint-
// chunked-summarization-spec.md). The byte-exact concatenation sweep test
// (resume section below) is the heart of this file: no byte read twice, none
// skipped, for any walk shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers/tmpdir.mjs';
import { buildNextChunk } from '../lib/chunk-builder.mjs';

const PROJECT = 'chunk-builder-test-proj';

function makeVault() {
  return tempDir('um-chunk-builder-test-');
}

function rawDir(vault, project = PROJECT) {
  return path.join(vault, 'captures', project, 'raw');
}

async function writeRawFile(vault, filename, content, project = PROJECT) {
  const dir = rawDir(vault, project);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await fs.writeFile(p, content, 'utf8');
  return p;
}

/** Write raw BYTES (not a utf8-encoded string) — for constructing invalid-UTF-8 fixtures directly. */
async function writeRawFileBytes(vault, filename, buffer, project = PROJECT) {
  const dir = rawDir(vault, project);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await fs.writeFile(p, buffer);
  return p;
}

function turnHeader(iso, role) {
  return `## ${iso} ${role}`;
}

function turn(iso, role, body) {
  return `${turnHeader(iso, role)}\n${body}\n\n`;
}

// Injected no-op lock pair — always succeeds, never actually locks anything
// (chunk-builder trusts the DI seam; real acquireLockdir/releaseLockdir are
// wired by the caller per the brief).
const NOOP_LOCK = {
  acquireLock: async () => true,
  releaseLock: async () => {},
};

/** Lock stub: fails acquireLock for any file whose basename is in `failFiles`. */
function lockThatFails(failFiles) {
  const fail = new Set(failFiles);
  return {
    acquireLock: async (lockdirPath) => !fail.has(path.basename(lockdirPath, '.lockdir')),
    releaseLock: async () => {},
  };
}

function freshCursor(file, overrides = {}) {
  return {
    file,
    offset: 0,
    boundary: 'turn',
    last_turn_iso: null,
    last_summary_id: null,
    ...overrides,
  };
}

// ===========================================================================
// Section A — basic accumulation.
// ===========================================================================

test('basic: single small file -> one chunk, then exhausted', async () => {
  const vault = makeVault();
  const content = turn('2026-08-10T00:00:00.000Z', 'user', 'hi') +
    turn('2026-08-10T00:01:00.000Z', 'assistant', 'hello');
  await writeRawFile(vault, '2026-08-10.md', content);

  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });

  assert.ok(result.chunk, 'expected a chunk');
  assert.equal(result.chunk.text, content);
  assert.equal(result.chunk.turnCount, 2);
  assert.equal(result.chunk.startFile, '2026-08-10.md');
  assert.equal(result.chunk.startOffset, 0);
  assert.equal(result.chunk.endFile, '2026-08-10.md');
  assert.equal(result.chunk.endOffset, Buffer.byteLength(content, 'utf8'));
  assert.equal(result.chunk.boundary, 'turn');
  assert.equal(result.chunk.coversFrom, '2026-08-10T00:00:00.000Z');
  assert.equal(result.chunk.coversUntil, '2026-08-10T00:01:00.000Z');
  assert.deepEqual(result.nextCursor, {
    file: '2026-08-10.md',
    offset: Buffer.byteLength(content, 'utf8'),
    boundary: 'turn',
    last_turn_iso: '2026-08-10T00:01:00.000Z',
    last_summary_id: null,
  });

  const second = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor: result.nextCursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });
  assert.deepEqual(second, { exhausted: true });
});

test('basic: multi-turn accumulation stops before exceeding chunkMaxBytes (overflowing turn excluded)', async () => {
  const vault = makeVault();
  const t1 = turn('2026-08-10T00:00:00.000Z', 'user', 'a'.repeat(50));
  const t2 = turn('2026-08-10T00:01:00.000Z', 'assistant', 'b'.repeat(50));
  const t3 = turn('2026-08-10T00:02:00.000Z', 'user', 'c'.repeat(50)); // would overflow
  const content = t1 + t2 + t3;
  await writeRawFile(vault, '2026-08-10.md', content);

  const budget = Buffer.byteLength(t1 + t2, 'utf8'); // exactly enough for t1+t2, not t3
  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: budget, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.text, t1 + t2);
  assert.equal(result.chunk.turnCount, 2);
  assert.equal(result.chunk.boundary, 'turn');
  assert.equal(result.chunk.endOffset, Buffer.byteLength(t1 + t2, 'utf8'));
  assert.ok(!result.chunk.text.includes('ccccc'), 't3 must not be included');

  // Second call picks up exactly t3.
  const second = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor: result.nextCursor, chunkMaxBytes: budget, ...NOOP_LOCK,
  });
  assert.equal(second.chunk.text, t3);
  assert.equal(second.chunk.turnCount, 1);
});

test('exhausted: no raw files at all', async () => {
  const vault = makeVault();
  await fs.mkdir(rawDir(vault), { recursive: true });
  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });
  assert.deepEqual(result, { exhausted: true });
});

test('exhausted: cursor.file does not exist and no newer file either', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-01.md', turn('2026-08-01T00:00:00.000Z', 'user', 'old'));
  const cursor = freshCursor('2026-08-10.md'); // named file never written, nothing newer
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });
  assert.deepEqual(result, { exhausted: true });
});

// ===========================================================================
// Section B — spanning file boundaries.
// ===========================================================================

test('spanning: chunk crosses a file boundary; nextCursor lands in the second file', async () => {
  const vault = makeVault();
  const dayA = turn('2026-08-10T23:00:00.000Z', 'user', 'end of day A');
  const dayB1 = turn('2026-08-11T00:00:00.000Z', 'assistant', 'start of day B');
  const dayB2 = turn('2026-08-11T00:05:00.000Z', 'user', 'more of day B');
  await writeRawFile(vault, '2026-08-10.md', dayA);
  await writeRawFile(vault, '2026-08-11.md', dayB1 + dayB2);

  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.text, dayA + dayB1 + dayB2);
  assert.equal(result.chunk.turnCount, 3);
  assert.equal(result.chunk.startFile, '2026-08-10.md');
  assert.equal(result.chunk.startOffset, 0);
  assert.equal(result.chunk.endFile, '2026-08-11.md');
  assert.equal(result.chunk.endOffset, Buffer.byteLength(dayB1 + dayB2, 'utf8'));
  assert.equal(result.chunk.coversFrom, '2026-08-10T23:00:00.000Z');
  assert.equal(result.chunk.coversUntil, '2026-08-11T00:05:00.000Z');
});

test('spanning: budget stops exactly at end of first file, nextCursor.file is the SECOND file, offset 0', async () => {
  const vault = makeVault();
  const dayA = turn('2026-08-10T23:00:00.000Z', 'user', 'end of day A');
  const dayB = turn('2026-08-11T00:00:00.000Z', 'assistant', 'day B');
  await writeRawFile(vault, '2026-08-10.md', dayA);
  await writeRawFile(vault, '2026-08-11.md', dayB);

  const budget = Buffer.byteLength(dayA, 'utf8'); // exactly dayA, nothing more
  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: budget, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.text, dayA);
  assert.equal(result.chunk.endFile, '2026-08-10.md');
  assert.equal(result.nextCursor.file, '2026-08-10.md');
  assert.equal(result.nextCursor.offset, Buffer.byteLength(dayA, 'utf8'));

  const second = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor: result.nextCursor, chunkMaxBytes: budget, ...NOOP_LOCK,
  });
  assert.equal(second.chunk.text, dayB);
  assert.equal(second.chunk.startFile, '2026-08-11.md');
  assert.equal(second.chunk.startOffset, 0);
});

// ===========================================================================
// Section C — resume / byte-exact concatenation sweep (THE I1/I2 test).
// ===========================================================================

test('resume: build -> advance cursor -> build again -> second chunk starts exactly at endOffset', async () => {
  const vault = makeVault();
  // Same role on both turns so their header-line lengths match exactly —
  // otherwise a budget sized to t1 could be too small for t2 (e.g. "user"
  // vs "assistant"), which would trigger an unrelated hard-split.
  const t1 = turn('2026-08-10T00:00:00.000Z', 'user', 'one');
  const t2 = turn('2026-08-10T00:01:00.000Z', 'user', 'two');
  await writeRawFile(vault, '2026-08-10.md', t1 + t2);

  const budget = Buffer.byteLength(t1, 'utf8');
  assert.equal(budget, Buffer.byteLength(t2, 'utf8'), 'test fixture sanity: t1 and t2 must be same byte length');
  const cursor = freshCursor('2026-08-10.md');
  const first = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: budget, ...NOOP_LOCK,
  });
  assert.equal(first.chunk.text, t1);
  assert.equal(first.nextCursor.offset, Buffer.byteLength(t1, 'utf8'));

  const second = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor: first.nextCursor, chunkMaxBytes: budget, ...NOOP_LOCK,
  });
  assert.equal(second.chunk.startFile, '2026-08-10.md');
  assert.equal(second.chunk.startOffset, first.nextCursor.offset);
  assert.equal(second.chunk.text, t2);
});

test('sweep: concatenating every chunk over a multi-file, multi-turn walk reproduces the full corpus byte-exact', async () => {
  const vault = makeVault();
  const files = {
    '2026-08-10.md':
      turn('2026-08-10T10:00:00.000Z', 'user', 'x'.repeat(37)) +
      turn('2026-08-10T10:05:00.000Z', 'assistant', 'y'.repeat(61)) +
      turn('2026-08-10T10:10:00.000Z', 'user', 'z'.repeat(19)),
    '2026-08-11.md':
      turn('2026-08-11T00:00:00.000Z', 'assistant', 'p'.repeat(83)) +
      turn('2026-08-11T00:30:00.000Z', 'user', 'q'.repeat(5)),
    '2026-08-12.md':
      turn('2026-08-12T05:00:00.000Z', 'user', 'm'.repeat(101)),
  };
  for (const [name, content] of Object.entries(files)) {
    await writeRawFile(vault, name, content);
  }
  const fullCorpus = Object.values(files).join('');

  let cursor = freshCursor('2026-08-10.md');
  let assembled = '';
  const chunkMaxBytes = 40; // deliberately small: forces many chunks, some spanning files
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 200, 'runaway loop — position not advancing');
    const result = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
    });
    if (result.exhausted) break;
    assert.ok(result.chunk.text.length > 0, 'every produced chunk must be non-empty (guaranteed progress)');
    assembled += result.chunk.text;
    cursor = result.nextCursor;
  }
  assert.equal(assembled, fullCorpus);
});

// ===========================================================================
// Section D — guaranteed progress / hard-split (oversized single turn).
// ===========================================================================

test('oversized single turn: split at newline, chunk <= chunkMaxBytes, boundary split, next chunk resumes mid-turn', async () => {
  const vault = makeVault();
  const bodyLines = Array.from({ length: 20 }, (_, i) => `line ${i} ${'w'.repeat(10)}`).join('\n');
  const big = turn('2026-08-10T00:00:00.000Z', 'user', bodyLines);
  await writeRawFile(vault, '2026-08-10.md', big);

  const chunkMaxBytes = 100; // smaller than the whole turn
  const cursor = freshCursor('2026-08-10.md');
  const first = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
  });

  assert.ok(Buffer.byteLength(first.chunk.text, 'utf8') <= chunkMaxBytes, 'chunk must never exceed chunkMaxBytes');
  assert.equal(first.chunk.boundary, 'split');
  assert.equal(first.chunk.turnCount, 1);
  assert.equal(first.chunk.coversFrom, '2026-08-10T00:00:00.000Z');
  assert.equal(first.chunk.coversUntil, '2026-08-10T00:00:00.000Z');
  assert.ok(first.chunk.text.endsWith('\n'), 'hard split at newline should land right after a newline');
  assert.equal(first.nextCursor.boundary, 'split');
  assert.equal(first.nextCursor.last_turn_iso, '2026-08-10T00:00:00.000Z');
  assert.ok(first.nextCursor.offset > 0, 'guaranteed progress: offset must advance');
  assert.ok(first.nextCursor.offset < Buffer.byteLength(big, 'utf8'), 'must not consume the whole turn in one split');

  // Concatenation sweep for this specific oversized-turn case.
  let cursor2 = cursor;
  let assembled = '';
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 200);
    const result = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor: cursor2, chunkMaxBytes, ...NOOP_LOCK,
    });
    if (result.exhausted) break;
    assert.ok(Buffer.byteLength(result.chunk.text, 'utf8') <= chunkMaxBytes);
    assembled += result.chunk.text;
    cursor2 = result.nextCursor;
  }
  assert.equal(assembled, big);
});

test('oversized single turn: guaranteed progress even with no newline within budget (falls back further, still > 0 bytes)', async () => {
  const vault = makeVault();
  // No newlines anywhere in the body until the very end.
  const big = turn('2026-08-10T00:00:00.000Z', 'user', 'a'.repeat(500));
  await writeRawFile(vault, '2026-08-10.md', big);

  const chunkMaxBytes = 50;
  const cursor = freshCursor('2026-08-10.md');
  const first = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
  });
  assert.ok(Buffer.byteLength(first.chunk.text, 'utf8') <= chunkMaxBytes);
  assert.ok(first.nextCursor.offset > 0, 'must make progress even with no newline in range');
  assert.equal(first.chunk.boundary, 'split');
});

// ===========================================================================
// Section E — UTF-8 split boundary (multi-byte chars straddling the cut).
// ===========================================================================

test('UTF-8: oversized turn whose byte limit falls mid-codepoint -> split backs off, no broken codepoint, concatenation byte-exact', async () => {
  const vault = makeVault();
  // No newlines at all, and multi-byte emoji (4 bytes each in UTF-8) packed
  // densely so a naive byte-N cut is very likely to land mid-codepoint.
  const body = '💎'.repeat(80); // 4 bytes/char * 80 = 320 bytes, no newlines
  const big = turn('2026-08-10T00:00:00.000Z', 'user', body);
  await writeRawFile(vault, '2026-08-10.md', big);
  const totalBytes = Buffer.byteLength(big, 'utf8');

  const chunkMaxBytes = 53; // arbitrary, not a multiple of 4 -> forces mid-codepoint math
  let cursor = freshCursor('2026-08-10.md');
  let assembled = '';
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 200);
    const result = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
    });
    if (result.exhausted) break;
    const buf = Buffer.from(result.chunk.text, 'utf8');
    assert.ok(buf.length <= chunkMaxBytes, 'chunk must never exceed chunkMaxBytes');
    // Round-trip clean: no U+FFFD replacement character from a broken split.
    assert.ok(!result.chunk.text.includes('�'), 'chunk must not contain a broken codepoint');
    assembled += result.chunk.text;
    cursor = result.nextCursor;
  }
  assert.equal(assembled, big);
  assert.equal(Buffer.byteLength(assembled, 'utf8'), totalBytes);
});

// ===========================================================================
// Section F — legacy header-less blob.
// ===========================================================================

test('legacy blob: file with no headers -> one blob chunk; covers_* = file date UTC midnight', async () => {
  const vault = makeVault();
  const content = 'this is a pre-migration raw file with no turn headers at all.\njust prose.\n';
  await writeRawFile(vault, '2026-07-01.md', content);

  const cursor = freshCursor('2026-07-01.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.text, content);
  assert.equal(result.chunk.turnCount, 0);
  assert.equal(result.chunk.boundary, 'turn'); // ends cleanly at EOF
  assert.equal(result.chunk.coversFrom, '2026-07-01T00:00:00.000Z');
  assert.equal(result.chunk.coversUntil, '2026-07-01T00:00:00.000Z');
  assert.equal(result.nextCursor.last_turn_iso, '2026-07-01T00:00:00.000Z');
});

test('legacy blob: oversized blob splits at chunkMaxBytes; both pieces carry the same file-date-midnight ISO', async () => {
  const vault = makeVault();
  const content = 'no headers here.\n'.repeat(20); // no ## header anywhere
  await writeRawFile(vault, '2026-07-02.md', content);

  const chunkMaxBytes = 50;
  let cursor = freshCursor('2026-07-02.md');
  let assembled = '';
  let guard = 0;
  const expectedIso = '2026-07-02T00:00:00.000Z';
  for (;;) {
    guard += 1;
    assert.ok(guard < 200);
    const result = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
    });
    if (result.exhausted) break;
    assert.ok(Buffer.byteLength(result.chunk.text, 'utf8') <= chunkMaxBytes);
    assert.equal(result.chunk.coversFrom, expectedIso);
    assert.equal(result.chunk.coversUntil, expectedIso);
    assembled += result.chunk.text;
    cursor = result.nextCursor;
  }
  assert.equal(assembled, content);
});

// ===========================================================================
// Section G — split-resume covers_from seeding.
// ===========================================================================

test('split-resume seeding: cursor boundary "split" with last_turn_iso X -> continuation chunk covers_from == X, not the next header', async () => {
  const vault = makeVault();
  // Simulate a resume: file whose content from offset 0 has NO header (this
  // is the "below the resume point" continuation of a turn already consumed
  // in an earlier chunk) followed by a real turn with a DIFFERENT, later ISO.
  const continuationTail = 'rest of the previously-split turn body.\n\n';
  const nextRealTurn = turn('2026-08-10T23:00:00.000Z', 'assistant', 'a fresh whole turn');
  const content = continuationTail + nextRealTurn;
  await writeRawFile(vault, '2026-08-10.md', content);

  const seededIso = '2026-08-10T05:00:00.000Z'; // the originating turn's ISO, below the resume offset
  const cursor = freshCursor('2026-08-10.md', { offset: 0, boundary: 'split', last_turn_iso: seededIso });
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.text, content);
  assert.equal(result.chunk.coversFrom, seededIso, 'must seed from cursor.last_turn_iso, not the next header');
  assert.equal(result.chunk.coversUntil, '2026-08-10T23:00:00.000Z');
  assert.equal(result.chunk.turnCount, 1); // only the fresh whole turn counts as a NEW header
});

test('split-resume seeding: continuation-only chunk (no further header reached before budget) -> covers_from == covers_until == X', async () => {
  const vault = makeVault();
  const continuationTail = 'a'.repeat(200) + '\n\n'; // still no header, budget cuts before any header appears
  const nextRealTurn = turn('2026-08-10T23:00:00.000Z', 'assistant', 'later turn');
  await writeRawFile(vault, '2026-08-10.md', continuationTail + nextRealTurn);

  const seededIso = '2026-08-10T05:00:00.000Z';
  const cursor = freshCursor('2026-08-10.md', { offset: 0, boundary: 'split', last_turn_iso: seededIso });
  const budget = 50; // smaller than continuationTail alone
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: budget, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.boundary, 'split');
  assert.equal(result.chunk.coversFrom, seededIso);
  assert.equal(result.chunk.coversUntil, seededIso);
  assert.equal(result.nextCursor.last_turn_iso, seededIso);
});

// ===========================================================================
// Section H — covers_* min/max over out-of-order (non-monotonic) ISOs.
// ===========================================================================

test('covers_*: non-monotonic client timestamps -> min/max over the whole chunk, max wins for covers_until even when not last', async () => {
  const vault = makeVault();
  // Timestamps deliberately out of chronological order within the file.
  const t1 = turn('2026-08-10T12:00:00.000Z', 'user', 'first, middling time');
  const t2 = turn('2026-08-10T23:59:59.000Z', 'assistant', 'second turn, but LATEST timestamp');
  const t3 = turn('2026-08-10T01:00:00.000Z', 'user', 'third turn, EARLIEST timestamp, not last');
  const content = t1 + t2 + t3;
  await writeRawFile(vault, '2026-08-10.md', content);

  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.coversFrom, '2026-08-10T01:00:00.000Z'); // min, from t3 (last turn positionally)
  assert.equal(result.chunk.coversUntil, '2026-08-10T23:59:59.000Z'); // max, from t2 (NOT the last turn)
  assert.equal(result.nextCursor.last_turn_iso, '2026-08-10T23:59:59.000Z'); // "max ISO seen so far"
});

// ===========================================================================
// Section I — raw_lock (no-skip-ahead).
// ===========================================================================

test('raw_lock: lock fails on the very first file -> stopped, no chunk', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-10.md', turn('2026-08-10T00:00:00.000Z', 'user', 'hi'));
  const cursor = freshCursor('2026-08-10.md');
  const { acquireLock, releaseLock } = lockThatFails(['2026-08-10.md']);
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, acquireLock, releaseLock,
  });
  assert.deepEqual(result, { stopped: { reason: 'raw_lock', file: '2026-08-10.md' } });
  assert.ok(!('chunk' in result));
});

test('raw_lock: lock fails on second file mid-assembly -> chunk ends at first file EOF + stopped; nothing beyond appears', async () => {
  const vault = makeVault();
  const dayA = turn('2026-08-10T23:00:00.000Z', 'user', 'day A content');
  const dayB = turn('2026-08-11T00:00:00.000Z', 'assistant', 'day B content — MUST NEVER APPEAR');
  await writeRawFile(vault, '2026-08-10.md', dayA);
  await writeRawFile(vault, '2026-08-11.md', dayB);

  const cursor = freshCursor('2026-08-10.md');
  const { acquireLock, releaseLock } = lockThatFails(['2026-08-11.md']);
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, acquireLock, releaseLock,
  });

  assert.equal(result.stopped.reason, 'raw_lock');
  assert.equal(result.stopped.file, '2026-08-11.md');
  assert.equal(result.chunk.text, dayA);
  assert.equal(result.chunk.endFile, '2026-08-10.md');
  assert.equal(result.chunk.endOffset, Buffer.byteLength(dayA, 'utf8'));
  assert.equal(result.chunk.boundary, 'turn');
  assert.ok(!result.chunk.text.includes('MUST NEVER APPEAR'));
  assert.equal(result.nextCursor.file, '2026-08-10.md');
  assert.equal(result.nextCursor.offset, Buffer.byteLength(dayA, 'utf8'));
});

// ===========================================================================
// Section J — chunkMaxBytes measured in bytes, not JS string length.
// ===========================================================================

test('chunkMaxBytes is measured in BYTES (Buffer.byteLength), not JS string length', async () => {
  const vault = makeVault();
  // Multi-byte content: each 'é' is 2 bytes in UTF-8 but 1 JS string char.
  const t1 = turn('2026-08-10T00:00:00.000Z', 'user', 'é'.repeat(20)); // 2*20=40 body bytes (+header)
  const t2 = turn('2026-08-10T00:01:00.000Z', 'assistant', 'more');
  const content = t1 + t2;
  await writeRawFile(vault, '2026-08-10.md', content);

  const t1Bytes = Buffer.byteLength(t1, 'utf8');
  const t1CharLen = t1.length; // strictly less than t1Bytes because of the multi-byte 'é's
  assert.ok(t1CharLen < t1Bytes, 'test fixture sanity: char length must be less than byte length');

  // Budget is between the char-length and the byte-length of t1: a
  // char-length-based implementation would (wrongly) admit t1; a byte-exact
  // one must reject it and hard-split, since t1Bytes > chunkMaxBytes.
  const chunkMaxBytes = t1CharLen + 2;
  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
  });

  assert.ok(Buffer.byteLength(result.chunk.text, 'utf8') <= chunkMaxBytes);
  assert.equal(result.chunk.boundary, 'split', 't1 alone exceeds the byte budget even though it fits the char budget');
});

// ===========================================================================
// Section K — round-1 review IMPORTANT 1: invalid UTF-8 bytes must never
// break I2 or drive the cursor past EOF. Header scanning happens in the
// BYTE domain (latin1 decode: char index === byte offset for ANY input),
// never via a utf8-decode + Buffer.byteLength backmap (which inflates
// length for invalid sequences — each byte maps to U+FFFD, 3 bytes when
// re-measured).
// ===========================================================================

test('IMPORTANT-1: reviewer repro shape — chunkMaxBytes=60 on content with 8x0xFF never exceeds the limit or the file size', async () => {
  const vault = makeVault();
  const header = Buffer.from(`${turnHeader('2026-08-10T00:00:00.000Z', 'user')}\n`, 'utf8');
  const invalidRun = Buffer.from(Array(8).fill(0xff)); // 8 bytes, each an unconditionally-invalid UTF-8 lead byte
  const filler = Buffer.from('z'.repeat(40), 'utf8');
  const tail = Buffer.from('\n\n', 'utf8');
  const fileBuf = Buffer.concat([header, filler.subarray(0, 20), invalidRun, filler.subarray(20), tail]);
  await writeRawFileBytes(vault, '2026-08-11.md', fileBuf);

  const cursor = freshCursor('2026-08-11.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 60, ...NOOP_LOCK,
  });
  assert.ok(result.chunk, 'expected a chunk (guaranteed progress)');
  const chunkBytes = Buffer.byteLength(result.chunk.text, 'utf8');
  assert.ok(chunkBytes <= 60, `I2 violated: got ${chunkBytes} bytes, limit 60`);
  assert.ok(result.nextCursor.offset <= fileBuf.length, 'cursor must never exceed the actual file size');
});

test('IMPORTANT-1: invalid UTF-8 bytes across a full sweep -> I2 holds every call, byte-exact reassembly (Buffers, not strings), cursor never exceeds file size', async () => {
  const vault = makeVault();
  const header = Buffer.from(`${turnHeader('2026-08-10T00:00:00.000Z', 'user')}\n`, 'utf8');
  const asciiA = Buffer.from('a'.repeat(30), 'utf8');
  const invalidRun = Buffer.from(Array(8).fill(0xff));
  const asciiB = Buffer.from('b'.repeat(30), 'utf8');
  const tail = Buffer.from('\n\n', 'utf8');
  const fileBuf = Buffer.concat([header, asciiA, invalidRun, asciiB, tail]);
  await writeRawFileBytes(vault, '2026-08-10.md', fileBuf);
  const totalSize = fileBuf.length;

  const chunkMaxBytes = 20; // small: forces multiple hard splits, some landing inside/adjacent to the 0xFF run
  let cursor = freshCursor('2026-08-10.md');
  let assembled = Buffer.alloc(0);
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 200, 'runaway loop — position not advancing');
    const result = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
    });
    if (result.exhausted) break;
    const chunkBuf = Buffer.from(result.chunk.text, 'utf8');
    assert.ok(chunkBuf.length <= chunkMaxBytes, `I2 violated: chunk is ${chunkBuf.length} bytes at limit ${chunkMaxBytes}`);
    assert.ok(result.nextCursor.offset <= totalSize, 'nextCursor.offset must never exceed the file size');
    assembled = Buffer.concat([assembled, chunkBuf]);
    cursor = result.nextCursor;
  }
  // The one well-defined byte-exact invariant for content containing lone,
  // UNCONDITIONALLY invalid bytes (0xFF is never a valid UTF-8 lead byte at
  // any position, so splitting mid-run cannot change how many replacement
  // characters result): decoding+re-encoding the file across N
  // correctly-positioned pieces must equal decoding+re-encoding it in one
  // pass over the whole file.
  const expected = Buffer.from(fileBuf.toString('utf8'), 'utf8');
  assert.ok(Buffer.compare(assembled, expected) === 0, 'byte-exact reassembly (via utf8 round-trip) failed');
});

// ===========================================================================
// Section L — round-1 review IMPORTANT 2: config-layer fix (resolvePositiveInt
// integrality + min:1024 for chunk_max_bytes) is checkpoint-config.mjs's job
// (see checkpoint-config.test.mjs); this pins the BUILDER still makes clean
// progress at that floor value for realistic oversized multi-byte content.
// ===========================================================================

test('IMPORTANT-2: chunkMaxBytes=1024 (the new config floor) makes guaranteed progress on a multi-byte-leading oversized turn', async () => {
  const vault = makeVault();
  // Body starts with multi-byte characters so a split point could plausibly
  // land mid-codepoint near byte 1024 if the boundary math were wrong.
  const body = '💎中文é'.repeat(400); // well over 1024 bytes, no newlines at all
  const big = turn('2026-08-10T00:00:00.000Z', 'user', body);
  await writeRawFile(vault, '2026-08-10.md', big);

  const chunkMaxBytes = 1024;
  const cursor = freshCursor('2026-08-10.md');
  const first = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
  });
  assert.ok(Buffer.byteLength(first.chunk.text, 'utf8') <= chunkMaxBytes);
  assert.equal(first.chunk.boundary, 'split');
  assert.ok(first.nextCursor.offset > 0, 'guaranteed progress at the config floor');
  assert.ok(!first.chunk.text.includes('�'), 'no broken codepoint');

  // Full sweep to confirm the whole (oversized) turn is eventually consumed
  // byte-exact at this exact floor value.
  let cursor2 = cursor;
  let assembled = '';
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 50);
    const result = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor: cursor2, chunkMaxBytes, ...NOOP_LOCK,
    });
    if (result.exhausted) break;
    assert.ok(Buffer.byteLength(result.chunk.text, 'utf8') <= chunkMaxBytes);
    assembled += result.chunk.text;
    cursor2 = result.nextCursor;
  }
  assert.equal(assembled, big);
});

// ===========================================================================
// Section M — round-1 review MINOR 3: a regex-shape-matching but
// semantically-unparseable header ISO must not poison covers_from/
// covers_until — treated as headerless (falls back to carry/file-date).
// ===========================================================================

test('MINOR-3: header ISO with garbage suffix ("Tzzz") is unparseable -> contributes nothing, falls back to carry/file-date', async () => {
  const vault = makeVault();
  const badHeaderTurn = '## 2026-08-10Tzzz user\nbroken timestamp\n\n';
  const goodTurn = turn('2026-08-10T05:00:00.000Z', 'assistant', 'a real turn after it');
  const content = badHeaderTurn + goodTurn;
  await writeRawFile(vault, '2026-08-10.md', content);

  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.text, content);
  assert.equal(result.chunk.turnCount, 2, 'both headers are structurally real turns, regardless of ISO validity');
  assert.ok(!Number.isNaN(Date.parse(result.chunk.coversFrom)), 'coversFrom must always be well-formed');
  assert.ok(!Number.isNaN(Date.parse(result.chunk.coversUntil)), 'coversUntil must always be well-formed');
  // No carry existed yet when the bad-ISO turn was processed -> falls back
  // to this file's own date-midnight, which becomes the chunk's covers_from
  // (earlier than the good turn's real 05:00 ISO).
  assert.equal(result.chunk.coversFrom, '2026-08-10T00:00:00.000Z');
  assert.equal(result.chunk.coversUntil, '2026-08-10T05:00:00.000Z');
});

test('MINOR-3: header ISO that is shape-valid but calendar-impossible (month 13) is unparseable -> same fallback, never poisons covers_*', async () => {
  const vault = makeVault();
  const badHeaderTurn = '## 2026-13-45T00:00:00.000Z user\nimpossible calendar date\n\n';
  const goodTurn = turn('2026-08-10T05:00:00.000Z', 'assistant', 'a real turn after it');
  const content = badHeaderTurn + goodTurn;
  await writeRawFile(vault, '2026-08-10.md', content);

  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, ...NOOP_LOCK,
  });

  assert.equal(result.chunk.text, content);
  assert.equal(result.chunk.turnCount, 2);
  assert.ok(!Number.isNaN(Date.parse(result.chunk.coversFrom)));
  assert.ok(!Number.isNaN(Date.parse(result.chunk.coversUntil)));
  assert.equal(result.chunk.coversUntil, '2026-08-10T05:00:00.000Z');
  assert.notEqual(result.chunk.coversFrom, '2026-13-45T00:00:00.000Z', 'the garbage ISO must never appear verbatim in covers_*');
});

// ===========================================================================
// Section N — round-1 review MINOR 4: a cursor already at (or past) a
// file's EOF must never trigger a raw_lock stop for that file — there is
// nothing to read there, lock or no lock.
// ===========================================================================

test('MINOR-4: locked LAST file with cursor already at its EOF -> exhausted, never a spurious raw_lock stop', async () => {
  const vault = makeVault();
  const content = turn('2026-08-10T00:00:00.000Z', 'user', 'only turn, already fully digested');
  await writeRawFile(vault, '2026-08-10.md', content);
  const size = Buffer.byteLength(content, 'utf8');

  const cursor = freshCursor('2026-08-10.md', { offset: size });
  const { acquireLock, releaseLock } = lockThatFails(['2026-08-10.md']); // a live session holds this file's lock
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, acquireLock, releaseLock,
  });
  assert.deepEqual(result, { exhausted: true });
});

// ===========================================================================
// Section O — round-1 review MINOR 5: (a) a releaseLock rejection is
// best-effort and must never escape/mask; (b) a raw file that vanishes
// between listing and reading (ENOENT — legal per §4.2 check 3) is skipped,
// not treated as a run-aborting error.
// ===========================================================================

function lockWithFailingRelease() {
  return {
    acquireLock: async () => true,
    releaseLock: async () => {
      throw new Error('boom: release failed');
    },
  };
}

test('MINOR-5a: releaseLock rejection is best-effort — a successful read still returns its chunk (no crash, no masking)', async () => {
  const vault = makeVault();
  const content = turn('2026-08-10T00:00:00.000Z', 'user', 'hello');
  await writeRawFile(vault, '2026-08-10.md', content);
  const cursor = freshCursor('2026-08-10.md');
  const { acquireLock, releaseLock } = lockWithFailingRelease();
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, acquireLock, releaseLock,
  });
  assert.ok(result.chunk, 'a failing releaseLock must never abort a successful read');
  assert.equal(result.chunk.text, content);
});

/**
 * Deletes `filenameToDelete` the moment its lock is "acquired" — deterministically
 * reproduces the TOCTOU race (file present at the readdir/stat snapshot, gone by
 * the time it's actually read) without depending on real filesystem timing.
 */
function lockThatDeletesFileOnAcquire(vault, filenameToDelete, project = PROJECT) {
  return {
    acquireLock: async (lockdirPath) => {
      if (path.basename(lockdirPath, '.lockdir') === filenameToDelete) {
        await fs.unlink(path.join(rawDir(vault, project), filenameToDelete)).catch(() => {});
      }
      return true;
    },
    releaseLock: async () => {},
  };
}

test('MINOR-5b: raw file vanishes mid-walk (ENOENT, legal deletion per §4.2 check 3) -> skipped, walk continues rather than aborting', async () => {
  const vault = makeVault();
  const dayA = turn('2026-08-10T23:00:00.000Z', 'user', 'day A — deleted right after its lock is acquired');
  const dayB = turn('2026-08-11T00:00:00.000Z', 'assistant', 'day B — present');
  await writeRawFile(vault, '2026-08-10.md', dayA);
  await writeRawFile(vault, '2026-08-11.md', dayB);

  const cursor = freshCursor('2026-08-10.md');
  const { acquireLock, releaseLock } = lockThatDeletesFileOnAcquire(vault, '2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes: 200_000, acquireLock, releaseLock,
  });
  assert.ok(result.chunk, 'must not abort — should skip the vanished file and pick up day B');
  assert.equal(result.chunk.text, dayB);
  assert.equal(result.chunk.startFile, '2026-08-11.md');
});

// ===========================================================================
// Section P — HARDENING: seeded parameterized sweep. chunkMaxBytes (small/
// medium/large) x content shapes (multi-byte, oversized newline-free turns,
// legacy-blob prefix, non-monotonic ISOs), with a deterministic seed (no
// unseeded Math.random anywhere) — a failing case is always exactly
// reproducible from the seed alone. Asserts byte-exact BUFFER reassembly,
// I2, parseable covers_*, and strict cursor advance on every single call.
// ===========================================================================

/** Deterministic PRNG (mulberry32) — same seed always produces the same stream. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MULTIBYTE_POOL = ['é', 'ñ', '中', '文', '💎', '🚀', '€', 'ü', 'ß', '漢'];

function randomMultiByteBody(rand, minChars, maxChars) {
  const len = minChars + Math.floor(rand() * (maxChars - minChars));
  let s = '';
  for (let i = 0; i < len; i += 1) {
    if (rand() < 0.3) {
      s += MULTIBYTE_POOL[Math.floor(rand() * MULTIBYTE_POOL.length)];
    } else {
      s += String.fromCharCode(97 + Math.floor(rand() * 26));
    }
    if (rand() < 0.05) s += '\n';
  }
  return s;
}

function buildMultiByteCorpus(rand) {
  return {
    '2026-08-10.md':
      turn('2026-08-10T01:00:00.000Z', 'user', randomMultiByteBody(rand, 20, 60)) +
      turn('2026-08-10T02:00:00.000Z', 'assistant', randomMultiByteBody(rand, 20, 60)),
    '2026-08-11.md':
      turn('2026-08-11T00:00:00.000Z', 'user', randomMultiByteBody(rand, 20, 60)),
  };
}

function buildOversizedNoNewlineCorpus(rand) {
  const bigBody = Array.from({ length: 300 }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join('');
  return {
    '2026-08-10.md':
      turn('2026-08-10T00:00:00.000Z', 'user', bigBody) +
      turn('2026-08-10T01:00:00.000Z', 'assistant', 'short reply'),
  };
}

function buildLegacyBlobPrefixCorpus(rand) {
  return {
    '2026-07-01.md': 'legacy prose with no headers at all.\n'.repeat(1 + Math.floor(rand() * 3)),
    '2026-08-10.md':
      turn('2026-08-10T00:00:00.000Z', 'user', randomMultiByteBody(rand, 10, 40)) +
      turn('2026-08-10T01:00:00.000Z', 'assistant', randomMultiByteBody(rand, 10, 40)),
  };
}

function buildNonMonotonicCorpus() {
  return {
    '2026-08-10.md':
      turn('2026-08-10T23:00:00.000Z', 'user', 'late in the day') +
      turn('2026-08-10T01:00:00.000Z', 'assistant', 'earlier timestamp, later position') +
      turn('2026-08-10T12:00:00.000Z', 'user', 'middle'),
    '2026-08-11.md':
      turn('2026-08-11T00:30:00.000Z', 'assistant', 'next day, out of order too') +
      turn('2026-08-10T18:00:00.000Z', 'user', 'backdated into the next file'),
  };
}

/** Runs one full sweep of `files` at `chunkMaxBytes`, asserting every hardening property. Returns `{sawSplit}`. */
async function sweepCorpus(vault, files, chunkMaxBytes) {
  const filenames = Object.keys(files).sort();
  for (const name of filenames) {
    // eslint-disable-next-line no-await-in-loop
    await writeRawFile(vault, name, files[name]);
  }
  const expected = Buffer.concat(filenames.map((n) => Buffer.from(files[n], 'utf8')));

  let cursor = freshCursor(filenames[0]);
  let assembled = Buffer.alloc(0);
  let sawSplit = false;
  let guard = 0;
  for (;;) {
    guard += 1;
    assert.ok(guard < 500, `runaway loop at chunkMaxBytes=${chunkMaxBytes}`);
    const before = cursor;
    // eslint-disable-next-line no-await-in-loop
    const result = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
    });
    if (result.exhausted) break;

    const chunkBuf = Buffer.from(result.chunk.text, 'utf8');
    assert.ok(chunkBuf.length <= chunkMaxBytes, `I2 violated at chunkMaxBytes=${chunkMaxBytes}: ${chunkBuf.length} bytes`);
    assert.ok(!Number.isNaN(Date.parse(result.chunk.coversFrom)), `unparseable coversFrom at chunkMaxBytes=${chunkMaxBytes}`);
    assert.ok(!Number.isNaN(Date.parse(result.chunk.coversUntil)), `unparseable coversUntil at chunkMaxBytes=${chunkMaxBytes}`);
    if (result.chunk.boundary === 'split') sawSplit = true;
    assembled = Buffer.concat([assembled, chunkBuf]);

    // Strict advance: (file, offset) must be lexically-then-numerically
    // greater than before this call, every single call — the guard against
    // silent non-progress.
    const advanced =
      result.nextCursor.file > before.file ||
      (result.nextCursor.file === before.file && result.nextCursor.offset > before.offset);
    assert.ok(advanced, `cursor did not strictly advance at chunkMaxBytes=${chunkMaxBytes} (was ${before.file}:${before.offset}, now ${result.nextCursor.file}:${result.nextCursor.offset})`);

    cursor = result.nextCursor;
  }
  assert.ok(Buffer.compare(assembled, expected) === 0, `byte-exact reassembly failed at chunkMaxBytes=${chunkMaxBytes}`);
  return { sawSplit };
}

test('HARDENING: seeded parameterized sweep — chunkMaxBytes x shapes x mid-sweep split-resume', async () => {
  const SEED = 20260815; // deterministic — any failure is reproducible from this seed alone, forever
  const rand = mulberry32(SEED);
  const sizes = { small: 24, medium: 401, large: 100_000 };
  const shapeBuilders = {
    multiByte: buildMultiByteCorpus,
    oversizedNoNewline: buildOversizedNoNewlineCorpus,
    legacyBlobPrefix: buildLegacyBlobPrefixCorpus,
    nonMonotonic: buildNonMonotonicCorpus,
  };

  let anySplitObserved = false;
  for (const builder of Object.values(shapeBuilders)) {
    for (const chunkMaxBytes of Object.values(sizes)) {
      const vault = makeVault();
      const files = builder(rand);
      // eslint-disable-next-line no-await-in-loop
      const { sawSplit } = await sweepCorpus(vault, files, chunkMaxBytes);
      if (sawSplit) anySplitObserved = true;
    }
  }
  assert.ok(anySplitObserved, 'the matrix must exercise at least one mid-sweep hard split (the split-resume path)');
});

// ===========================================================================
// Section Q — round-2 review IMPORTANT 2: fill-to-floor (spec §4.4).
//
// Reproduction: a sub-floor turn followed by a turn so large it alone
// exceeds the REMAINING budget used to end the chunk early (boundary:
// 'turn', chunk stays below minChunkBytes) — routed through the txn's #185
// thin gate, that sub-floor chunk abstains on the FIRST chunk of every run
// forever (abstention never advances the cursor), permanently stalling that
// project's backlog even though real undigested content sits right behind
// it. The fix hard-splits the oversized turn to fill the chunk up to
// chunkMaxBytes instead of ending early, whenever ending early would leave
// the chunk below minChunkBytes with more content still pending.
// ===========================================================================

test('fill-to-floor: sub-floor turn + oversized turn behind it -> chunk fills via split, never ends thin while content pends (IMPORTANT-2 repro)', async () => {
  const vault = makeVault();
  const minChunkBytes = 500;
  const chunkMaxBytes = 1024; // realistic config-floor value (resolvePositiveInt's min for chunk_max_bytes)

  const t1 = turn('2026-08-10T00:00:00.000Z', 'user', 'short'); // well under minChunkBytes alone
  // Realistic body: periodic newlines (like real LLM output), not one
  // unbroken run — computeSplitPoint prefers the LAST newline under its
  // budget, so a newline-free blob would legitimately cut right after the
  // header (the only nearby newline) regardless of fill-to-floor; that's a
  // property of the newline-preferring split heuristic, not what this test
  // is pinning. Frequent line breaks let the split land close to the actual
  // budget ceiling, like the existing "oversized single turn" tests do.
  const t2Body = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(10)}`).join('\n');
  const t2 = turn('2026-08-10T00:01:00.000Z', 'assistant', t2Body); // alone far exceeds chunkMaxBytes
  const content = t1 + t2;
  await writeRawFile(vault, '2026-08-10.md', content);

  assert.ok(Buffer.byteLength(t1.trim(), 'utf8') < minChunkBytes, 'fixture sanity: t1 alone must be sub-floor');
  assert.ok(Buffer.byteLength(t2, 'utf8') > chunkMaxBytes - Buffer.byteLength(t1, 'utf8'),
    'fixture sanity: t2 alone must exceed the budget remaining after t1');

  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, minChunkBytes, ...NOOP_LOCK,
  });

  assert.ok(result.chunk, 'expected a chunk, not exhausted');
  // I2 still holds: the fill-to-floor split never pushes the chunk over the ceiling.
  assert.ok(Buffer.byteLength(result.chunk.text, 'utf8') <= chunkMaxBytes,
    `I2 violated: chunk is ${Buffer.byteLength(result.chunk.text, 'utf8')} bytes > chunkMaxBytes=${chunkMaxBytes}`);
  // The core fix: the chunk must NOT stay sub-floor while t2 sits right behind t1.
  assert.ok(Buffer.byteLength(result.chunk.text.trim(), 'utf8') >= minChunkBytes,
    `fill-to-floor did not fire: chunk trimmed to ${Buffer.byteLength(result.chunk.text.trim(), 'utf8')} bytes, still below minChunkBytes=${minChunkBytes}`);
  assert.equal(result.chunk.boundary, 'split', 'a fill-to-floor hard-split must report boundary:split');
  assert.equal(result.chunk.turnCount, 2, 'both t1 and t2 headers are inside the chunk (t2 is split, not dropped)');
  assert.ok(result.chunk.text.startsWith(t1), 'the chunk must still start with t1 in full');
  // Genuine progress into t2's body, not merely re-including t1.
  const t1End = Buffer.byteLength(t1, 'utf8');
  assert.ok(result.nextCursor.offset > t1End, 'the cursor must have advanced INTO t2, not stopped at the end of t1');

  // "next run digests the remainder": resume from nextCursor and keep
  // building until exhausted; concatenating every chunk must byte-exactly
  // reproduce the whole file (I1 — no loss), and no later chunk may ever be
  // thin while more content is still pending (only the LAST one may be).
  let cur = result.nextCursor;
  let assembled = Buffer.from(result.chunk.text, 'utf8');
  let calls = 1;
  for (;;) {
    calls += 1;
    assert.ok(calls < 50, 'runaway loop — cursor is not making progress');
    // eslint-disable-next-line no-await-in-loop
    const next = await buildNextChunk({
      vaultDir: vault, project: PROJECT, cursor: cur, chunkMaxBytes, minChunkBytes, ...NOOP_LOCK,
    });
    if (next.exhausted) break;
    assembled = Buffer.concat([assembled, Buffer.from(next.chunk.text, 'utf8')]);
    cur = next.nextCursor;
  }
  assert.ok(calls > 1, 'the oversized t2 must require more than one buildNextChunk call to fully digest');
  assert.ok(Buffer.compare(assembled, Buffer.from(content, 'utf8')) === 0,
    'concatenating every chunk (incl. the fill-to-floor split) must byte-exactly reproduce the whole file');
});

test('fill-to-floor: a TRUE end-of-corpus tail (nothing pending after it) still thins — the fix never forces padding out of nothing', async () => {
  const vault = makeVault();
  const minChunkBytes = 500;
  const chunkMaxBytes = 1024;

  const t1 = turn('2026-08-10T00:00:00.000Z', 'user', 'short'); // the ENTIRE corpus — nothing to fill with
  await writeRawFile(vault, '2026-08-10.md', t1);

  const cursor = freshCursor('2026-08-10.md');
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, minChunkBytes, ...NOOP_LOCK,
  });

  assert.ok(result.chunk, 'expected a chunk, not exhausted');
  assert.equal(result.chunk.text, t1, 'a genuine tail must be returned unpadded — there is nothing left to fill it with');
  assert.equal(result.chunk.boundary, 'turn', 'natural EOF, not a forced split');
  assert.ok(Buffer.byteLength(result.chunk.text.trim(), 'utf8') < minChunkBytes,
    'fixture sanity: this chunk is genuinely sub-floor — the #185 gate correctly abstains on it (thin_transcript), not a fill-to-floor bug');

  // Resuming from here must report exhausted — there truly is nothing more.
  const next = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor: result.nextCursor, chunkMaxBytes, minChunkBytes, ...NOOP_LOCK,
  });
  assert.deepEqual(next, { exhausted: true });
});

test('fill-to-floor: minChunkBytes defaults to DEFAULT_MIN_TRANSCRIPT_BYTES when the caller omits it', async () => {
  // checkpoint.mjs always threads a resolved minChunkBytes through in
  // production; this pins the module's own fallback for callers that don't
  // (e.g. a bare unit test), matching checkpoint-config.mjs's shipped 500.
  const vault = makeVault();
  const chunkMaxBytes = 1024;
  const t1 = turn('2026-08-10T00:00:00.000Z', 'user', 'short');
  const t2Body = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(10)}`).join('\n');
  const t2 = turn('2026-08-10T00:01:00.000Z', 'assistant', t2Body);
  await writeRawFile(vault, '2026-08-10.md', t1 + t2);

  const cursor = freshCursor('2026-08-10.md');
  // No minChunkBytes passed — must still fill to the 500-byte default floor.
  const result = await buildNextChunk({
    vaultDir: vault, project: PROJECT, cursor, chunkMaxBytes, ...NOOP_LOCK,
  });

  assert.ok(result.chunk);
  assert.ok(Buffer.byteLength(result.chunk.text.trim(), 'utf8') >= 500,
    'the default minChunkBytes must still trigger fill-to-floor without an explicit override');
});
