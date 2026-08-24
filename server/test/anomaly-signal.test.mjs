// server/test/anomaly-signal.test.mjs — #267 alarm arc, T1/T8: the
// POST /api/capture-anomaly handler (lib/anomaly-signal.mjs).
//
// Pins the spec contracts (docs gitignored — the spec refs are for the
// review trail, the assertions ARE the durable record):
//   • D3 — reason validates by SHAPE (regex → 400) then clamps by SET
//     membership (unknown-but-well-formed → outcome 'other'); the SET, not
//     the regex, gates the outcome column (JS '$' matches before a trailing
//     newline — a regex-only gate would admit "no-transcript\n" into the PK).
//   • D4 — project is label-only clamp-not-reject: invalid charset → ''
//     (signal delivery is paramount; no hard-fail on a label).
//   • D5 — writesEnabled=false ⇒ 403 BEFORE any validation or row write.
//   • §7 — 200 body is {schema_version:1, ok:true, outcome} with the
//     post-clamp outcome echoed; schema_version is DELIBERATE (stricter
//     than the /api/reaction clone-source; /api/stats precedent).
//   • D1 — event name signal.capture_anomaly, recorded via the shared
//     writer into (day, surface, project, event, outcome) counters rows.
// All rows land in a SCRATCH UM_COUNTERS_DB_PATH (the #279 sweep lesson:
// never the machine-default DB).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  ANOMALY_EVENT,
  ANOMALY_REASON_KEYS,
  ANOMALY_OTHER,
  handleCaptureAnomalyRequest,
} from '../lib/anomaly-signal.mjs';
import { _resetCaptureEventsForTest } from '../lib/capture-events.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

after(() => {
  _resetCaptureEventsForTest();
});

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function freshDb() {
  const dir = tempDir('um-anomaly-');
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  return dbPath;
}

function anomalyRows(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(
      'SELECT surface, project, event, outcome, count FROM counters WHERE event = ? ORDER BY rowid ASC',
    ).all(ANOMALY_EVENT);
  } finally {
    db.close();
  }
}

function rowCount(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return 0; // lazy-created: no file ⇒ no rows
  }
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM counters').get().n;
  } finally {
    db.close();
  }
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; },
  };
}

const CTX = Object.freeze({ writesEnabled: true, surface: 'claude-code-plugin' });

async function call(body, ctx = CTX) {
  const res = mockRes();
  await handleCaptureAnomalyRequest({ body }, res, ctx);
  return res;
}

// ---------------------------------------------------------------------------
// Constants (the one-way doors — §6b)
// ---------------------------------------------------------------------------

test('ANOMALY_EVENT is the pinned signal.capture_anomaly name, outside capture.%', () => {
  assert.equal(ANOMALY_EVENT, 'signal.capture_anomaly');
  assert.ok(!ANOMALY_EVENT.startsWith('capture.'), 'must sit OUTSIDE the capture.% filter boundary');
});

test('ANOMALY_REASON_KEYS is the frozen 7-reason v1 vocabulary', () => {
  assert.deepEqual([...ANOMALY_REASON_KEYS], [
    'no-transcript',
    'empty-delta-stalled',
    'empty-delta-filtered',
    'nothing-extracted',
    'bad-stdin',
    'empty-stdin',
    'no-python',
  ]);
  assert.ok(Object.isFrozen(ANOMALY_REASON_KEYS));
  assert.equal(ANOMALY_OTHER, 'other');
});

// ---------------------------------------------------------------------------
// D5 — kill switch first
// ---------------------------------------------------------------------------

