// server/test/reaction-attach.test.mjs — #201 Task 3: the attach path.
//
// Pins the spec D-c contracts: universal attachment recording, point-level
// distinct-capture aggregation (anti-clobber), supersession-chain follow with
// cycle guard, reindex hash re-resolution + persist-back, transition-based
// counter emit (ledger-first — a payload failure does not un-emit), and the
// floor-1 payload projection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { attachReaction } from '../lib/reaction-attach.mjs';
import {
  recordCapture,
  _resetCaptureLedgerForTest,
} from '../lib/capture-ledger.mjs';
import { _resetCaptureEventsForTest } from '../lib/capture-events.mjs';
import { registry } from '../lib/metrics.mjs';
import { makeMockQdrant } from './fixtures/qdrant-mock.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const OP = 'op';
const RUN = 'agent:main:discord:channel:42';
const COLLECTION = 'memories';
const T0 = '2026-07-30T12:00:00.000Z';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-attach-'));
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  _resetCaptureLedgerForTest();
  return dbPath;
}

function seedCapture({ pointRefs, createdAt = T0, verdict = 'stored', messageHashes = [] } = {}) {
  return recordCapture({
    userId: OP,
    runId: RUN,
    surface: 'mem0-compat',
    project: 'proj',
    createdAt,
    verdict,
    pointRefs: pointRefs ?? [{ id: 'p1', hash: 'h1' }],
    messageHashes,
  });
}

function signalRows(dbPath) {
  const db = new Database(dbPath);
  try {
    return db.prepare(
      "SELECT surface, project, outcome, count FROM counters WHERE event = 'signal.reaction' ORDER BY rowid ASC",
    ).all();
  } finally {
    db.close();
  }
}

const baseArgs = (mock, overrides = {}) => ({
  userId: OP,
  runId: RUN,
  messageTs: '2026-07-30T11:59:50.000Z',
  messageId: 'm1',
  count: 2,
  types: ['👍'],
  client: mock.client,
  collection: COLLECTION,
  fallbackSurface: 'mem0-compat',
  ...overrides,
});

test('happy path: resolves, attaches, annotates the point payload through the normalizer', async () => {
  freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1', status: 'current' } }] });
  const res = await attachReaction(baseArgs(mock));
  assert.equal(res.outcome, 'stored');
  assert.deepEqual(res.pointIds, ['p1']);
  assert.equal(res.annotated, 1);
  assert.equal(res.failed, 0);
  const pt = mock.client._get('p1');
  assert.equal(pt.payload.reaction_count, 2);
  assert.deepEqual(pt.payload.reaction_types, ['👍']);
});

test('unaddressed: no ledger row in window → outcome unaddressed + per-call counter row under the fallback surface', async () => {
  const dbPath = freshDb();
  const mock = makeMockQdrant();
  const res = await attachReaction(baseArgs(mock));
  assert.equal(res.outcome, 'unaddressed');
  assert.deepEqual(res.pointIds, []);
  assert.deepEqual(signalRows(dbPath), [
    { surface: 'mem0-compat', project: '', outcome: 'unaddressed', count: 1 },
  ]);
});

test('cap_exceeded passes through without a counter emit', async () => {
  const dbPath = freshDb();
  const prev = process.env.UM_REACTION_MESSAGES_PER_CAPTURE;
  process.env.UM_REACTION_MESSAGES_PER_CAPTURE = '1';
  try {
    seedCapture();
    const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
    await attachReaction(baseArgs(mock, { messageId: 'm1' }));
    const res = await attachReaction(baseArgs(mock, { messageId: 'm2' }));
    assert.equal(res.outcome, 'cap_exceeded');
    assert.equal(signalRows(dbPath).length, 1); // only m1's created emit
  } finally {
    if (prev === undefined) delete process.env.UM_REACTION_MESSAGES_PER_CAPTURE;
    else process.env.UM_REACTION_MESSAGES_PER_CAPTURE = prev;
  }
});

test('cross-capture dedup survivor: two captures onto ONE point accumulate the distinct-capture sum (anti-clobber)', async () => {
  freshDb();
  seedCapture({ createdAt: T0 });
  seedCapture({ createdAt: '2026-07-30T12:05:00.000Z' });
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
  await attachReaction(baseArgs(mock, { messageTs: '2026-07-30T11:59:50.000Z', messageId: 'mA', count: 2 }));
  const res = await attachReaction(baseArgs(mock, { messageTs: '2026-07-30T12:04:50.000Z', messageId: 'mB', count: 3 }));
  assert.equal(res.outcome, 'stored');
  assert.equal(mock.client._get('p1').payload.reaction_count, 5);
});

test('superseded chain: annotation follows supersededBy to the terminal current point', async () => {
  freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [
    { id: 'p1', payload: { userId: OP, hash: 'h1', status: 'superseded', supersededBy: 'p2' } },
    { id: 'p2', payload: { userId: OP, hash: 'h2', status: 'current' } },
  ] });
  const res = await attachReaction(baseArgs(mock));
  assert.deepEqual(res.pointIds, ['p2']);
  assert.equal(mock.client._get('p2').payload.reaction_count, 2);
  assert.equal(mock.client._get('p1').payload.reaction_count, undefined);
});

