// server/test/checkpoint-cursor.test.mjs — validation-matrix tests for
// server/lib/checkpoint-cursor.mjs (Task 2, docs/plans/2026-08-15-checkpoint-
// chunked-summarization-plan). This module is the arc's catastrophic-class
// surface (a cursor bug = silent permanent turn loss) — the matrix below is
// the point of the test file, not incidental coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers/tmpdir.mjs';
import {
  loadCursor,
  bootstrapInit,
  recoveryReinit,
  advanceCursor,
} from '../lib/checkpoint-cursor.mjs';

const PROJECT = 'cursor-test-proj';

function makeVault() {
  return tempDir('um-cursor-test-');
}

function cursorPath(vault, project = PROJECT) {
  return path.join(vault, 'state', project, 'checkpoint-cursor.json');
}

function rawDir(vault, project = PROJECT) {
  return path.join(vault, 'captures', project, 'raw');
}

function sessionsDir(vault, project = PROJECT) {
  return path.join(vault, 'sessions', project);
}

async function writeRawFile(vault, filename, content, project = PROJECT) {
  const dir = rawDir(vault, project);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await fs.writeFile(p, content, 'utf8');
  return p;
}

async function writeSessionFile(vault, filename, content, project = PROJECT) {
  const dir = sessionsDir(vault, project);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), content, 'utf8');
}

/** Write raw JSON text as the cursor file (bypasses advanceCursor — fixture setup). */
async function writeCursorFileRaw(vault, text, project = PROJECT) {
  const p = cursorPath(vault, project);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, 'utf8');
}

/** Write a shape-valid cursor object as JSON, with field overrides. `undefined` overrides drop the key. */
async function writeCursorFile(vault, overrides = {}, project = PROJECT) {
  const base = {
    schema_version: 1,
    file: '2026-08-10.md',
    offset: 0,
    boundary: 'turn',
    last_turn_iso: null,
    last_summary_id: null,
    updated_at: new Date().toISOString(),
  };
  const obj = { ...base, ...overrides };
  await writeCursorFileRaw(vault, JSON.stringify(obj), project);
  return obj;
}

function turnHeader(iso, role) {
  return `## ${iso} ${role}`;
}

// ===========================================================================
// Section A — §4.2 check 0: shape guard. Every case must take the recovery
// path (reinitialized: true, some reason present) — never throw, never
// silently accept a malformed cursor.
// ===========================================================================

test('shape guard: literal NaN offset (invalid JSON token) -> parse_error recovery', async () => {
  const vault = makeVault();
  await writeCursorFileRaw(
    vault,
    '{"schema_version":1,"file":"2026-08-10.md","offset":NaN,"boundary":"turn","last_turn_iso":null,"last_summary_id":null,"updated_at":"2026-08-10T00:00:00.000Z"}',
  );
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'parse_error');
});

test('shape guard: malformed JSON -> parse_error recovery', async () => {
  const vault = makeVault();
  await writeCursorFileRaw(vault, '{not valid json');
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'parse_error');
});

test('shape guard: negative offset -> recovery', async () => {
  const vault = makeVault();
  await writeCursorFile(vault, { offset: -5 });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:offset');
});

test('shape guard: non-integer (float) offset -> recovery', async () => {
  const vault = makeVault();
  await writeCursorFile(vault, { offset: 1.5 });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:offset');
});

