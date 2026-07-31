// server/test/capture-ledger.test.mjs — #201 capture ledger (Task 1).
//
// The ledger is the late-arrival addressing record: one row per bot-surface
// infer:true capture, written at the compat R2 call site. These tests pin the
// resolution semantics (two-phase forward-first window), the retention
// fold-to-tally contract, the reaction-state transition returns, and the
// point-level aggregate — the #201 spec's D-a/D-c invariants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  _resetCaptureEventsForTest,
  _setDbFactoryForTest,
} from '../lib/capture-events.mjs';
import {
  recordCapture,
  resolveCapture,
  upsertReactionState,
  recordAttachment,
  aggregateForPoint,
  updatePointRef,
  _resetCaptureLedgerForTest,
} from '../lib/capture-ledger.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-ledger-'));
  return path.join(dir, 'um-counters.db');
}

/** Fresh hermetic DB per test: env-pointed path + both singletons reset. */
function freshDb() {
  const dbPath = tempDbPath();
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  _resetCaptureLedgerForTest();
  return dbPath;
}

const T0 = '2026-07-30T12:00:00.000Z';
function tPlus(seconds) {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

function makeCapture(overrides = {}) {
  return recordCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    surface: 'mem0-compat',
    project: 'proj',
    createdAt: T0,
    verdict: 'stored',
    pointRefs: [{ id: 'p1', hash: 'h1' }],
    messageHashes: ['mh1', 'mh2'],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// recordCapture + fail-soft
// ---------------------------------------------------------------------------

test('recordCapture returns a capture id and persists the row', () => {
  freshDb();
  const id = makeCapture();
  assert.ok(typeof id === 'string' && id.length > 0);
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: tPlus(-5),
  });
  assert.equal(row.captureId, id);
  assert.equal(row.verdict, 'stored');
  assert.deepEqual(row.pointRefs, [{ id: 'p1', hash: 'h1' }]);
  assert.equal(row.surface, 'mem0-compat');
  assert.equal(row.project, 'proj');
});

test('recordCapture retries ONCE on SQLITE_BUSY (counters-writer parity), then lands the row', () => {
  const dbPath = tempDbPath();
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  _resetCaptureLedgerForTest();
  const real = new Database(dbPath);
  let busyOnce = true;
  _setDbFactoryForTest(() => ({
    exec: (sql) => real.exec(sql),
    pragma: (p, o) => real.pragma(p, o),
    prepare: (sql) => {
      const stmt = real.prepare(sql);
      return {
        run: (...a) => {
          if (busyOnce && /INSERT INTO capture_ledger/.test(sql)) {
            busyOnce = false;
            const e = new Error('database is locked');
            e.code = 'SQLITE_BUSY';
            throw e;
          }
          return stmt.run(...a);
        },
        get: (...a) => stmt.get(...a),
        all: (...a) => stmt.all(...a),
      };
    },
    close: () => real.close(),
  }));
  _resetCaptureLedgerForTest();
  try {
    const id = makeCapture();
    assert.ok(id, 'a single SQLITE_BUSY must be retried, not dropped');
    const n = real.prepare('SELECT COUNT(*) AS n FROM capture_ledger').get().n;
    assert.equal(n, 1);
  } finally {
    _resetCaptureEventsForTest();
    try { real.close(); } catch { /* already closed by reset */ }
  }
});

test('recordCapture is fail-soft: a poisoned DB returns null, never throws', () => {
  _setDbFactoryForTest(() => { throw new Error('simulated: disk on fire'); });
  _resetCaptureLedgerForTest();
  try {
    const id = makeCapture();
    assert.equal(id, null);
  } finally {
    _resetCaptureEventsForTest();
  }
});

// ---------------------------------------------------------------------------
// resolveCapture — two-phase forward-first window (spec D-a)
// ---------------------------------------------------------------------------

test('resolution: earliest capture AT/AFTER the message wins (forward phase)', () => {
  freshDb();
  const a = makeCapture({ createdAt: tPlus(10) });
  makeCapture({ createdAt: tPlus(60) });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
  });
  assert.equal(row.captureId, a);
});

