// server/test/mem0-compat-ledger.test.mjs — #201 Task 2: the compat R2 capture
// path records one capture-ledger row per infer:true umAdd, fail-soft.
//
// Wiring under test: handleAdd → recordCapture (capture-ledger.mjs). The row
// carries pointRefs [{id, hash: md5(r.memory)}] — audit-verified to equal the
// SURVIVING point's payload hash on all three result events — plus md5 per
// POSTed message, the counters surface, run_id, and metadata.project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { handleMem0Compat } from '../lib/mem0-compat.mjs';
import {
  _resetCaptureEventsForTest,
  _setDbFactoryForTest,
} from '../lib/capture-events.mjs';
import { _resetCaptureLedgerForTest } from '../lib/capture-ledger.mjs';
import { registry } from '../lib/metrics.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const OP = 'op';
const COLLECTION = 'memories';
const md5 = (s) => createHash('md5').update(s).digest('hex');

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-r2ledger-'));
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  _resetCaptureLedgerForTest();
  return dbPath;
}

function ledgerRows(dbPath) {
  const db = new Database(dbPath);
  try {
    return db.prepare('SELECT * FROM capture_ledger ORDER BY rowid ASC').all();
  } catch (err) {
    if (/no such table/.test(String(err?.message))) return [];
    throw err;
  } finally {
    db.close();
  }
}

function makeUmAdd(result) {
  const fn = async (args) => result ?? { results: [{ id: 'stored-1', memory: args.text, event: 'ADD' }] };
  return fn;
}

function ctxOf(umAdd) {
  return {
    userId: OP,
    memory: { config: { vectorStore: { config: { collectionName: COLLECTION } } } },
    _umAdd: umAdd ?? makeUmAdd(),
  };
}

const addBody = (overrides = {}) => ({
  messages: [
    { role: 'user', content: 'hello a' },
    { role: 'assistant', content: 'hello b' },
  ],
  run_id: 'agent:main:discord:channel:42',
  metadata: { project: 'proj-x' },
  ...overrides,
});

const call = (body, ctx) =>
  handleMem0Compat({ method: 'POST', headers: {} }, new URL('/v1/memories/', 'http://x'), body, ctx);

test('R2 infer:true records one ledger row: stored verdict, pointRefs with md5(memory), per-message hashes, surface/run_id/project', async () => {
  const dbPath = freshDb();
  const res = await call(addBody(), ctxOf(makeUmAdd({
    results: [{ id: 'pt-1', memory: 'fact one', event: 'ADD' }],
  })));
  assert.equal(res.status, 200);
  const rows = ledgerRows(dbPath);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.user_id, OP);
  assert.equal(row.run_id, 'agent:main:discord:channel:42');
  assert.equal(row.surface, 'mem0-compat');
  assert.equal(row.project, 'proj-x');
  assert.equal(row.verdict, 'stored');
  assert.deepEqual(JSON.parse(row.point_refs), [{ id: 'pt-1', hash: md5('fact one') }]);
  assert.deepEqual(JSON.parse(row.message_hashes), [md5('hello a'), md5('hello b')]);
});

test('R2 abstained: zero extracted facts → verdict abstained, empty pointRefs', async () => {
  const dbPath = freshDb();
  const res = await call(addBody(), ctxOf(makeUmAdd({ results: [] })));
  assert.equal(res.status, 200);
  const rows = ledgerRows(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, 'abstained');
  assert.deepEqual(JSON.parse(rows[0].point_refs), []);
});

test('R2 DEDUP_MERGED: pointRefs hash derives from the SURVIVING point text (r.memory), not the incoming fact', async () => {
  const dbPath = freshDb();
  await call(addBody(), ctxOf(makeUmAdd({
    results: [{ id: 'survivor', memory: 'the existing surviving text', event: 'DEDUP_MERGED' }],
  })));
  const rows = ledgerRows(dbPath);
  assert.deepEqual(JSON.parse(rows[0].point_refs), [
    { id: 'survivor', hash: md5('the existing surviving text') },
  ]);
});

test('R2 infer:false (verbatim path) writes NO ledger rows', async () => {
  const dbPath = freshDb();
  const res = await call(addBody({ infer: false }), ctxOf());
  assert.equal(res.status, 200);
  assert.deepEqual(ledgerRows(dbPath), []);
});

test('ledger failure is isolated: capture still returns 200 and the error counter increments', async () => {
  _setDbFactoryForTest(() => { throw new Error('simulated ledger failure'); });
  _resetCaptureLedgerForTest();
  try {
    const before = (await registry.getSingleMetric('um_capture_ledger_errors_total').get())
      .values.reduce((a, v) => a + v.value, 0);
    const res = await call(addBody(), ctxOf());
    assert.equal(res.status, 200);
    const after = (await registry.getSingleMetric('um_capture_ledger_errors_total').get())
      .values.reduce((a, v) => a + v.value, 0);
    assert.equal(after, before + 1);
  } finally {
    _resetCaptureEventsForTest();
  }
});