test('shape guard: offset as string -> recovery', async () => {
  const vault = makeVault();
  await writeCursorFile(vault, { offset: '100' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:offset');
});

test('shape guard: path-traversal file name (../../evil.md) -> recovery, never joined into a path', async () => {
  const vault = makeVault();
  await writeCursorFile(vault, { file: '../../evil.md' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:file');
});

test('shape guard: non-zero-padded file name (2026-8-1.md) -> recovery', async () => {
  const vault = makeVault();
  await writeCursorFile(vault, { file: '2026-8-1.md' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:file');
});

test('shape guard: absent boundary -> recovery (no forward-compat default)', async () => {
  const vault = makeVault();
  await writeCursorFile(vault, { boundary: undefined });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:boundary');
});

test('shape guard: schema_version 2 -> recovery', async () => {
  const vault = makeVault();
  await writeCursorFile(vault, { schema_version: 2 });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:schema_version');
});

test('shape guard: JSON scalar (not an object) -> recovery, not_an_object', async () => {
  const vault = makeVault();
  await writeCursorFileRaw(vault, '42');
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:not_an_object');
});

test('shape guard: JSON array (not an object) -> recovery, not_an_object', async () => {
  const vault = makeVault();
  await writeCursorFileRaw(vault, '[1,2,3]');
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:not_an_object');
});

test('shape guard: offset 1e999 (parses to Infinity, valid JSON syntax) -> recovery', async () => {
  const vault = makeVault();
  await writeCursorFileRaw(
    vault,
    '{"schema_version":1,"file":"2026-08-10.md","offset":1e999,"boundary":"turn","last_turn_iso":null,"last_summary_id":null,"updated_at":"2026-08-10T00:00:00.000Z"}',
  );
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'shape_invalid:offset');
});

// ===========================================================================
// Section B — §4.2 checks 1/2: offset-vs-size and turn-boundary alignment.
// ===========================================================================

test('offset > file size -> recovery (offset_exceeds_size)', async () => {
  const vault = makeVault();
  const content = turnHeader('2026-08-10T00:00:00.000Z', 'user') + '\nhi\n\n';
  await writeRawFile(vault, '2026-08-10.md', content);
  const size = Buffer.byteLength(content, 'utf8');
  await writeCursorFile(vault, { file: '2026-08-10.md', offset: size + 100, boundary: 'turn' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'offset_exceeds_size');
});

test('offset == size (EOF) -> valid, no reinit', async () => {
  const vault = makeVault();
  const content = turnHeader('2026-08-10T00:00:00.000Z', 'user') + '\nhi\n\n';
  await writeRawFile(vault, '2026-08-10.md', content);
  const size = Buffer.byteLength(content, 'utf8');
  await writeCursorFile(vault, { file: '2026-08-10.md', offset: size, boundary: 'turn' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, false);
  assert.equal(result.cursor.offset, size);
});

test('offset at a turn-header start -> valid, no reinit', async () => {
  const vault = makeVault();
  const first = turnHeader('2026-08-10T00:00:00.000Z', 'user') + '\nhi\n\n';
  const second = turnHeader('2026-08-10T01:00:00.000Z', 'assistant') + '\nhello\n\n';
  const content = first + second;
  await writeRawFile(vault, '2026-08-10.md', content);
  const secondOffset = Buffer.byteLength(first, 'utf8');
  await writeCursorFile(vault, { file: '2026-08-10.md', offset: secondOffset, boundary: 'turn' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, false);
  assert.equal(result.cursor.offset, secondOffset);
});

test('offset mid-turn with boundary "turn" -> recovery (boundary_misaligned)', async () => {
  const vault = makeVault();
  const content = turnHeader('2026-08-10T00:00:00.000Z', 'user') + '\nhello world\n\n';
  await writeRawFile(vault, '2026-08-10.md', content);
  const midOffset = Buffer.byteLength(turnHeader('2026-08-10T00:00:00.000Z', 'user'), 'utf8') + 3; // inside content, not header start, not EOF
  await writeCursorFile(vault, { file: '2026-08-10.md', offset: midOffset, boundary: 'turn' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'boundary_misaligned');
});

test('offset at a turn-header start with an EMPTY ISO-suffix ("T user", \\S* widened acceptance) -> valid, no reinit', async () => {
  // Task 4's shared makeTurnHeaderRe() aligns this module's header pattern
  // with checkpoint.mjs:105's ('\\S*' after the ISO's 'T', not the previous
  // local '\\S+') — a header whose ISO suffix is empty (immediately followed
  // by a space and the role) is now accepted, where the old '\\S+' pattern
  // would have rejected it and forced an unnecessary recovery re-init.
  const vault = makeVault();
  const content = '## 2026-08-10T user\nhi\n\n';
  await writeRawFile(vault, '2026-08-10.md', content);
  await writeCursorFile(vault, { file: '2026-08-10.md', offset: 0, boundary: 'turn' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, false);
  assert.equal(result.cursor.offset, 0);
});

test('same mid-turn offset with boundary "split" -> VALID (check 2 skipped)', async () => {
  const vault = makeVault();
  const content = turnHeader('2026-08-10T00:00:00.000Z', 'user') + '\nhello world\n\n';
  await writeRawFile(vault, '2026-08-10.md', content);
  const midOffset = Buffer.byteLength(turnHeader('2026-08-10T00:00:00.000Z', 'user'), 'utf8') + 3;
  await writeCursorFile(vault, { file: '2026-08-10.md', offset: midOffset, boundary: 'split' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, false);
  assert.equal(result.cursor.offset, midOffset);
  assert.equal(result.cursor.boundary, 'split');
});

// ===========================================================================
// Section C — §4.2 check 3: cursor.file no longer exists -> NOT invalid,
// adjusted resume at the next newer existing file, offset 0.
// ===========================================================================

test('missing cursor.file -> adjusted resume at next newer existing file (NOT reinit)', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-10.md', 'irrelevant');
  await writeRawFile(vault, '2026-08-12.md', 'irrelevant');
  // cursor points at 2026-08-11.md, which was never written (e.g. deleted/never-created).
  // updated_at is pinned an hour in the future so this test — about check 3's
  // adjustment, not check 4's growth tripwire — never races the raw files'
  // mtimes against a "now" timestamp captured moments later (same rationale
  // as the sibling tests below).
  await writeCursorFile(vault, {
    file: '2026-08-11.md',
    offset: 500,
    boundary: 'turn',
    updated_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, false);
  assert.equal(result.cursor.file, '2026-08-12.md');
  assert.equal(result.cursor.offset, 0);
  assert.equal(result.cursor.boundary, 'turn');
});

test('check 4 (below-cursor growth) still runs inside check 3s missing-file branch', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-05.md', 'original content');
  // cursor.file itself does not exist -> check 3's "NOT invalid" path would
  // normally apply, but check 4 must still run first and can override it.
  await writeCursorFile(vault, {
    file: '2026-08-10.md',
    offset: 500,
    boundary: 'turn',
    updated_at: '2020-01-01T00:00:00.000Z', // deliberately ancient
  });
  // Bump the OLDER file's mtime to "now" — content appeared below a cursor
  // pointing at a file that doesn't even exist.
  await fs.writeFile(path.join(rawDir(vault), '2026-08-05.md'), 'mutated content', 'utf8');

  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'below_cursor_growth');
});

test('future-dated cursor.file with no newer raw file -> recovery (never perpetually skip forward)', async () => {
  const vault = makeVault();
  // Empty vault: cursor.file names a date far in the future and nothing
  // newer will ever exist "naturally" — must not be treated as a legally-
  // deleted file (check 3), since that would silently treat all real future
  // content as already-digested forever.
  await writeCursorFile(vault, { file: '9999-12-31.md', offset: 0, boundary: 'turn' });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'future_dated_file');
});

test('missing cursor.file with no newer file available -> stays at same name, offset reset to 0', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-01.md', 'irrelevant');
  // cursor points ahead of everything that exists so far. updated_at is
  // pinned an hour in the future (not "now") so this test — which is about
  // check 3's adjustment, not check 4's growth tripwire — never races the
  // sub-millisecond gap between a Date.now()-sourced ISO string and the raw
  // file's NTFS mtime (both fire back-to-back here with no real-world-
  // equivalent gap; production always has one, since advanceCursor runs
  // long after the raw capture that preceded it).
  await writeCursorFile(vault, {
    file: '2026-08-10.md',
    offset: 500,
    boundary: 'turn',
    updated_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, false);
  assert.equal(result.cursor.file, '2026-08-10.md');
  assert.equal(result.cursor.offset, 0);
});

// ===========================================================================
// Section D — §4.2 check 4: below-cursor growth tripwire.
// ===========================================================================

test('below-cursor growth: older file mtime bumped after updated_at -> recovery', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-05.md', 'original content');
  await writeRawFile(vault, '2026-08-10.md', ''); // empty -> offset 0 is trivially EOF-valid
  await writeCursorFile(vault, {
    file: '2026-08-10.md',
    offset: 0,
    boundary: 'turn',
    updated_at: '2020-01-01T00:00:00.000Z', // deliberately ancient
  });
  // Bump the OLDER file's mtime to "now" — content appeared below the cursor.
  await fs.writeFile(path.join(rawDir(vault), '2026-08-05.md'), 'mutated content', 'utf8');

  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'below_cursor_growth');
});

test('below-cursor growth: older file untouched since updated_at -> no false positive', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-05.md', 'original content');
  await writeRawFile(vault, '2026-08-10.md', '');
  await writeCursorFile(vault, {
    file: '2026-08-10.md',
    offset: 0,
    boundary: 'turn',
    updated_at: new Date(Date.now() + 3600_000).toISOString(), // future — nothing can be "newer"
  });
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, false);
});

// ===========================================================================
// Section E — §4.3 bootstrapInit.
// ===========================================================================

test('bootstrapInit: with session files -> newest date governs', async () => {
  const vault = makeVault();
  await writeSessionFile(vault, 'session-2026-08-01-aaaaaaaa.md', '---\ntype: session_summary\n---\nbody');
  await writeSessionFile(vault, 'session-2026-08-05-bbbbbbbb.md', '---\ntype: session_summary\n---\nbody');
  const cursor = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '2026-08-05.md');
  assert.equal(cursor.offset, 0);
  assert.equal(cursor.boundary, 'turn');
  assert.equal(cursor.last_turn_iso, null);
  assert.equal(cursor.last_summary_id, null);
  assert.equal(cursor.schema_version, 1);
});

test('bootstrapInit: orphan .md.tmp (never reaped) newer than the newest real .md is ignored', async () => {
  const vault = makeVault();
  await writeSessionFile(vault, 'session-2026-08-01-aaaaaaaa.md', '---\ntype: session_summary\n---\nbody');
  // A phase-2 failure orphan — the pipeline leaves these on disk forever;
  // nothing reaps them. Its embedded date is newer than the real summary's,
  // but it is NOT a durable summary and must never set the bootstrap
  // boundary (that would silently skip the entire backlog below it).
  await writeSessionFile(vault, 'session-2026-08-14-bbbbbbbb.md.tmp', '---\ntype: session_summary\nstatus: orphan_summary\n---\nnever committed');
  const cursor = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '2026-08-01.md');
});

test('bootstrapInit: stray non-.md file (e.g. notes.txt) with a session-date-shaped name is ignored', async () => {
  const vault = makeVault();
  await writeSessionFile(vault, 'session-2026-08-01-aaaaaaaa.md', '---\ntype: session_summary\n---\nbody');
  await writeSessionFile(vault, 'session-2026-08-20-notes.txt', 'unrelated stray file');
  const cursor = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '2026-08-01.md');
});

test('bootstrapInit: no session files -> oldest raw file', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-07-20.md', 'x');
  await writeRawFile(vault, '2026-07-25.md', 'y');
  const cursor = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '2026-07-20.md');
  assert.equal(cursor.offset, 0);
});

