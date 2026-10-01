// server/test/layers.test.mjs — Task 10 (PR-3, spec §6): unit suite for
// server/lib/layers.mjs's buildLayers(), the filesystem-mtime per-layer
// freshness block. This is the component that would have caught the
// 2026-08-04 outage (spec §11.3) — the stale-rule matrix below (especially
// the ∞-sign cases) is the point of this file, not incidental coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers/tmpdir.mjs';
import { buildLayers, LAYERS_SCAN_LIMIT } from '../lib/layers.mjs';

const MS_PER_HOUR = 3_600_000;
const CONFIG = { min_transcript_bytes: 500 };

function rawDir(vault, project) {
  return path.join(vault, 'captures', project, 'raw');
}
function sessionsDir(vault, project) {
  return path.join(vault, 'sessions', project);
}
function stateDir(vault, project) {
  return path.join(vault, 'state', project);
}

async function writeRawFile(vault, project, filename, content, mtime) {
  const dir = rawDir(vault, project);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await fs.writeFile(p, content, 'utf8');
  if (mtime) await fs.utimes(p, mtime, mtime);
  return p;
}

async function writeSessionFile(vault, project, filename, mtime) {
  const dir = sessionsDir(vault, project);
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, filename);
  await fs.writeFile(p, '# session\n', 'utf8');
  if (mtime) await fs.utimes(p, mtime, mtime);
  return p;
}

async function writeCursor(vault, project, overrides = {}) {
  const dir = stateDir(vault, project);
  await fs.mkdir(dir, { recursive: true });
  const base = {
    schema_version: 1,
    file: '2026-08-01.md',
    offset: 0,
    boundary: 'turn',
    last_turn_iso: null,
    last_summary_id: null,
    updated_at: new Date().toISOString(),
  };
  const obj = { ...base, ...overrides };
  await fs.writeFile(path.join(dir, 'checkpoint-cursor.json'), JSON.stringify(obj), 'utf8');
  return obj;
}

function iso(s) { return new Date(s); }

// ===========================================================================
// Stale-rule matrix
// ===========================================================================

test('stale rule: never-checkpointed project with pending content ⇒ stale (∞-lag direction)', async () => {
  const vault = tempDir('um-layers-');
  // No cursor, no session summaries — digested_through resolves to null on
  // BOTH candidate sources, so lag must be +Infinity, not -Infinity/NaN.
  await writeRawFile(vault, 'proj', '2026-08-04.md', 'x'.repeat(1000), iso('2026-08-04T12:00:00Z'));
  const { layers, degraded } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(degraded.length, 0);
  assert.ok(layers.proj, 'project appears in the block');
  assert.equal(layers.proj.stale, true, 'pending content + never-digested ⇒ maximally stale');
  assert.equal(layers.proj.lag_hours, 'Infinity', 'the ∞ sits on lag, serialized as the string "Infinity"');
});

test('stale rule: both digested_through candidates null AND no pending ⇒ NOT stale (bytes arm blocks it)', async () => {
  const vault = tempDir('um-layers-');
  // Tiny raw file (well under the 500-byte floor) — proves lag=∞ alone does
  // not force staleness; the AND with the bytes arm must hold.
  await writeRawFile(vault, 'proj', '2026-08-04.md', 'hi', iso('2026-08-04T12:00:00Z'));
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(layers.proj.lag_hours, 'Infinity', 'sanity: lag is still ∞ on this fixture');
  assert.equal(layers.proj.stale, false, 'pending_bytes < floor ⇒ never stale, even at infinite lag');
});

test('thin-noise guard: the §6 "tmp, 8KB" case — pending below the configured floor never goes stale', async () => {
  const vault = tempDir('um-layers-');
  // 8KB of real pending content, huge lag (no cursor, no summary) — but the
  // floor for THIS fixture is configured well above 8KB, so the bytes arm
  // must block staleness regardless of how stale the lag looks.
  await writeRawFile(vault, 'tmp', '2026-08-04.md', 'x'.repeat(8192), iso('2026-08-04T12:00:00Z'));
  const { layers } = await buildLayers({ vaultDir: vault, config: { min_transcript_bytes: 500_000 } });
  assert.equal(layers.tmp.pending_bytes, 8192);
  assert.equal(layers.tmp.lag_hours, 'Infinity');
  assert.equal(layers.tmp.stale, false, 'thin content thin-abstains forever — never becomes stale noise');
});

test('cursor-watermark lag: fresh summary mtime but an OLD cursor.last_turn_iso + big pending ⇒ STALE', async () => {
  const vault = tempDir('um-layers-');
  // A half-drained project: the session summary file was touched RECENTLY
  // (would read fresh if last_summary_at were used directly), but the
  // cursor's content watermark is old and a large chunk is still pending —
  // exactly the failure mode summary-mtime alone would miss.
  await writeRawFile(vault, 'proj', '2026-08-14.md', 'x'.repeat(5000), iso('2026-08-14T12:00:00Z'));
  await writeSessionFile(vault, 'proj', 'session-2026-08-14-aaaa1111.md', iso('2026-08-14T11:00:00Z'));
  await writeCursor(vault, 'proj', {
    file: '2026-08-01.md',
    offset: 0,
    last_turn_iso: '2026-08-01T00:00:00.000Z', // ~13 days behind last_capture_at
  });
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.ok(layers.proj.pending_bytes >= 500, 'sanity: well over the floor');
  assert.equal(layers.proj.stale, true, 'the cursor watermark overrides the fresh-looking summary mtime');
  assert.ok(layers.proj.lag_hours > 30, 'lag reflects the cursor watermark, not the recent summary touch');
});