test('writesEnabled=false ⇒ 403 and NO row, even for a valid body', async () => {
  const dbPath = freshDb();
  const res = await call({ reason: 'no-transcript' }, { writesEnabled: false, surface: 'claude-code-plugin' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.code, 'INPUT_INVALID');
  assert.equal(rowCount(dbPath), 0);
});

test('writesEnabled=false gates BEFORE validation (malformed body still 403, not 400)', async () => {
  freshDb();
  const res = await call({ reason: 42 }, { writesEnabled: false, surface: 'x' });
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------------------
// D3 — reason shape (400 arm)
// ---------------------------------------------------------------------------

for (const [label, body] of [
  ['absent reason', {}],
  ['null body treated as empty', null],
  ['non-string reason', { reason: 42 }],
  ['empty reason', { reason: '' }],
  ['uppercase rejected (shape is lowercase-only)', { reason: 'No-Transcript' }],
  ['over-64-chars rejected', { reason: 'a'.repeat(65) }],
  ['embedded space rejected', { reason: 'no transcript' }],
]) {
  test(`400 INPUT_INVALID: ${label}`, async () => {
    const dbPath = freshDb();
    const res = await call(body);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'INPUT_INVALID');
    assert.equal(rowCount(dbPath), 0);
  });
}

// ---------------------------------------------------------------------------
// D3 — in-vocabulary reasons map verbatim to the outcome column
// ---------------------------------------------------------------------------

test('every v1 reason records verbatim and echoes in the 200 body', async () => {
  const dbPath = freshDb();
  for (const reason of ANOMALY_REASON_KEYS) {
    const res = await call({ reason });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { schema_version: 1, ok: true, outcome: reason });
  }
  const rows = anomalyRows(dbPath);
  assert.deepEqual(rows.map((r) => r.outcome).sort(), [...ANOMALY_REASON_KEYS].sort());
  for (const r of rows) {
    assert.equal(r.event, ANOMALY_EVENT);
    assert.equal(r.surface, 'claude-code-plugin');
    assert.equal(r.project, '');
    assert.equal(r.count, 1);
  }
});

// ---------------------------------------------------------------------------
// D3 — well-formed-unknown clamps to 'other' (version-skew forward-compat)
// ---------------------------------------------------------------------------

test('well-formed unknown reason records as other and echoes the clamp', async () => {
  const dbPath = freshDb();
  const res = await call({ reason: 'some-future-reason' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, ANOMALY_OTHER);
  const rows = anomalyRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, ANOMALY_OTHER);
});

test('the SET, not the regex, gates the outcome column (trailing-newline PK guard)', async () => {
  // JS: /^[a-z0-9-]{1,64}$/.test('no-transcript\n') is TRUE ('$' matches
  // before a final newline). A regex-only gate would admit the newline
  // into the PK; Set membership must clamp it to 'other' instead.
  const dbPath = freshDb();
  const res = await call({ reason: 'no-transcript\n' });
  if (res.statusCode === 200) {
    assert.equal(res.body.outcome, ANOMALY_OTHER);
    const rows = anomalyRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, ANOMALY_OTHER, 'newline variant must never reach the PK verbatim');
  } else {
    // Rejecting it outright (400) is also PK-safe — either posture passes,
    // a verbatim row does not.
    assert.equal(res.statusCode, 400);
    assert.equal(rowCount(dbPath), 0);
  }
});

// ---------------------------------------------------------------------------
// D4 — project clamp-not-reject
// ---------------------------------------------------------------------------

test('valid project slug is recorded on the row', async () => {
  const dbPath = freshDb();
  const res = await call({ reason: 'empty-delta-filtered', project: 'universal-memory' });
  assert.equal(res.statusCode, 200);
  assert.equal(anomalyRows(dbPath)[0].project, 'universal-memory');
});

for (const [label, project] of [
  ['absent', undefined],
  ['non-string', 7],
  ['charset-invalid (space)', 'my project'],
  ['charset-invalid (quote)', 'a"b'],
  ['over-64-chars', 'p'.repeat(65)],
]) {
  test(`project ${label} clamps to '' and the signal still lands (200)`, async () => {
    const dbPath = freshDb();
    const body = { reason: 'no-transcript' };
    if (project !== undefined) body.project = project;
    const res = await call(body);
    assert.equal(res.statusCode, 200, 'signal delivery is paramount — a bad label never rejects');
    assert.equal(anomalyRows(dbPath)[0].project, '');
  });
}

// ---------------------------------------------------------------------------
// Surface + upsert semantics ride the shared writer
// ---------------------------------------------------------------------------

test('same-day repeat upserts count, not rows', async () => {
  const dbPath = freshDb();
  await call({ reason: 'empty-delta-stalled', project: 'p' });
  await call({ reason: 'empty-delta-stalled', project: 'p' });
  const rows = anomalyRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
});

test('surface comes from ctx (transport attribution), unknown fallback rides the writer default', async () => {
  const dbPath = freshDb();
  await call({ reason: 'bad-stdin' }, { writesEnabled: true, surface: undefined });
  assert.equal(anomalyRows(dbPath)[0].surface, 'unknown');
});