test('bootstrapInit: empty vault -> sentinel 0000-00-00.md', async () => {
  const vault = makeVault();
  const cursor = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '0000-00-00.md');
  assert.equal(cursor.offset, 0);
});

// ===========================================================================
// Section F — §4.2 recoveryReinit.
// ===========================================================================

test('recoveryReinit: covers_until scan honors the 48h slack (just-inside turn IS re-included)', async () => {
  const vault = makeVault();
  // W = 2026-08-15T00:00:00.000Z; threshold = W - 48h = 2026-08-13T00:00:00.000Z
  await writeSessionFile(
    vault,
    'session-2026-08-15-aaaaaaaa.md',
    '---\ntype: session_summary\ncovers_until: 2026-08-15T00:00:00.000Z\n---\nbody',
  );
  const turnA = turnHeader('2026-08-13T00:00:00.000Z', 'user') + '\nexactly at threshold, must be excluded\n\n';
  const turnB = turnHeader('2026-08-13T00:00:00.001Z', 'assistant') + '\njust inside slack, must be re-included\n\n';
  const content = turnA + turnB;
  await writeRawFile(vault, '2026-08-13.md', content);

  const cursor = await recoveryReinit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '2026-08-13.md');
  assert.equal(cursor.boundary, 'turn');
  assert.equal(cursor.offset, Buffer.byteLength(turnA, 'utf8'));
});