test('threshold boundary: lag exactly at UM_SUMMARY_LAG_MAX_HOURS is NOT stale (strict >)', async () => {
  const vault = tempDir('um-layers-');
  const digested = iso('2026-08-01T00:00:00.000Z');
  const captured = new Date(digested.getTime() + 30 * MS_PER_HOUR); // exactly 30h lag
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'x'.repeat(5000), captured);
  await writeCursor(vault, 'proj', { file: '2026-07-01.md', offset: 0, last_turn_iso: digested.toISOString() });
  const prevEnv = process.env.UM_SUMMARY_LAG_MAX_HOURS;
  process.env.UM_SUMMARY_LAG_MAX_HOURS = '30';
  try {
    // #314: stale is age-based now, and this headerless fixture's content waits from dayStart
    // (08-02T00:00); `now` puts that wait exactly at the threshold too, so the strict-> boundary
    // holds under both rules instead of depending on the wall clock.
    const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG, now: Date.parse('2026-08-03T06:00:00.000Z') });
    assert.equal(layers.proj.lag_hours, 30);
    assert.equal(layers.proj.stale, false, 'lag == threshold must not fire (strict >)');
  } finally {
    if (prevEnv === undefined) delete process.env.UM_SUMMARY_LAG_MAX_HOURS;
    else process.env.UM_SUMMARY_LAG_MAX_HOURS = prevEnv;
  }
});

test('threshold boundary: lag just OVER UM_SUMMARY_LAG_MAX_HOURS IS stale', async () => {
  const vault = tempDir('um-layers-');
  const digested = iso('2026-08-01T00:00:00.000Z');
  const captured = new Date(digested.getTime() + 30 * MS_PER_HOUR + 6 * 60_000); // 30h6m
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'x'.repeat(5000), captured);
  await writeCursor(vault, 'proj', { file: '2026-07-01.md', offset: 0, last_turn_iso: digested.toISOString() });
  const prevEnv = process.env.UM_SUMMARY_LAG_MAX_HOURS;
  process.env.UM_SUMMARY_LAG_MAX_HOURS = '30';
  try {
    const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
    assert.ok(layers.proj.lag_hours > 30);
    assert.equal(layers.proj.stale, true, 'lag just over the threshold fires');
  } finally {
    if (prevEnv === undefined) delete process.env.UM_SUMMARY_LAG_MAX_HOURS;
    else process.env.UM_SUMMARY_LAG_MAX_HOURS = prevEnv;
  }
});

test('UM_SUMMARY_LAG_MAX_HOURS: unset falls back to the spec default of 30', async () => {
  const vault = tempDir('um-layers-');
  const digested = iso('2026-08-01T00:00:00.000Z');
  const captured = new Date(digested.getTime() + 31 * MS_PER_HOUR);
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'x'.repeat(5000), captured);
  await writeCursor(vault, 'proj', { file: '2026-07-01.md', offset: 0, last_turn_iso: digested.toISOString() });
  const prevEnv = process.env.UM_SUMMARY_LAG_MAX_HOURS;
  delete process.env.UM_SUMMARY_LAG_MAX_HOURS;
  try {
    const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
    assert.equal(layers.proj.stale, true, '31h > default 30h threshold');
  } finally {
    if (prevEnv !== undefined) process.env.UM_SUMMARY_LAG_MAX_HOURS = prevEnv;
  }
});

// ===========================================================================
// Review round 1 fixes
// ===========================================================================

test('IMPORTANT 1 (reviewer P-A probe): a future-dated cursor.file beyond every raw file falls through to the cursorless bootstrap computation ⇒ STALE, never a silent pending_bytes:0 green', async () => {
  const vault = tempDir('um-layers-');
  // Old raw content, huge real lag — but the cursor CLAIMS to be digested
  // through a day that doesn't exist and is newer than everything on disk.
  // A naive positional scan puts every real raw file into the `name <
  // cursor.file` branch (already-digested) — pending_bytes 0, stale:false,
  // even though nothing has actually been read in 44 days.
  await writeRawFile(vault, 'proj', '2026-06-01.md', 'x'.repeat(5000), iso('2026-06-01T09:00:00Z'));
  await writeCursor(vault, 'proj', {
    file: '2099-12-31.md', // sorts after every real raw file — poisoned
    offset: 0,
    last_turn_iso: '2026-06-01T00:00:00.000Z',
  });
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.ok(layers.proj, 'the project still appears');
  assert.ok(layers.proj.pending_bytes > 0, 'pending_bytes must NOT silently collapse to 0');
  assert.equal(layers.proj.stale, true, 'huge real lag + real pending content must fire, not go silently green');
});

test('IMPORTANT 1: a cursor.file exactly equal to the newest raw file is NOT treated as poisoned (boundary — only strictly-greater invalidates)', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'x'.repeat(1000));
  await writeCursor(vault, 'proj', { file: '2026-08-01.md', offset: 400, last_turn_iso: new Date().toISOString() });
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(layers.proj.pending_bytes, 600, 'the real (non-poisoned) cursor arithmetic still applies at the boundary');
});

test('MINOR 1 (reviewer P-D probe): last_capture_at is the TRUE newest mtime across raw files, not the lexically-last filename\'s mtime', async () => {
  const vault = tempDir('um-layers-');
  // An OLDER-named file with a NEWER mtime (e.g. a backfill/rewrite that
  // touched an earlier day-file after a later-dated one already existed) —
  // last_capture_at must reflect the true newest mtime, not assume the
  // lexically-last filename is also the most recently touched.
  await writeRawFile(vault, 'proj', '2026-08-04.md', 'x'.repeat(600), iso('2026-08-04T09:00:00Z'));
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'x'.repeat(600), iso('2026-08-10T09:00:00Z')); // touched LATER
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(layers.proj.last_capture_at, new Date('2026-08-10T09:00:00Z').toISOString(),
    'the true newest mtime (08-10, on the older-named file) must win, not 08-04 from the lexically-last filename');
});

test('MINOR 2: `stale` compares the UNROUNDED lag — a true 30.04h lag against a 30h threshold fires even though the DISPLAYED lag_hours rounds to 30.0', async () => {
  const vault = tempDir('um-layers-');
  const digested = iso('2026-08-01T00:00:00.000Z');
  // 30h + 144000ms (2.4 min) = 30.04h exactly.
  const captured = new Date(digested.getTime() + 30 * MS_PER_HOUR + 144_000);
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'x'.repeat(5000), captured);
  await writeCursor(vault, 'proj', { file: '2026-07-01.md', offset: 0, last_turn_iso: digested.toISOString() });
  const prevEnv = process.env.UM_SUMMARY_LAG_MAX_HOURS;
  process.env.UM_SUMMARY_LAG_MAX_HOURS = '30';
  try {
    const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
    assert.equal(layers.proj.lag_hours, 30, 'DISPLAYED lag rounds down to 30.0 (round1(30.04) === 30)');
    assert.equal(layers.proj.stale, true, 'but the comparison itself must use the UNROUNDED 30.04h, which IS over the 30h threshold');
  } finally {
    if (prevEnv === undefined) delete process.env.UM_SUMMARY_LAG_MAX_HOURS;
    else process.env.UM_SUMMARY_LAG_MAX_HOURS = prevEnv;
  }
});