test('interleaved exchanges: each message resolves to its OWN exchange capture, not the prior one within skew reach-back', () => {
  freshDb();
  const capA = makeCapture({ createdAt: T0 });
  const capB = makeCapture({ createdAt: tPlus(5) });
  // Message from exchange B, sent 4s after capture A — the naive
  // earliest-in-window rule would pick A (skew reaches back 120s).
  const rowB = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: tPlus(4),
  });
  assert.equal(rowB.captureId, capB);
  const rowA = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: tPlus(-1),
  });
  assert.equal(rowA.captureId, capA);
});

test('skew fallback with MULTIPLE reach-back rows picks the row CLOSEST to the message ts, not the oldest (review R#205)', () => {
  freshDb();
  makeCapture({ createdAt: T0 });          // 40s before the message — the wrong pick
  const near = makeCapture({ createdAt: tPlus(30) }); // 10s before — the causal capture
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: tPlus(40), // after both; no forward row exists
  });
  assert.equal(row.captureId, near);
});

test('skew fallback: a reply-message ts slightly AFTER the capture (clock offset) still resolves when no forward row exists', () => {
  freshDb();
  const a = makeCapture({ createdAt: T0 });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: tPlus(30), // 30s after capture; within default 120s skew
  });
  assert.equal(row.captureId, a);
});

test('skew boundary: beyond the skew reach-back there is no match', () => {
  freshDb();
  makeCapture({ createdAt: T0 });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: tPlus(121), // default skew 120s
  });
  assert.equal(row, null);
});

test('horizon: a capture created beyond the forward horizon does not match', () => {
  freshDb();
  makeCapture({ createdAt: tPlus(25 * 3600) }); // default horizon 24h
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
  });
  assert.equal(row, null);
});

test('far-past message_ts: no retained row in window → null (never an error)', () => {
  freshDb();
  makeCapture({ createdAt: T0 });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(row, null);
});

test('scoping: user_id and run_id both partition resolution', () => {
  freshDb();
  makeCapture({ createdAt: tPlus(10) });
  assert.equal(resolveCapture({
    userId: 'other',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
  }), null);
  assert.equal(resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:999',
    messageTs: T0,
  }), null);
});

test('hash refiner: a matching message_hash overrides the forward-earliest pick and flags the disagreement', () => {
  freshDb();
  makeCapture({ createdAt: tPlus(10), messageHashes: ['aaa'] });
  const b = makeCapture({ createdAt: tPlus(20), messageHashes: ['bbb'] });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
    messageHash: 'bbb',
  });
  assert.equal(row.captureId, b);
  assert.equal(row.refinerDisagreed, true);
});

test('hash refiner agreeing with the earliest pick does not flag disagreement', () => {
  freshDb();
  const a = makeCapture({ createdAt: tPlus(10), messageHashes: ['aaa'] });
  makeCapture({ createdAt: tPlus(20), messageHashes: ['bbb'] });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
    messageHash: 'aaa',
  });
  assert.equal(row.captureId, a);
  assert.equal(row.refinerDisagreed, false);
});

// ---------------------------------------------------------------------------
// null-run_id fallback (live 2026-07-31: the vendored bot extension drops
// run_id on the wire — snake/camel mismatch — so ledger rows carry NULL)
// ---------------------------------------------------------------------------

test('null-run_id fallback: with NO exact-match rows, a same-window row with NULL run_id resolves', () => {
  freshDb();
  const nullRow = makeCapture({ runId: undefined, createdAt: tPlus(10) });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
  });
  assert.equal(row.captureId, nullRow);
});

test('null-run_id fallback: exact-match rows always win over null rows in the same window', () => {
  freshDb();
  makeCapture({ runId: undefined, createdAt: tPlus(5) });
  const exact = makeCapture({ createdAt: tPlus(10) });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
  });
  assert.equal(row.captureId, exact);
});