test('recoveryReinit: forged early header (quoted, future ISO) pulls cursor earlier, never past real content', async () => {
  const vault = makeVault();
  // W = 2026-08-16T00:00:00.000Z; threshold = 2026-08-14T00:00:00.000Z
  await writeSessionFile(
    vault,
    'session-2026-08-16-aaaaaaaa.md',
    '---\ntype: session_summary\ncovers_until: 2026-08-16T00:00:00.000Z\n---\nbody',
  );
  const preamble =
    turnHeader('2026-08-10T00:00:00.000Z', 'user') +
    '\nA message that quotes a fake header inline:\n' +
    turnHeader('2099-01-01T00:00:00.000Z', 'user') +
    '\nforged content, not a real turn, but starts at column 0\n\n';
  const realTurn = turnHeader('2026-08-14T01:00:00.000Z', 'assistant') + '\nreal undigested content\n\n';
  const content = preamble + realTurn;
  await writeRawFile(vault, '2026-08-14.md', content);

  const cursor = await recoveryReinit({ vaultDir: vault, project: PROJECT });
  const forgedOffset = content.indexOf(turnHeader('2099-01-01T00:00:00.000Z', 'user'));
  const realOffset = content.indexOf(turnHeader('2026-08-14T01:00:00.000Z', 'assistant'));
  assert.equal(cursor.file, '2026-08-14.md');
  assert.equal(cursor.offset, forgedOffset); // lands exactly at the forged (earlier) header
  assert.ok(cursor.offset < realOffset, 'cursor must land at or before the forged header, never after real content');
});