test('MINOR 3: pending_bytes exactly EQUAL to the floor is stale-eligible (>=, not >) — the boundary a >/>= mutation would silently pass otherwise', async () => {
  const vault = tempDir('um-layers-');
  // No cursor, no summary ⇒ ∞ lag (well over any finite threshold); pending
  // bytes is set to EXACTLY the configured floor.
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'x'.repeat(500), iso('2026-08-01T00:00:00Z'));
  const { layers } = await buildLayers({ vaultDir: vault, config: { min_transcript_bytes: 500 } });
  assert.equal(layers.proj.pending_bytes, 500);
  assert.equal(layers.proj.stale, true, 'pending_bytes == floor must still count — the arm is >=');
});

test('MINOR 3 companion: pending_bytes one byte UNDER the floor is never stale, even at ∞ lag', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'x'.repeat(499), iso('2026-08-01T00:00:00Z'));
  const { layers } = await buildLayers({ vaultDir: vault, config: { min_transcript_bytes: 500 } });
  assert.equal(layers.proj.pending_bytes, 499);
  assert.equal(layers.proj.stale, false);
});

// ===========================================================================
// §11.3 counterfactual — the 2026-08-04 outage replay
// ===========================================================================

test('§11.3 counterfactual: a vault shaped like 2026-08-04 (captures through 08-04, newest summary 07-30, no cursor) ⇒ stale', async () => {
  const vault = tempDir('um-layers-');
  // Captures kept landing daily through the outage; nothing downstream
  // advanced. No cursor exists (pre-chunking server never wrote one).
  await writeRawFile(vault, 'universal-memory', '2026-07-28.md', 'x'.repeat(2000), iso('2026-07-28T10:00:00Z'));
  await writeRawFile(vault, 'universal-memory', '2026-08-01.md', 'x'.repeat(3000), iso('2026-08-01T10:00:00Z'));
  await writeRawFile(vault, 'universal-memory', '2026-08-04.md', 'x'.repeat(4000), iso('2026-08-04T09:00:00Z'));
  await writeSessionFile(vault, 'universal-memory', 'session-2026-07-30-cafe0001.md', iso('2026-07-30T08:00:00Z'));
  const { layers, degraded } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(degraded.length, 0);
  const entry = layers['universal-memory'];
  assert.ok(entry, 'universal-memory appears in the layers block');
  assert.equal(entry.last_capture_at, new Date('2026-08-04T09:00:00Z').toISOString());
  assert.equal(entry.last_summary_at, new Date('2026-07-30T08:00:00Z').toISOString());
  assert.equal(entry.stale, true, 'the exact 08-04 outage shape must be marked stale');
  assert.ok(entry.lag_hours > 24 * 4, 'lag is on the order of days (~5d per spec §6), not hours');
});

// ===========================================================================
// pending_bytes arithmetic
// ===========================================================================

test('pending_bytes: cursor present — partial-file arithmetic (size - offset) plus full later files', async () => {
  const vault = tempDir('um-layers-');
  const day1 = await writeRawFile(vault, 'proj', '2026-08-01.md', 'a'.repeat(1000));
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'b'.repeat(700));
  await writeRawFile(vault, 'proj', '2026-08-03.md', 'c'.repeat(300));
  const day1Size = (await fs.stat(day1)).size;
  await writeCursor(vault, 'proj', { file: '2026-08-01.md', offset: 400, last_turn_iso: '2026-08-01T00:00:00.000Z' });
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  // (day1Size - 400) + 700 (all of day2) + 300 (all of day3)
  assert.equal(layers.proj.pending_bytes, (day1Size - 400) + 700 + 300);
});

test('pending_bytes: a raw file strictly before cursor.file contributes 0', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'a'.repeat(1000)); // fully digested
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'b'.repeat(200));
  await writeCursor(vault, 'proj', { file: '2026-08-02.md', offset: 0, last_turn_iso: '2026-08-02T00:00:00.000Z' });
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(layers.proj.pending_bytes, 200, 'the 08-01 file below the cursor must not be counted');
});

test('pending_bytes: cursorless with session summaries — §4.3 bootstrap boundary (newest summary day re-digested in full)', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'a'.repeat(1000)); // strictly before boundary day — digested
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'b'.repeat(600)); // the boundary day itself — re-digested in full
  await writeRawFile(vault, 'proj', '2026-08-03.md', 'c'.repeat(400)); // after the boundary day — pending
  await writeSessionFile(vault, 'proj', 'session-2026-08-02-beef0002.md');
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(layers.proj.pending_bytes, 600 + 400, '08-01 excluded; 08-02 (boundary day) and 08-03 counted in full');
});

test('pending_bytes: cursorless with NO session summaries at all — full history is pending', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'a'.repeat(300));
  await writeRawFile(vault, 'proj', '2026-08-02.md', 'b'.repeat(700));
  const { layers } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.equal(layers.proj.pending_bytes, 1000, 'no summaries ever ⇒ digest the whole history');
});

test('saturation flag: scanLimit hit ⇒ layers_saturated, remaining projects not scanned', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj-a', '2026-08-01.md', 'x'.repeat(600));
  await writeRawFile(vault, 'proj-b', '2026-08-01.md', 'x'.repeat(600));
  await writeRawFile(vault, 'proj-c', '2026-08-01.md', 'x'.repeat(600));
  // proj-a alone consumes 1 readdir entry against the budget; a scanLimit of
  // 1 lets proj-a complete, then stops before proj-b/proj-c are touched.
  const { layers, degraded } = await buildLayers({ vaultDir: vault, config: CONFIG, scanLimit: 1 });
  assert.ok(degraded.includes('layers_saturated'));
  const seen = Object.keys(layers).length;
  assert.ok(seen < 3, `expected fewer than all 3 projects scanned under a tight budget, got ${seen}`);
});

test('LAYERS_SCAN_LIMIT default export is a sane, generous ceiling', () => {
  assert.equal(LAYERS_SCAN_LIMIT, 10000);
});