test('null-run_id fallback: a DIFFERENT explicit run_id never falls back onto another channel exact rows', () => {
  freshDb();
  makeCapture({ runId: 'agent:main:discord:channel:999', createdAt: tPlus(10) });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: T0,
  });
  assert.equal(row, null);
});

// ---------------------------------------------------------------------------
// reaction_state — absolute counts, transitions, cap
// ---------------------------------------------------------------------------

test('upsertReactionState: first write is created, repeat is updated, count is absolute last-write-wins including zero', () => {
  freshDb();
  const cap = makeCapture();
  assert.equal(upsertReactionState({ captureId: cap, messageId: 'm1', count: 2, types: ['👍'] }), 'created');
  assert.equal(upsertReactionState({ captureId: cap, messageId: 'm1', count: 5, types: ['👍', '🔥'] }), 'updated');
  recordAttachment({ captureId: cap, requestedPointId: 'p1', terminalPointId: 'p1' });
  assert.deepEqual(aggregateForPoint('p1'), { count: 5, types: ['👍', '🔥'] });
  // Zero is a valid wire value (removal) — ledger stores it; floor-1 is the
  // payload projection's business, not the ledger's.
  assert.equal(upsertReactionState({ captureId: cap, messageId: 'm1', count: 0, types: [] }), 'updated');
  assert.deepEqual(aggregateForPoint('p1'), { count: 0, types: [] });
});

test('per-capture distinct-message cap: creating beyond UM_REACTION_MESSAGES_PER_CAPTURE returns cap_exceeded; updates always pass', () => {
  freshDb();
  const prev = process.env.UM_REACTION_MESSAGES_PER_CAPTURE;
  process.env.UM_REACTION_MESSAGES_PER_CAPTURE = '2';
  try {
    const cap = makeCapture();
    assert.equal(upsertReactionState({ captureId: cap, messageId: 'm1', count: 1, types: [] }), 'created');
    assert.equal(upsertReactionState({ captureId: cap, messageId: 'm2', count: 1, types: [] }), 'created');
    assert.equal(upsertReactionState({ captureId: cap, messageId: 'm3', count: 1, types: [] }), 'cap_exceeded');
    assert.equal(upsertReactionState({ captureId: cap, messageId: 'm2', count: 3, types: [] }), 'updated');
  } finally {
    if (prev === undefined) delete process.env.UM_REACTION_MESSAGES_PER_CAPTURE;
    else process.env.UM_REACTION_MESSAGES_PER_CAPTURE = prev;
  }
});

// ---------------------------------------------------------------------------
// attachments + aggregateForPoint — point-level distinct-capture sum (spec D-c)
// ---------------------------------------------------------------------------

test('aggregateForPoint sums across DISTINCT captures attached to the terminal (the R4 anti-clobber contract)', () => {
  freshDb();
  const c1 = makeCapture();
  const c2 = makeCapture({ createdAt: tPlus(60) });
  upsertReactionState({ captureId: c1, messageId: 'm1', count: 2, types: ['👍'] });
  upsertReactionState({ captureId: c1, messageId: 'm2', count: 1, types: ['🔥'] });
  upsertReactionState({ captureId: c2, messageId: 'm3', count: 5, types: ['👍'] });
  recordAttachment({ captureId: c1, requestedPointId: 'p1', terminalPointId: 'P' });
  recordAttachment({ captureId: c2, requestedPointId: 'p9', terminalPointId: 'P' });
  assert.deepEqual(aggregateForPoint('P'), { count: 8, types: ['👍', '🔥'] });
});

test('a capture with TWO requested refs terminal at the same point counts once (DISTINCT capture_id)', () => {
  freshDb();
  const c1 = makeCapture({ pointRefs: [{ id: 'p1', hash: 'h1' }, { id: 'p2', hash: 'h2' }] });
  upsertReactionState({ captureId: c1, messageId: 'm1', count: 3, types: [] });
  recordAttachment({ captureId: c1, requestedPointId: 'p1', terminalPointId: 'P' });
  recordAttachment({ captureId: c1, requestedPointId: 'p2', terminalPointId: 'P' });
  assert.deepEqual(aggregateForPoint('P'), { count: 3, types: [] });
});