test('recoveryReinit: covers_until in the BODY (no frontmatter block) is ignored, not treated as W', async () => {
  const vault = makeVault();
  // No leading `---` fence at all — a plain body line that happens to look
  // like a frontmatter field (LLM-generated summaries can echo field names
  // verbatim) must never be trusted as the real watermark: doing so would
  // fabricate W from a fake future date and could push the recovery scan
  // past genuinely undigested content.
  await writeSessionFile(
    vault,
    'session-2026-08-05-aaaaaaaa.md',
    'No frontmatter here.\ncovers_until: 2099-01-01T00:00:00.000Z\nJust a body line that looks like frontmatter but is not.',
  );
  const cursor = await recoveryReinit({ vaultDir: vault, project: PROJECT });
  const expected = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, expected.file); // falls back to bootstrap — never fooled by the fake future date
});

test('recoveryReinit: covers_until AFTER the closing frontmatter fence (body) is ignored', async () => {
  const vault = makeVault();
  // A real frontmatter block with NO covers_until inside it, followed by a
  // body that contains a covers_until-shaped line after the closing fence.
  await writeSessionFile(
    vault,
    'session-2026-08-05-aaaaaaaa.md',
    '---\ntype: session_summary\n---\nSome narrative text.\ncovers_until: 2099-01-01T00:00:00.000Z\nMore narrative.',
  );
  const cursor = await recoveryReinit({ vaultDir: vault, project: PROJECT });
  const expected = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, expected.file);
});

test('recoveryReinit: no covers_until anywhere -> falls back to bootstrapInit', async () => {
  const vault = makeVault();
  await writeSessionFile(vault, 'session-2026-08-01-aaaaaaaa.md', '---\ntype: session_summary\n---\nno covers_until here');
  await writeSessionFile(vault, 'session-2026-08-05-bbbbbbbb.md', '---\ntype: session_summary\n---\nno covers_until here either');
  const cursor = await recoveryReinit({ vaultDir: vault, project: PROJECT });
  const expected = await bootstrapInit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, expected.file);
  assert.equal(cursor.file, '2026-08-05.md'); // bootstrap's newest-session-date branch
});

test('recoveryReinit: no turn header exceeds the watermark -> cursor at EOF of newest raw file', async () => {
  const vault = makeVault();
  // W = 2026-08-20T00:00:00.000Z; threshold = 2026-08-18T00:00:00.000Z; all turns predate it.
  await writeSessionFile(
    vault,
    'session-2026-08-20-aaaaaaaa.md',
    '---\ntype: session_summary\ncovers_until: 2026-08-20T00:00:00.000Z\n---\nbody',
  );
  await writeRawFile(vault, '2026-08-10.md', turnHeader('2026-08-10T00:00:00.000Z', 'user') + '\nold\n\n');
  const newestContent = turnHeader('2026-08-12T00:00:00.000Z', 'assistant') + '\nstill old\n\n';
  await writeRawFile(vault, '2026-08-12.md', newestContent);

  const cursor = await recoveryReinit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '2026-08-12.md');
  assert.equal(cursor.offset, Buffer.byteLength(newestContent, 'utf8'));
  assert.equal(cursor.boundary, 'turn');
});