// ===========================================================================
// Fail-soft
// ===========================================================================

test('fail-soft: a per-project I/O error omits that project and sets degraded layers-partial; other projects unaffected', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'goodproject', '2026-08-01.md', 'x'.repeat(600));
  // Force a real (non-ENOENT) fs error for 'badproject': its raw/ path has
  // a FILE sitting where a directory is expected, so readdir throws ENOTDIR
  // — deterministic and cross-platform, unlike relying on chmod/EACCES.
  const badProjectDir = path.join(vault, 'captures', 'badproject');
  await fs.mkdir(badProjectDir, { recursive: true });
  await fs.writeFile(path.join(badProjectDir, 'raw'), 'not a directory', 'utf8');

  const { layers, degraded } = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.ok(layers.goodproject, 'the healthy project still appears');
  assert.equal(layers.badproject, undefined, 'the broken project is omitted, never guessed at');
  assert.ok(degraded.includes('layers-partial'));
});

test('fail-soft: the payload never throws even when the whole captures/ dir is unreadable (ENOTDIR)', async () => {
  const vault = tempDir('um-layers-');
  await fs.mkdir(vault, { recursive: true });
  // captures/ itself is a FILE, not a directory — top-level readdir throws
  // ENOTDIR (not ENOENT), the real-failure branch.
  await fs.writeFile(path.join(vault, 'captures'), 'not a directory', 'utf8');
  const result = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.deepEqual(result.layers, { __proto__: null });
  assert.deepEqual(result.degraded, ['layers-unavailable']);
});

test('vaultDir absent (undefined) ⇒ empty layers, NOT degraded — unreachable-in-production shape', async () => {
  const result = await buildLayers({ vaultDir: undefined, config: CONFIG });
  assert.deepEqual(result.layers, { __proto__: null });
  assert.deepEqual(result.degraded, []);
});

test('captures/ directory genuinely never created (ENOENT) ⇒ empty layers, NOT degraded — "0 projects" is a real, successfully-determined truth', async () => {
  const vault = tempDir('um-layers-'); // exists, but no captures/ subdir ever created
  const result = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.deepEqual(result.layers, { __proto__: null });
  assert.deepEqual(result.degraded, []);
});

// Review fix (#314): PROJECT_SLUG_RE admits `__proto__`. On a plain-object map that key hits the
// prototype setter, so the layer vanished from the payload — never shown, never swept, never
// stale (the v1.8.1 hostile-key class stats.mjs already guards with null-prototype maps).
test('a project named __proto__ is served as data, not swallowed by the prototype setter', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, '__proto__', '2026-09-27.md', `## 2026-09-27T01:00:00.000Z user\n${'x'.repeat(600)}\n\n`, iso('2026-09-27T01:00:00Z'));
  const result = await buildLayers({ vaultDir: vault, config: CONFIG, now: Date.parse('2026-09-28T12:00:00.000Z') });
  assert.ok(Object.hasOwn(result.layers, '__proto__'), 'an own key, not the map\'s prototype');
  assert.equal(result.layers.__proto__.undigested, true);
  assert.equal(result.layers.__proto__.stale, true);
  assert.deepEqual(result.degraded, []);
});

test('a project directory with no raw/ captures at all is simply absent from the block (not an error)', async () => {
  const vault = tempDir('um-layers-');
  await fs.mkdir(path.join(vault, 'captures', 'empty-project'), { recursive: true }); // exists, no raw/ subdir
  const result = await buildLayers({ vaultDir: vault, config: CONFIG });
  assert.deepEqual(result.layers, { __proto__: null });
  assert.deepEqual(result.degraded, []);
});

// ===========================================================================
// config / floor resolution
// ===========================================================================

test('min_transcript_bytes: env override wins over config', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'x'.repeat(200));
  const prevEnv = process.env.UM_CHECKPOINT_MIN_TRANSCRIPT_BYTES;
  process.env.UM_CHECKPOINT_MIN_TRANSCRIPT_BYTES = '100';
  try {
    const { layers } = await buildLayers({ vaultDir: vault, config: { min_transcript_bytes: 100000 } });
    // pending (200 bytes, no summary/cursor ⇒ full history pending) is over
    // the ENV floor (100) but would be under the CONFIG floor (100000) —
    // lag is also ∞ (no cursor/summary), so this only proves which floor won
    // if bytes actually gate it: 200 >= 100 ⇒ bytes arm passes.
    assert.equal(layers.proj.pending_bytes, 200);
    assert.equal(layers.proj.stale, true, 'env floor (100) governs, not the config floor (100000)');
  } finally {
    if (prevEnv === undefined) delete process.env.UM_CHECKPOINT_MIN_TRANSCRIPT_BYTES;
    else process.env.UM_CHECKPOINT_MIN_TRANSCRIPT_BYTES = prevEnv;
  }
});

test('min_transcript_bytes: omitted config falls back to DEFAULT_MIN_TRANSCRIPT_BYTES (500), never throws', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'proj', '2026-08-01.md', 'x'.repeat(600));
  const result = await buildLayers({ vaultDir: vault }); // no config at all — reads config/checkpoint.json itself
  assert.ok(result.layers.proj, 'buildLayers reads its own config default without throwing');
});

// ===========================================================================
// #314 — undigested, waiting_since, age_hours, the age-based stale rule and the
// repair arm (spec §4.2.7, L01–L21). `now` is injected as a fixed ms throughout.
// ===========================================================================

const NOW = Date.parse('2026-09-28T12:00:00.000Z');

/** One raw turn exactly as doAppendTurn writes it: header line, content, blank line. */
function turn(isoStr, content = 'x'.repeat(600), role = 'user') {
  return `## ${isoStr} ${role}\n${content}\n\n`;
}
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const layersAt = (vault, now, config = CONFIG) => buildLayers({ vaultDir: vault, config, now });
const hoursBeforeNow = (h) => new Date(NOW - h * MS_PER_HOUR).toISOString();

async function withLagMax(value, fn) {
  const prev = process.env.UM_SUMMARY_LAG_MAX_HOURS;
  process.env.UM_SUMMARY_LAG_MAX_HOURS = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.UM_SUMMARY_LAG_MAX_HOURS;
    else process.env.UM_SUMMARY_LAG_MAX_HOURS = prev;
  }
}

