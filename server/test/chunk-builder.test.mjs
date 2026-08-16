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