test('recoveryReinit: headerless legacy raw file present -> cursor lands at its start, never EOF-skipped', async () => {
  const vault = makeVault();
  // W = 2026-08-20T00:00:00.000Z; threshold = 2026-08-18T00:00:00.000Z.
  // The oldest raw file is a pre-header-format legacy blob with ZERO turn
  // header matches at all — it must never be silently declared "digested"
  // by falling through to EOF-of-newest; the never-skip invariant requires
  // landing at its start so it gets re-read.
  await writeSessionFile(
    vault,
    'session-2026-08-20-aaaaaaaa.md',
    '---\ntype: session_summary\ncovers_until: 2026-08-20T00:00:00.000Z\n---\nbody',
  );
  await writeRawFile(vault, '2026-08-10.md', 'plain legacy text, no turn headers at all here.\n');
  await writeRawFile(vault, '2026-08-12.md', turnHeader('2026-08-12T00:00:00.000Z', 'assistant') + '\nold, has headers\n\n');

  const cursor = await recoveryReinit({ vaultDir: vault, project: PROJECT });
  assert.equal(cursor.file, '2026-08-10.md');
  assert.equal(cursor.offset, 0);
  assert.equal(cursor.boundary, 'turn');
});

// ===========================================================================
// Section G — loadCursor's own bootstrap-on-missing-cursor-file path.
// ===========================================================================

test('loadCursor: cursor.json itself missing (first-ever run) -> bootstrap, reinitialized true', async () => {
  const vault = makeVault();
  await writeRawFile(vault, '2026-08-01.md', 'x');
  const result = await loadCursor({ vaultDir: vault, project: PROJECT });
  assert.equal(result.reinitialized, true);
  assert.equal(result.reason, 'bootstrap');
  assert.equal(result.cursor.file, '2026-08-01.md');
  assert.equal(result.cursor.offset, 0);
});

// ===========================================================================
// Section H — advanceCursor.
// ===========================================================================

test('advanceCursor: atomic write — tmp file gone after, content round-trips, updated_at set', async () => {
  const vault = makeVault();
  const before = Date.now();
  const written = await advanceCursor({
    vaultDir: vault,
    project: PROJECT,
    cursor: {
      file: '2026-08-14.md',
      offset: 182034,
      boundary: 'turn',
      last_turn_iso: '2026-08-14T22:41:03.512Z',
      last_summary_id: 'session-2026-08-15-ab12cd34',
    },
  });
  const after = Date.now();

  const cp = cursorPath(vault);
  const tmpExists = await fs.stat(cp + '.tmp').then(() => true, () => false);
  assert.equal(tmpExists, false);

  const onDisk = JSON.parse(await fs.readFile(cp, 'utf8'));
  assert.deepEqual(onDisk, written);
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.file, '2026-08-14.md');
  assert.equal(onDisk.offset, 182034);
  assert.equal(onDisk.boundary, 'turn');
  assert.equal(onDisk.last_turn_iso, '2026-08-14T22:41:03.512Z');
  assert.equal(onDisk.last_summary_id, 'session-2026-08-15-ab12cd34');

  const updatedAtMs = Date.parse(onDisk.updated_at);
  assert.ok(updatedAtMs >= before && updatedAtMs <= after, 'updated_at must be set to "now"');
});

test('advanceCursor: second call overwrites content (rename replaces, not appends)', async () => {
  const vault = makeVault();
  await advanceCursor({
    vaultDir: vault,
    project: PROJECT,
    cursor: { file: '2026-08-14.md', offset: 100, boundary: 'turn', last_turn_iso: null, last_summary_id: null },
  });
  await advanceCursor({
    vaultDir: vault,
    project: PROJECT,
    cursor: { file: '2026-08-15.md', offset: 200, boundary: 'turn', last_turn_iso: null, last_summary_id: null },
  });
  const onDisk = JSON.parse(await fs.readFile(cursorPath(vault), 'utf8'));
  assert.equal(onDisk.file, '2026-08-15.md');
  assert.equal(onDisk.offset, 200);
});

test('advanceCursor: missing last_turn_iso/last_summary_id default to null', async () => {
  const vault = makeVault();
  const written = await advanceCursor({
    vaultDir: vault,
    project: PROJECT,
    cursor: { file: '2026-08-14.md', offset: 0, boundary: 'turn' },
  });
  assert.equal(written.last_turn_iso, null);
  assert.equal(written.last_summary_id, null);
});