async function writeRepairEntry(vault, project, id, entry) {
  const dir = path.join(stateDir(vault, project), 'pending-reindex');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(entry), 'utf8');
}

test('L01 #314: with a cursor, undigested is the exact positional pending against the floor', async () => {
  const vault = tempDir('um-layers-');
  const t1 = turn('2026-09-27T01:00:00.000Z', 'a'.repeat(300));
  const t2 = turn('2026-09-27T02:00:00.000Z', 'b'.repeat(600));
  await writeRawFile(vault, 'p', '2026-09-27.md', t1 + t2, iso('2026-09-27T02:00:00Z'));
  await writeCursor(vault, 'p', { file: '2026-09-27.md', offset: bytes(t1), last_turn_iso: '2026-09-27T01:00:00.000Z', updated_at: '2026-09-27T01:30:00.000Z' });
  const at = await layersAt(vault, NOW, { min_transcript_bytes: bytes(t2) });
  assert.equal(at.layers.p.pending_bytes, bytes(t2));
  assert.equal(at.layers.p.undigested, true, 'pending == floor ⇒ undigested');
  const over = await layersAt(vault, NOW, { min_transcript_bytes: bytes(t2) + 1 });
  assert.equal(over.layers.p.undigested, false, 'one byte under the floor ⇒ not undigested');
  assert.equal(over.layers.p.waiting_since, null);
  assert.equal(over.layers.p.age_hours, null);
  assert.equal(over.layers.p.stale, false);
});

test('L02 #314: a cursorless phantom (newest summary written after the last capture) is not undigested', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-20.md', turn('2026-09-20T09:00:00.000Z'), iso('2026-09-20T10:00:00Z'));
  await writeSessionFile(vault, 'p', 'session-2026-09-20-aaaa0001.md', iso('2026-09-21T09:00:00Z'));
  const { layers } = await layersAt(vault, NOW);
  assert.ok(layers.p.pending_bytes >= 500, 'sanity: the bootstrap boundary still counts the summary day as pending');
  assert.equal(layers.p.undigested, false);
  assert.equal(layers.p.waiting_since, null);
  assert.equal(layers.p.stale, false);
});

test('L03 #314: cursorless with a capture after the newest summary is undigested, waiting since last_summary_at', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-20.md', turn('2026-09-20T09:00:00.000Z'), iso('2026-09-20T10:00:00Z'));
  await writeSessionFile(vault, 'p', 'session-2026-09-21-aaaa0002.md', iso('2026-09-21T09:00:00Z'));
  await writeRawFile(vault, 'p', '2026-09-26.md', turn('2026-09-26T09:00:00.000Z'), iso('2026-09-26T10:00:00Z'));
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.undigested, true);
  assert.equal(layers.p.waiting_since, '2026-09-21T09:00:00.000Z');
  assert.equal(layers.p.age_hours, 171);
  assert.equal(layers.p.stale, true);
});

test('L04 #314: never summarized ⇒ undigested, aged from the oldest raw file’s first header', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-25.md', turn('2026-09-25T08:00:00.000Z'), iso('2026-09-25T09:00:00Z'));
  await writeRawFile(vault, 'p', '2026-09-27.md', turn('2026-09-27T08:00:00.000Z'), iso('2026-09-27T09:00:00Z'));
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.undigested, true);
  assert.equal(layers.p.waiting_since, '2026-09-25T08:00:00.000Z');
  assert.equal(layers.p.age_hours, 76);
  assert.equal(layers.p.stale, true);
});

test('L05 #314: a cursor layer is aged from the first pending header at the cursor offset, not from digested_through', async () => {
  const vault = tempDir('um-layers-');
  const t1 = turn('2026-09-26T01:00:00.000Z', 'a'.repeat(300));
  const t2 = turn('2026-09-26T05:00:00.000Z');
  await writeRawFile(vault, 'p', '2026-09-26.md', t1 + t2, iso('2026-09-26T05:30:00Z'));
  await writeCursor(vault, 'p', { file: '2026-09-26.md', offset: bytes(t1), last_turn_iso: '2026-09-26T01:00:00.000Z', updated_at: '2026-09-26T01:30:00.000Z' });
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.waiting_since, '2026-09-26T05:00:00.000Z');
  assert.equal(layers.p.age_hours, 55);
  assert.equal(layers.p.stale, true);
});

test('L06 #314: the first pending position rolls to the next raw file when the cursor sits at end of file', async () => {
  const vault = tempDir('um-layers-');
  const t1 = turn('2026-09-25T10:00:00.000Z');
  await writeRawFile(vault, 'p', '2026-09-25.md', t1, iso('2026-09-25T10:30:00Z'));
  await writeRawFile(vault, 'p', '2026-09-26.md', turn('2026-09-26T03:00:00.000Z'), iso('2026-09-26T03:30:00Z'));
  await writeCursor(vault, 'p', { file: '2026-09-25.md', offset: bytes(t1), last_turn_iso: '2026-09-25T10:00:00.000Z', updated_at: '2026-09-25T11:00:00.000Z' });
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.undigested, true);
  assert.equal(layers.p.waiting_since, '2026-09-26T03:00:00.000Z');
  assert.equal(layers.p.age_hours, 57);
});

test('L07 #314: the quiet frozen-lag class — lag 10 h, but the oldest pending content waited 40 h ⇒ stale', async () => {
  const vault = tempDir('um-layers-');
  const t1 = turn('2026-09-26T12:00:00.000Z', 'a'.repeat(300)); // digested: the cursor's last_turn_iso
  const t2 = turn('2026-09-26T20:00:00.000Z', 'b'.repeat(400)); // first pending — deliberately not the last digest
  const t3 = turn('2026-09-26T22:00:00.000Z', 'c'.repeat(400)); // the last capture, then quiet
  await writeRawFile(vault, 'p', '2026-09-26.md', t1 + t2 + t3, iso('2026-09-26T22:00:00Z'));
  await writeCursor(vault, 'p', { file: '2026-09-26.md', offset: bytes(t1), last_turn_iso: '2026-09-26T12:00:00.000Z', updated_at: '2026-09-26T12:30:00.000Z' });
  await withLagMax('30', async () => {
    const { layers } = await layersAt(vault, NOW);
    assert.equal(layers.p.lag_hours, 10, 'sanity: the lag froze under the threshold when capture stopped');
    assert.equal(layers.p.waiting_since, '2026-09-26T20:00:00.000Z');
    assert.equal(layers.p.age_hours, 40);
    assert.equal(layers.p.stale, true);
  });
});