test('recordAttachment upserts: a re-attach moves the terminal and the aggregates follow', () => {
  freshDb();
  const c1 = makeCapture();
  upsertReactionState({ captureId: c1, messageId: 'm1', count: 4, types: [] });
  recordAttachment({ captureId: c1, requestedPointId: 'p1', terminalPointId: 'P_old' });
  assert.equal(aggregateForPoint('P_old').count, 4);
  recordAttachment({ captureId: c1, requestedPointId: 'p1', terminalPointId: 'P_new' });
  assert.equal(aggregateForPoint('P_new').count, 4);
  assert.equal(aggregateForPoint('P_old').count, 0);
});

// ---------------------------------------------------------------------------
// updatePointRef — reindex persist-back (spec D-c reindex resilience)
// ---------------------------------------------------------------------------

test('updatePointRef rewrites a dangling id in point_refs so the hash fallback fires once, not forever', () => {
  freshDb();
  const c1 = makeCapture({ pointRefs: [{ id: 'old-id', hash: 'h1' }] });
  updatePointRef({ captureId: c1, oldPointId: 'old-id', newPointId: 'new-id' });
  const row = resolveCapture({
    userId: 'op',
    runId: 'agent:main:discord:channel:123',
    messageTs: tPlus(-5),
  });
  assert.deepEqual(row.pointRefs, [{ id: 'new-id', hash: 'h1' }]);
});

// ---------------------------------------------------------------------------
// Retention — prune unreacted only, fold into exchange_tally, throttled (spec D-a)
// ---------------------------------------------------------------------------

function directDb() {
  return new Database(process.env.UM_COUNTERS_DB_PATH);
}

test('prune: unreacted rows past retention are deleted and FOLD into exchange_tally; reacted rows survive', () => {
  const dbPath = freshDb();
  const oldTs = '2026-05-01T09:00:00.000Z'; // far past 30d retention
  const unreacted = makeCapture({ createdAt: oldTs, verdict: 'abstained' });
  const reacted = makeCapture({ createdAt: oldTs });
  upsertReactionState({ captureId: reacted, messageId: 'm1', count: 1, types: [] });
  // A new capture triggers prune-on-write (throttle is fresh in this process/db).
  makeCapture({ createdAt: T0 });

  const db = directDb();
  try {
    const ids = db.prepare('SELECT capture_id FROM capture_ledger').all().map((r) => r.capture_id);
    assert.ok(!ids.includes(unreacted), 'unreacted old row should be pruned');
    assert.ok(ids.includes(reacted), 'reacted old row must survive retention');
    const tally = db.prepare(
      'SELECT count FROM exchange_tally WHERE day = ? AND user_id = ? AND surface = ? AND verdict = ?',
    ).get('2026-05-01', 'op', 'mem0-compat', 'abstained');
    assert.equal(tally?.count, 1, 'pruned row folds into the exchange tally');
  } finally {
    db.close();
  }
  assert.ok(dbPath); // silence unused warning paths
});

test('prune throttle: at most once per process per day (second write does not prune)', () => {
  freshDb();
  const oldTs = '2026-05-01T09:00:00.000Z';
  makeCapture({ createdAt: T0 }); // consumes the once-per-day prune slot
  const old2 = makeCapture({ createdAt: oldTs });
  makeCapture({ createdAt: tPlus(10) }); // would prune old2 if unthrottled
  const db = directDb();
  try {
    const ids = db.prepare('SELECT capture_id FROM capture_ledger').all().map((r) => r.capture_id);
    assert.ok(ids.includes(old2), 'throttle must prevent a second same-day prune');
  } finally {
    db.close();
  }
  _resetCaptureLedgerForTest(); // clears the throttle stamp
  makeCapture({ createdAt: tPlus(20) });
  const db2 = directDb();
  try {
    const ids = db2.prepare('SELECT capture_id FROM capture_ledger').all().map((r) => r.capture_id);
    assert.ok(!ids.includes(old2), 'after a throttle reset the prune runs again');
  } finally {
    db2.close();
  }
});
