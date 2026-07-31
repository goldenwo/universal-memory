// server/test/reaction-route.test.mjs — #201 Task 4: POST /api/reaction
// handler contract (validation, ts_future posture, outcome→status mapping).
//
// Handler-level DI tests per the house pattern (append-turn precedent): the
// HTTP server's route block is a thin JSON-parse + delegate; everything
// contract-bearing lives in handleReactionRequest and is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { handleReactionRequest } from '../lib/reaction-attach.mjs';
import {
  recordCapture,
  _resetCaptureLedgerForTest,
} from '../lib/capture-ledger.mjs';
import {
  _resetCaptureEventsForTest,
  _setDbFactoryForTest,
} from '../lib/capture-events.mjs';
import { makeMockQdrant } from './fixtures/qdrant-mock.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const OP = 'op';
const RUN = 'agent:main:discord:channel:42';
const T0 = '2026-07-30T12:00:00.000Z';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-rroute-'));
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  _resetCaptureLedgerForTest();
  return dbPath;
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; },
  };
}

function seedCapture(overrides = {}) {
  return recordCapture({
    userId: OP,
    runId: RUN,
    surface: 'mem0-compat',
    project: 'proj',
    createdAt: T0,
    verdict: 'stored',
    pointRefs: [{ id: 'p1', hash: 'h1' }],
    messageHashes: [],
    ...overrides,
  });
}

const goodBody = (overrides = {}) => ({
  run_id: RUN,
  message_id: 'm1',
  message_ts: '2026-07-30T11:59:50.000Z',
  reaction_count: 2,
  reaction_types: ['👍'],
  ...overrides,
});

function ctxOf(mock, overrides = {}) {
  return {
    userId: OP,
    client: mock.client,
    collection: 'memories',
    surface: 'mem0-compat',
    ...overrides,
  };
}

async function call(body, ctx) {
  const res = fakeRes();
  await handleReactionRequest({ body }, res, ctx);
  return res;
}

// --- validation 400s --------------------------------------------------------

const INVALID_BODIES = [
  ['missing run_id', goodBody({ run_id: undefined })],
  ['oversized run_id', goodBody({ run_id: 'x'.repeat(257) })],
  ['missing message_id', goodBody({ message_id: undefined })],
  ['oversized message_id', goodBody({ message_id: 'x'.repeat(129) })],
  ['malformed message_ts', goodBody({ message_ts: 'not-a-date' })],
  ['missing reaction_count', goodBody({ reaction_count: undefined })],
  ['negative reaction_count', goodBody({ reaction_count: -1 })],
  ['non-integer reaction_count', goodBody({ reaction_count: 1.5 })],
  ['non-array reaction_types', goodBody({ reaction_types: 'thumbs' })],
  ['non-string message_hash', goodBody({ message_hash: 42 })],
];

for (const [label, body] of INVALID_BODIES) {
  test(`400 INPUT_INVALID: ${label}`, async () => {
    freshDb();
    const res = await call(body, ctxOf(makeMockQdrant()));
    assert.equal(res.statusCode, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'INPUT_INVALID');
    assert.equal(res.body.error.retryable, false);
  });
}

test('ts_future is an OUTCOME, not a 400: unaddressed + reason, counter row under ctx.surface (pre-NTP boot posture)', async () => {
  const dbPath = freshDb();
  const future = new Date(Date.now() + 10 * 60_000).toISOString(); // +10min > 2min skew
  const res = await call(goodBody({ message_ts: future }), ctxOf(makeMockQdrant()));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'unaddressed');
  assert.equal(res.body.reason, 'ts_future');
  const db = new Database(dbPath);
  try {
    const row = db.prepare(
      "SELECT surface, outcome FROM counters WHERE event = 'signal.reaction'",
    ).get();
    assert.deepEqual(row, { surface: 'mem0-compat', outcome: 'unaddressed' });
  } finally {
    db.close();
  }
});

test('happy path: 200 with outcome/point_ids/annotated/failed', async () => {
  freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
  const res = await call(goodBody(), ctxOf(mock));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.outcome, 'stored');
  assert.deepEqual(res.body.point_ids, ['p1']);
  assert.equal(res.body.annotated, 1);
  assert.equal(res.body.failed, 0);
});

test('per-capture cap exceeded → 400 whose message names the cap knob', async () => {
  freshDb();
  const prev = process.env.UM_REACTION_MESSAGES_PER_CAPTURE;
  process.env.UM_REACTION_MESSAGES_PER_CAPTURE = '1';
  try {
    seedCapture();
    const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
    await call(goodBody({ message_id: 'm1' }), ctxOf(mock));
    const res = await call(goodBody({ message_id: 'm2' }), ctxOf(mock));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'INPUT_INVALID');
    assert.match(res.body.error.message, /UM_REACTION_MESSAGES_PER_CAPTURE/);
  } finally {
    if (prev === undefined) delete process.env.UM_REACTION_MESSAGES_PER_CAPTURE;
    else process.env.UM_REACTION_MESSAGES_PER_CAPTURE = prev;
  }
});

test('resolved but zero payload writes succeeded → 502 UPSTREAM_FAILURE (retryable; ledger mutation stands)', async () => {
  freshDb();
  seedCapture();
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: OP, hash: 'h1' } }] });
  mock.setPayloadError = new Error('qdrant down');
  const res = await call(goodBody(), ctxOf(mock));
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error.code, 'UPSTREAM_FAILURE');
  assert.equal(res.body.error.retryable, true);
});

test('ledger failure → 502 UPSTREAM_FAILURE (retryable)', async () => {
  _setDbFactoryForTest(() => { throw new Error('ledger dead'); });
  _resetCaptureLedgerForTest();
  try {
    const res = await call(goodBody(), ctxOf(makeMockQdrant()));
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error.code, 'UPSTREAM_FAILURE');
    assert.equal(res.body.error.retryable, true);
  } finally {
    _resetCaptureEventsForTest();
  }
});