test('L08 #314: reopened after a gap — digested 72 h ago, first pending header 1 h ago ⇒ age 1 h, not stale', async () => {
  const vault = tempDir('um-layers-');
  const t1 = turn('2026-09-25T12:00:00.000Z');
  await writeRawFile(vault, 'p', '2026-09-25.md', t1, iso('2026-09-25T12:00:30Z'));
  await writeRawFile(vault, 'p', '2026-09-28.md', turn('2026-09-28T11:00:00.000Z'), iso('2026-09-28T11:00:30Z'));
  await writeCursor(vault, 'p', { file: '2026-09-25.md', offset: bytes(t1), last_turn_iso: '2026-09-25T12:00:00.000Z', updated_at: '2026-09-25T12:05:00.000Z' });
  await withLagMax('30', async () => {
    const { layers } = await layersAt(vault, NOW);
    assert.ok(layers.p.lag_hours > 30, 'sanity: the lag rule reads this layer stale (it counts the quiet gap)');
    assert.equal(layers.p.undigested, true);
    assert.equal(layers.p.waiting_since, '2026-09-28T11:00:00.000Z');
    assert.equal(layers.p.age_hours, 1);
    assert.equal(layers.p.stale, false);
  });
});

test('L09 #314: a future-dated client header is clamped to min(dayEnd(F), now)', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-26.md', turn('2026-10-26T00:00:00.000Z'), iso('2026-09-26T08:00:00Z'));
  await withLagMax('30', async () => {
    const after = await layersAt(vault, NOW);
    assert.equal(after.layers.p.waiting_since, '2026-09-27T00:00:00.000Z', 'now is past F: the clamp is dayEnd(F)');
    assert.equal(after.layers.p.age_hours, 36);
    assert.equal(after.layers.p.stale, true);
    const within = await layersAt(vault, Date.parse('2026-09-26T15:00:00.000Z'));
    assert.equal(within.layers.p.waiting_since, '2026-09-26T15:00:00.000Z', 'now is inside F: the clamp is now');
    assert.equal(within.layers.p.age_hours, 0);
    assert.equal(within.layers.p.stale, false);
  });
});

test('L10 #314: a past-dated client header is clamped to dayStart(F)', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-26.md', turn('2026-01-01T00:00:00.000Z'), iso('2026-09-26T08:00:00Z'));
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.waiting_since, '2026-09-26T00:00:00.000Z');
  assert.equal(layers.p.age_hours, 60);
  assert.equal(layers.p.stale, true);
});

test('L11 #314: a missing or unparseable header at the first pending position ⇒ dayStart(F)', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'nohdr', '2026-09-26.md', 'legacy line without a header\n' + 'x'.repeat(600), iso('2026-09-26T08:00:00Z'));
  await writeRawFile(vault, 'badiso', '2026-09-26.md', turn('2026-09-99T99:99:99Z'), iso('2026-09-26T08:00:00Z'));
  const { layers } = await layersAt(vault, NOW);
  for (const p of ['nohdr', 'badiso']) {
    assert.equal(layers[p].waiting_since, '2026-09-26T00:00:00.000Z', p);
    assert.equal(layers[p].age_hours, 60, p);
  }
});

test('L12 #314: the age threshold compares unrounded — 30.04 h is stale, 29.99 h is not, both display 30', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-26.md', turn('2026-09-26T00:00:00.000Z'), iso('2026-09-26T00:00:30Z'));
  const h = Date.parse('2026-09-26T00:00:00.000Z');
  await withLagMax('30', async () => {
    const over = await layersAt(vault, h + 30 * MS_PER_HOUR + 144_000);
    assert.equal(over.layers.p.age_hours, 30);
    assert.equal(over.layers.p.stale, true);
    const under = await layersAt(vault, h + 30 * MS_PER_HOUR - 36_000);
    assert.equal(under.layers.p.age_hours, 30);
    assert.equal(under.layers.p.stale, false);
  });
});

test('L13 #314: the floor boundary is unchanged — 500 pending bytes is stale-eligible, 499 is not', async () => {
  const vault = tempDir('um-layers-');
  for (const [p, n] of [['p500', 500], ['p499', 499]]) {
    const t1 = turn('2026-09-20T01:00:00.000Z', 'a'.repeat(100));
    const head = '## 2026-09-20T01:30:00.000Z user\n';
    const t2 = head + 'b'.repeat(n - bytes(head) - 2) + '\n\n'; // exactly n bytes
    await writeRawFile(vault, p, '2026-09-20.md', t1 + t2, iso('2026-09-20T02:00:00Z'));
    await writeCursor(vault, p, { file: '2026-09-20.md', offset: bytes(t1), last_turn_iso: '2026-09-18T00:00:00.000Z', updated_at: '2026-09-20T01:10:00.000Z' });
  }
  await withLagMax('30', async () => {
    const { layers } = await layersAt(vault, NOW, { min_transcript_bytes: 500 });
    assert.equal(layers.p500.pending_bytes, 500);
    assert.equal(layers.p500.stale, true);
    assert.equal(layers.p499.pending_bytes, 499);
    assert.equal(layers.p499.stale, false);
  });
});

test('L14 #314: lag_hours is unchanged across the existing matrix (cursor, cursorless with a summary, never digested, poisoned cursor)', async () => {
  const vault = tempDir('um-layers-');
  for (const p of ['cur', 'sum', 'none', 'poison']) {
    await writeRawFile(vault, p, '2026-09-26.md', turn('2026-09-26T05:00:00.000Z'), iso('2026-09-26T10:00:00Z'));
  }
  await writeCursor(vault, 'cur', { file: '2026-09-26.md', offset: 0, last_turn_iso: '2026-09-26T04:00:00.000Z', updated_at: '2026-09-26T04:30:00.000Z' });
  await writeSessionFile(vault, 'sum', 'session-2026-09-25-aaaa0003.md', iso('2026-09-25T22:00:00Z'));
  await writeSessionFile(vault, 'poison', 'session-2026-09-24-aaaa0004.md', iso('2026-09-24T10:00:00Z'));
  await writeCursor(vault, 'poison', { file: '2099-01-01.md', offset: 0, last_turn_iso: '2026-09-26T09:00:00.000Z' });
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.cur.lag_hours, 6, 'last capture − cursor.last_turn_iso');
  assert.equal(layers.sum.lag_hours, 12, 'last capture − last_summary_at');
  assert.equal(layers.none.lag_hours, 'Infinity');
  assert.equal(layers.poison.lag_hours, 48, 'a poisoned cursor falls back to last_summary_at');
});