test('dead chain (supersededBy → missing point) → outcome unaddressed, no payload writes', async () => {
  const dbPath = freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [
    { id: 'p1', payload: { userId: OP, hash: 'h1', status: 'superseded', supersededBy: 'gone' } },
  ] });
  const res = await attachReaction(baseArgs(mock));
  assert.equal(res.outcome, 'unaddressed');
  assert.equal(res.annotated, 0);
  assert.equal(mock.setPayloads.length, 0);
  // Review R#205: 'unaddressed' is documented "emitted PER CALL" — the
  // no_surviving_point site must mint its row too (heterogeneous keys: the
  // 'stored' verdict row from the created-transition ALSO stands).
  const outcomes = signalRows(dbPath).map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ['stored', 'unaddressed']);
});

test('supersession cycle is guard-broken → unaddressed, no infinite loop', async () => {
  freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [
    { id: 'p1', payload: { userId: OP, hash: 'h1', status: 'superseded', supersededBy: 'p2' } },
    { id: 'p2', payload: { userId: OP, hash: 'h2', status: 'superseded', supersededBy: 'p1' } },
  ] });
  const res = await attachReaction(baseArgs(mock));
  assert.equal(res.outcome, 'unaddressed');
  assert.equal(res.annotated, 0);
});

test('reindex re-resolution: a dangling id re-resolves by (userId, hash) and persists the new id back into point_refs', async () => {
  const dbPath = freshDb();
  const cap = seedCapture({ pointRefs: [{ id: 'old-gone', hash: 'h1' }] });
  const mock = makeMockQdrant({ points: [
    { id: 'reminted', payload: { userId: OP, hash: 'h1', status: 'current' } },
  ] });
  const res = await attachReaction(baseArgs(mock));
  assert.equal(res.outcome, 'stored');
  assert.deepEqual(res.pointIds, ['reminted']);
  assert.equal(mock.client._get('reminted').payload.reaction_count, 2);
  const db = new Database(dbPath);
  try {
    const row = db.prepare('SELECT point_refs FROM capture_ledger WHERE capture_id = ?').get(cap);
    assert.deepEqual(JSON.parse(row.point_refs), [{ id: 'reminted', hash: 'h1' }]);
  } finally {
    db.close();
  }
});

test('transition-based emit: created emits once with the admission verdict; replay and updates do not re-emit', async () => {
  const dbPath = freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
  await attachReaction(baseArgs(mock, { messageId: 'm1', count: 2 }));
  await attachReaction(baseArgs(mock, { messageId: 'm1', count: 4 })); // replay/update
  await attachReaction(baseArgs(mock, { messageId: 'm2', count: 1 })); // new message
  assert.deepEqual(signalRows(dbPath), [
    { surface: 'mem0-compat', project: 'proj', outcome: 'stored', count: 2 },
  ]);
});

test('floor-1 projection: an aggregate of zero skips the payload write (ledger keeps the truth)', async () => {
  freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
  await attachReaction(baseArgs(mock, { count: 2 }));
  assert.equal(mock.client._get('p1').payload.reaction_count, 2);
  const res = await attachReaction(baseArgs(mock, { count: 0 })); // removal to zero
  assert.equal(res.outcome, 'stored');
  assert.equal(res.annotated, 0);
  assert.equal(res.failed, 0);
  // Payload keeps its last ≥1 value — the recorded floor-1 limitation.
  assert.equal(mock.client._get('p1').payload.reaction_count, 2);
});

test('setPayload failure: ledger already committed, counter already emitted, failure surfaces in the counts', async () => {
  const dbPath = freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
  mock.setPayloadError = new Error('qdrant down');
  const res = await attachReaction(baseArgs(mock));
  assert.equal(res.annotated, 0);
  assert.equal(res.failed, 1);
  assert.equal(signalRows(dbPath).length, 1); // emit keyed on the ledger transition
});

test('refiner disagreement increments the calibration counter', async () => {
  freshDb();
  seedCapture({ createdAt: '2026-07-30T12:00:10.000Z', messageHashes: ['aaa'], pointRefs: [{ id: 'p1', hash: 'h1' }] });
  seedCapture({ createdAt: '2026-07-30T12:00:20.000Z', messageHashes: ['bbb'], pointRefs: [{ id: 'p2', hash: 'h2' }] });
  const mock = makeMockQdrant({ points: [
    { id: 'p1', payload: { userId: OP, hash: 'h1' } },
    { id: 'p2', payload: { userId: OP, hash: 'h2' } },
  ] });
  const before = (await registry.getSingleMetric('um_reaction_refiner_disagreement_total').get())
    .values.reduce((a, v) => a + v.value, 0);
  const res = await attachReaction(baseArgs(mock, { messageTs: T0, messageHash: 'bbb' }));
  assert.deepEqual(res.pointIds, ['p2']);
  const after = (await registry.getSingleMetric('um_reaction_refiner_disagreement_total').get())
    .values.reduce((a, v) => a + v.value, 0);
  assert.equal(after, before + 1);
});