test('L15 #314: rule-change invariant — every layer stale under the lag rule stays stale unless its oldest pending content waited ≤ 30 h, and every such exception is a reopened layer', async () => {
  const vault = tempDir('um-layers-');
  const cursorAt = async (p, firstTurn, rest, mtime, { file = '2026-09-26.md', updatedAt }) => {
    await writeRawFile(vault, p, file, firstTurn + rest, iso(mtime));
    await writeCursor(vault, p, { file, offset: bytes(firstTurn), last_turn_iso: firstTurn.slice(3, 27), updated_at: updatedAt });
  };
  const fixtures = [
    ['quiet-cursor', 'quiet', () => cursorAt('quiet-cursor', turn('2026-09-26T12:00:00.000Z', 'a'.repeat(300)), turn('2026-09-26T20:00:00.000Z'), '2026-09-26T22:00:00Z', { updatedAt: '2026-09-26T12:30:00.000Z' })],
    ['active-cursor', 'active', async () => {
      await cursorAt('active-cursor', turn('2026-09-26T08:00:00.000Z', 'a'.repeat(300)), turn('2026-09-26T10:00:00.000Z'), '2026-09-26T23:00:00Z', { updatedAt: '2026-09-26T08:30:00.000Z' });
      await writeRawFile(vault, 'active-cursor', '2026-09-28.md', turn('2026-09-28T11:50:00.000Z'), iso('2026-09-28T11:50:00Z'));
    }],
    ['reopened-cursor', 'reopened', async () => {
      await cursorAt('reopened-cursor', turn('2026-09-25T12:00:00.000Z'), '', '2026-09-25T12:00:30Z', { file: '2026-09-25.md', updatedAt: '2026-09-25T12:05:00.000Z' });
      await writeRawFile(vault, 'reopened-cursor', '2026-09-28.md', turn('2026-09-28T11:00:00.000Z'), iso('2026-09-28T11:00:30Z'));
    }],
    ['cursorless-summary', 'quiet', async () => {
      await writeRawFile(vault, 'cursorless-summary', '2026-09-20.md', turn('2026-09-20T09:00:00.000Z'), iso('2026-09-20T10:00:00Z'));
      await writeSessionFile(vault, 'cursorless-summary', 'session-2026-09-21-aaaa0005.md', iso('2026-09-21T09:00:00Z'));
      await writeRawFile(vault, 'cursorless-summary', '2026-09-26.md', turn('2026-09-26T09:00:00.000Z'), iso('2026-09-26T10:00:00Z'));
    }],
    ['never-digested', 'quiet', () => writeRawFile(vault, 'never-digested', '2026-09-25.md', turn('2026-09-25T08:00:00.000Z'), iso('2026-09-25T09:00:00Z'))],
    ['skew-future', 'skewed', () => writeRawFile(vault, 'skew-future', '2026-09-26.md', turn('2026-10-26T00:00:00.000Z'), iso('2026-09-26T08:00:00Z'))],
    ['skew-past', 'skewed', () => cursorAt('skew-past', turn('2026-09-26T01:00:00.000Z', 'a'.repeat(300)), turn('2025-01-01T00:00:00.000Z'), '2026-09-26T09:00:00Z', { updatedAt: '2026-09-26T01:30:00.000Z' })],
    ['phantom', 'phantom', async () => {
      await writeRawFile(vault, 'phantom', '2026-09-20.md', turn('2026-09-20T09:00:00.000Z'), iso('2026-09-20T10:00:00Z'));
      await writeSessionFile(vault, 'phantom', 'session-2026-09-20-aaaa0006.md', iso('2026-09-21T09:00:00Z'));
    }],
  ];
  for (const [, , setup] of fixtures) await setup();
  await withLagMax('30', async () => {
    const { layers } = await layersAt(vault, NOW);
    const staleByLag = (l) => l.pending_bytes >= 500 && (l.lag_hours === 'Infinity' || l.lag_hours > 30);
    const exceptions = [];
    for (const [p, cls] of fixtures) {
      const l = layers[p];
      assert.ok(l, p);
      assert.equal(typeof l.undigested, 'boolean', `${p}: undigested is reported`);
      if (staleByLag(l) && !l.stale) {
        exceptions.push(p);
        assert.equal(cls, 'reopened', `${p}: only a reopened layer may leave the stale list`);
        assert.ok(typeof l.age_hours === 'number' && l.age_hours <= 30, `${p}: its oldest pending content waited ≤ 30 h (${l.age_hours})`);
      }
    }
    assert.deepEqual(exceptions, ['reopened-cursor'], 'the matrix exercises the one intended exception');
    assert.equal(layers['quiet-cursor'].stale, true, 'and the frozen-lag layer the lag rule missed is stale');
  });
});

test('L16 #314: a deleted cursor.file rolls the first pending position to the next existing raw file', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-26.md', turn('2026-09-26T04:00:00.000Z'), iso('2026-09-26T04:30:00Z'));
  await writeCursor(vault, 'p', { file: '2026-09-25.md', offset: 1234, last_turn_iso: '2026-09-25T20:00:00.000Z', updated_at: '2026-09-25T20:30:00.000Z' });
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.undigested, true);
  assert.equal(layers.p.waiting_since, '2026-09-26T04:00:00.000Z');
  assert.equal(layers.p.age_hours, 56);
});

test('L17 #314: a split cursor anchors on the containing turn’s header (16 KiB backward read), not on the max-persisted last_turn_iso; no header in the window ⇒ dayStart(F)', async () => {
  const vault = tempDir('um-layers-');
  // Out-of-order client clocks: turn Z (09:00) then turn A (02:00). The cursor split A after
  // 3000 content bytes and max-persisted last_turn_iso is Z's 09:00 — newer than A's header.
  const tZ = turn('2026-09-26T09:00:00.000Z', 'z'.repeat(200));
  const headA = '## 2026-09-26T02:00:00.000Z user\n';
  const tA = headA + 'a'.repeat(6000) + '\n\n';
  await writeRawFile(vault, 'split', '2026-09-26.md', tZ + tA, iso('2026-09-26T10:00:00Z'));
  await writeCursor(vault, 'split', { file: '2026-09-26.md', offset: bytes(tZ) + bytes(headA) + 3000, boundary: 'split', last_turn_iso: '2026-09-26T09:00:00.000Z', updated_at: '2026-09-26T10:05:00.000Z' });
  // A legacy over-long turn: its header sits more than 16 KiB before the split offset.
  await writeRawFile(vault, 'far', '2026-09-26.md', '## 2026-09-26T06:00:00.000Z user\n' + 'x'.repeat(20_000), iso('2026-09-26T10:00:00Z'));
  await writeCursor(vault, 'far', { file: '2026-09-26.md', offset: 18_000, boundary: 'split', last_turn_iso: '2026-09-26T09:00:00.000Z', updated_at: '2026-09-26T10:05:00.000Z' });
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.split.waiting_since, '2026-09-26T02:00:00.000Z');
  assert.equal(layers.split.age_hours, 58);
  assert.equal(layers.far.waiting_since, '2026-09-26T00:00:00.000Z');
  assert.equal(layers.far.age_hours, 60);
});

test('L18 #314: a raw file dated after now ⇒ age_hours "Infinity", stale', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-30.md', turn('2026-09-30T01:00:00.000Z'), iso('2026-09-28T11:00:00Z'));
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.undigested, true);
  assert.equal(layers.p.age_hours, 'Infinity');
  assert.equal(layers.p.waiting_since, null);
  assert.equal(layers.p.stale, true);
});

test('L19 #314: below-cursor growth — an older raw file modified after cursor.updated_at ⇒ undigested, age "Infinity", stale', async () => {
  const vault = tempDir('um-layers-');
  const t = turn('2026-09-26T10:00:00.000Z');
  for (const [p, olderMtime] of [['grew', '2026-09-27T08:00:00Z'], ['quiet', '2026-09-25T20:00:00Z']]) {
    await writeRawFile(vault, p, '2026-09-25.md', turn('2026-09-25T10:00:00.000Z'), iso(olderMtime));
    await writeRawFile(vault, p, '2026-09-26.md', t, iso('2026-09-26T10:00:30Z'));
    await writeCursor(vault, p, { file: '2026-09-26.md', offset: bytes(t), last_turn_iso: '2026-09-26T10:00:00.000Z', updated_at: '2026-09-26T12:00:00.000Z' });
  }
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.grew.pending_bytes, 0, 'sanity: nothing is pending at or after the cursor');
  assert.equal(layers.grew.undigested, true);
  assert.equal(layers.grew.age_hours, 'Infinity');
  assert.equal(layers.grew.stale, true);
  assert.equal(layers.quiet.undigested, false, 'an older file untouched since the cursor moved is not growth');
  assert.equal(layers.quiet.stale, false);
});

test('L20 #314: a pending-reindex entry carries repair_since; the layer is stale once it is older than the threshold, whatever is pending', async () => {
  const vault = tempDir('um-layers-');
  const t = turn('2026-09-27T10:00:00.000Z');
  for (const p of ['old', 'young', 'none', 'garbled']) {
    await writeRawFile(vault, p, '2026-09-27.md', t, iso('2026-09-27T10:00:30Z'));
    await writeCursor(vault, p, { file: '2026-09-27.md', offset: bytes(t), last_turn_iso: '2026-09-27T10:00:00.000Z', updated_at: '2026-09-27T10:05:00.000Z' });
  }
  await writeRepairEntry(vault, 'old', 'session-2026-09-27-aaaa0001', { summary_path: 'sessions/old/session-2026-09-27-aaaa0001.md', since: hoursBeforeNow(31) });
  await writeRepairEntry(vault, 'old', 'session-2026-09-28-aaaa0002', { summary_path: 'sessions/old/session-2026-09-28-aaaa0002.md', since: hoursBeforeNow(2) });
  await writeRepairEntry(vault, 'young', 'session-2026-09-27-aaaa0003', { summary_path: 'sessions/young/session-2026-09-27-aaaa0003.md', since: hoursBeforeNow(29) });
  await writeRepairEntry(vault, 'garbled', 'session-2026-09-27-aaaa0004', { summary_path: 'sessions/garbled/session-2026-09-27-aaaa0004.md', since: 'not a date' });
  await withLagMax('30', async () => {
    const { layers } = await layersAt(vault, NOW);
    assert.equal(layers.old.undigested, false, 'nothing pending: the repair arm alone decides');
    assert.equal(layers.old.repair_since, hoursBeforeNow(31), 'the oldest entry wins');
    assert.equal(layers.old.repair_hours, 31);
    assert.equal(layers.old.stale, true);
    assert.equal(layers.young.repair_since, hoursBeforeNow(29));
    assert.equal(layers.young.stale, false);
    assert.equal(layers.none.repair_since, null);
    assert.equal(layers.none.repair_hours, null);
    assert.equal(layers.none.stale, false);
    assert.equal(layers.garbled.repair_hours, 'Infinity', 'an unparseable since resolves in the alerting direction');
    assert.ok(layers.garbled.repair_since, 'and the layer still reads as carrying a repair');
    assert.equal(layers.garbled.stale, true);
  });
});

test('L21 #314: a split cursor under 16 KiB into its file reads from byte 0 and finds the header there', async () => {
  const vault = tempDir('um-layers-');
  await writeRawFile(vault, 'p', '2026-09-26.md', turn('2026-09-26T03:00:00.000Z', 'a'.repeat(6000)), iso('2026-09-26T03:00:30Z'));
  await writeCursor(vault, 'p', { file: '2026-09-26.md', offset: 4000, boundary: 'split', last_turn_iso: '2026-09-26T03:00:00.000Z', updated_at: '2026-09-26T03:05:00.000Z' });
  const { layers } = await layersAt(vault, NOW);
  assert.equal(layers.p.waiting_since, '2026-09-26T03:00:00.000Z');
  assert.equal(layers.p.age_hours, 57);
});
