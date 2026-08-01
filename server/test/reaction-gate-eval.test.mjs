// server/test/reaction-gate-eval.test.mjs — #215 harness, TDD'd on SYNTHETIC
// fixtures only (phase-1 discipline: no live reads). Fixture DBs are built
// through the REAL capture-ledger module (capture-events seam), never
// hand-rolled SQL. The H4 negative-control fixture poisons capture_extraction
// counters with numbers that would produce DIFFERENT denominators — crossing
// the suspect assumption (#188 lesson 3), not orbiting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  verifyAnchor, mulberry32, seededShuffle, isoWeek, readSnapshot, classifyStrata,
  evaluateTrigger, denominators, retentionDetector, buildEarliestRefIndex,
  attributeRefs, drawControls, resolvePoints, h2Gate, h3aPrecondition, h3bProbes,
  permutationTest, wilson, g1Pass, evaluateStaged, emitItems, blindItemId,
  W_START,
} from '../eval/reaction-gate-eval.mjs';
import { _resetCaptureEventsForTest } from '../lib/capture-events.mjs';
import { _resetCaptureLedgerForTest, recordCapture, upsertReactionState } from '../lib/capture-ledger.mjs';
import { makeMockQdrant } from './fixtures/qdrant-mock.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const md5 = (s) => createHash('md5').update(s).digest('hex');

const OP = 'op';
const T_FREEZE = '2026-09-20T00:00:00.000Z';   // frame = [2026-08-01, 2026-09-13]

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-rge-'));
  const dbPath = path.join(dir, 'um-counters.db');
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  _resetCaptureLedgerForTest();
  return dbPath;
}

let seq = 0;
function seedCapture({ createdAt, verdict = 'stored', pointRefs, surface = 'mem0-compat', userId = OP, project }) {
  seq += 1;
  const id = recordCapture({
    userId, surface, project, createdAt, verdict,
    pointRefs: pointRefs ?? [{ id: `p${seq}`, hash: `h${seq}`, event: 'ADD' }],
    messageHashes: [`m${seq}`],
  });
  assert.ok(id, 'fixture recordCapture must succeed');
  return id;
}

function react(captureId, count = 1) {
  upsertReactionState({ captureId, messageId: `msg-${captureId}`, count, types: ['👍'] });
}

// ─── H1 — the #188-missing enforcement, fail-closed, tested ─────────────────
function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-rge-h1-'));
  const p = path.join(dir, 'f');
  if (content !== null) fs.writeFileSync(p, content);
  return p;
}

test('H1: matching hash passes; a one-byte rule edit refuses; missing anchor or rule refuses', () => {
  const rule = tmpFile('FROZEN RULE TEXT v5\n');
  const hash = createHash('sha256').update(fs.readFileSync(rule)).digest('hex');
  const anchor = tmpFile(`${hash}  server/eval/reaction-gate-accept-rule.md (v5, frozen 2026-08-01, 20 bytes)\n`);
  assert.equal(verifyAnchor({ rulePath: rule, anchorPath: anchor }).ok, true);

  fs.appendFileSync(rule, ' ');   // one byte
  const edited = verifyAnchor({ rulePath: rule, anchorPath: anchor });
  assert.equal(edited.ok, false);
  assert.match(edited.reason, /hash mismatch.*refusing/);

  assert.equal(verifyAnchor({ rulePath: rule, anchorPath: path.join(path.dirname(anchor), 'nope') }).ok, false);
  assert.equal(verifyAnchor({ rulePath: path.join(path.dirname(rule), 'nope'), anchorPath: anchor }).ok, false);
});

test('H1: the COMMITTED anchor matches the checked-in rule file (freeze integrity, live artifacts)', () => {
  const res = verifyAnchor({
    rulePath: fileURLToPath(new URL('../eval/reaction-gate-accept-rule.md', import.meta.url)),
    anchorPath: fileURLToPath(new URL('../eval/accept-rule-215.sha256', import.meta.url)),
  });
  assert.deepEqual(res, { ok: true });
});

// ─── Frame, predictor, strata ────────────────────────────────────────────────
test('classifyStrata: frame boundaries, REACTED/ZEROED/UNREACTED, verdict split, scope filter', () => {
  const dbPath = freshDb();
  const preFrame = seedCapture({ createdAt: '2026-07-31T23:59:59.000Z' });          // before W_start
  const s1 = seedCapture({ createdAt: '2026-08-10T12:00:00.000Z' });                // reacted+stored → S1
  const zeroed = seedCapture({ createdAt: '2026-08-11T12:00:00.000Z' });            // reacted then removed → ZEROED
  const ctrl = seedCapture({ createdAt: '2026-08-12T12:00:00.000Z' });              // never-reacted stored → S2 pool
  const s3 = seedCapture({ createdAt: '2026-08-13T12:00:00.000Z', verdict: 'abstained', pointRefs: [] });
  seedCapture({ createdAt: '2026-08-14T12:00:00.000Z', verdict: 'abstained', pointRefs: [] }); // S4
  const offSurface = seedCapture({ createdAt: '2026-08-15T12:00:00.000Z', surface: 'claude-code-plugin' });
  seedCapture({ createdAt: '2026-09-16T12:00:00.000Z' });                            // inside maturity window → out of frame
  react(preFrame); react(s1); react(zeroed, 0); react(s3); react(offSurface);

  const snap = readSnapshot(dbPath);
  const st = classifyStrata({ ...snap, tFreeze: T_FREEZE, userId: OP });
  assert.deepEqual(st.s1.map((r) => r.capture_id), [s1]);
  assert.deepEqual(st.s2Pool.map((r) => r.capture_id), [ctrl]);
  assert.deepEqual(st.s3.map((r) => r.capture_id), [s3]);
  assert.equal(st.s4Count, 1);
  assert.equal(st.nZeroed, 1);
  assert.equal(st.scopedReactedCount, 2);            // s1 + s3; zeroed is not reacted
  assert.equal(st.unscopedReactedCount, 3);          // + the off-surface reacted row (in-frame, any surface)
});

// ─── Trigger + scope guard ───────────────────────────────────────────────────
test('evaluateTrigger: T-A, T-B floor, PARK-SPARSE requires unscoped sparse too, scoping artifact aborts', () => {
  assert.equal(evaluateTrigger({ scopedReacted: 25, scopedS1: 25, pool: 30, unscopedReacted: 25, checkDate: '2026-09-01' }).decision, 'RUN');
  assert.equal(evaluateTrigger({ scopedReacted: 12, scopedS1: 12, pool: 15, unscopedReacted: 12, checkDate: '2026-09-01' }).decision, 'WAIT');
  assert.equal(evaluateTrigger({ scopedReacted: 12, scopedS1: 12, pool: 15, unscopedReacted: 12, checkDate: '2026-11-02' }).decision, 'RUN');
  assert.equal(evaluateTrigger({ scopedReacted: 4, scopedS1: 4, pool: 90, unscopedReacted: 4, checkDate: '2026-11-02' }).decision, 'PARK-SPARSE');
  // Scoping artifact: unscoped meets the arm, scoped does not → abort, never sparse-park.
  const art = evaluateTrigger({ scopedReacted: 2, scopedS1: 2, pool: 90, unscopedReacted: 14, checkDate: '2026-11-02' });
  assert.equal(art.decision, 'SCOPING-ARTIFACT');
  // T-B volume met but pool starved → stage-2-abort-equivalent WAIT, not sparse.
  assert.equal(evaluateTrigger({ scopedReacted: 12, scopedS1: 12, pool: 5, unscopedReacted: 12, checkDate: '2026-11-02' }).decision, 'WAIT');
});

// ─── Denominators + H4 negative control ─────────────────────────────────────
test('H4 negative control: poisoned capture_extraction counters do NOT move ledger-derived denominators', () => {
  const dbPath = freshDb();
  const a = seedCapture({ createdAt: '2026-08-10T12:00:00.000Z' });
  seedCapture({ createdAt: '2026-08-11T12:00:00.000Z' });
  seedCapture({ createdAt: '2026-08-12T12:00:00.000Z', verdict: 'abstained', pointRefs: [] });
  react(a);
  // Poison: a counters table whose totals imply wildly different exchange counts
  // (mixed per-fact/per-call units — the R9 trap the rule forbids reading).
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS capture_extraction (surface TEXT, verdict TEXT, n INTEGER);
           INSERT INTO capture_extraction VALUES ('mem0-compat','stored',9999),('mem0-compat','abstained',9999);`);
  db.close();

  const snap = readSnapshot(dbPath);
  const den = denominators({ ...snap, tFreeze: T_FREEZE, userId: OP });
  assert.deepEqual(den, { stored: { reacted: 1, unreacted: 1 }, abstained: { reacted: 0, unreacted: 1 } });
});

test('denominators: windowed exchange_tally folds into unreacted counts (day granularity)', () => {
  const dbPath = freshDb();
  const a = seedCapture({ createdAt: '2026-08-10T12:00:00.000Z' });
  react(a);
  const db = new Database(dbPath);
  db.exec(`INSERT INTO exchange_tally VALUES
    ('2026-08-05','${OP}','mem0-compat','stored',7),
    ('2026-08-05','${OP}','mem0-compat','abstained',2),
    ('2026-07-20','${OP}','mem0-compat','stored',50),   -- pre-frame: ignored
    ('2026-08-05','other','mem0-compat','stored',50);   -- other user: ignored`);
  db.close();
  const snap = readSnapshot(dbPath);
  const den = denominators({ ...snap, tFreeze: T_FREEZE, userId: OP });
  assert.deepEqual(den, { stored: { reacted: 1, unreacted: 7 }, abstained: { reacted: 0, unreacted: 2 } });
});

// ─── H5 — retention detector + frame excision ────────────────────────────────
test('H5: scoped in-frame tally row → fail with mechanical forward-only W_start excision; out-of-scope rows do not trip it', () => {
  const dbPath = freshDb();
  seedCapture({ createdAt: '2026-08-10T12:00:00.000Z' });
  const db = new Database(dbPath);
  db.exec(`INSERT INTO exchange_tally VALUES
    ('2026-08-09','${OP}','smoke-s9','stored',3),          -- other surface: must NOT trip
    ('2026-07-20','${OP}','mem0-compat','stored',5);       -- pre-frame: must NOT trip`);
  db.close();
  let snap = readSnapshot(dbPath);
  assert.equal(retentionDetector({ ...snap, tFreeze: T_FREEZE, userId: OP }).ok, true);

  const db2 = new Database(dbPath);
  db2.exec(`INSERT INTO exchange_tally VALUES ('2026-08-06','${OP}','mem0-compat','stored',4);`);
  db2.close();
  snap = readSnapshot(dbPath);
  const res = retentionDetector({ ...snap, tFreeze: T_FREEZE, userId: OP });
  assert.equal(res.ok, false);
  assert.equal(res.lastInFrameTallyDay, '2026-08-06');
  assert.equal(res.wStartPrime, '2026-08-07T00:00:00.000Z');
});

// ─── Attribution ─────────────────────────────────────────────────────────────
test('attribution: event-based arms are exact; heuristic fallback needs earliest-row AND ±1h createdAt', () => {
  const rows = [
    { capture_id: 'c1', created_at: '2026-08-10T12:00:00.000Z', point_refs: JSON.stringify([
      { id: 'pA', hash: 'hA', event: 'ADD' },
      { id: 'pB', hash: 'hB', event: 'DEDUP_MERGED' },
      { id: 'pC', hash: 'hC', event: 'SUPERSEDED_INBAND' },
    ]) },
    { capture_id: 'c2', created_at: '2026-08-11T12:00:00.000Z', point_refs: JSON.stringify([
      { id: 'pD', hash: 'hD' },        // eventless, authored (earliest + in-window)
      { id: 'pA', hash: 'hA' },        // eventless, re-reference of c1's point → inherited
      { id: 'pE', hash: 'hE' },        // eventless, createdAt far outside ±1h → inherited (pre-ledger point)
    ]) },
  ];
  const pointsById = new Map([
    ['pD', { id: 'pD', payload: { createdAt: '2026-08-11T12:00:30.000Z' } }],
    ['pA', { id: 'pA', payload: { createdAt: '2026-08-10T12:00:30.000Z' } }],
    ['pE', { id: 'pE', payload: { createdAt: '2026-07-01T00:00:00.000Z' } }],
  ]);
  const idx = buildEarliestRefIndex(rows);
  const c1 = attributeRefs({ row: rows[0], pointsById, earliestRefIndex: idx });
  assert.deepEqual(c1.map((r) => [r.cls, r.mode]), [['authored', 'event'], ['inherited', 'event'], ['authored', 'event']]);
  const c2 = attributeRefs({ row: rows[1], pointsById, earliestRefIndex: idx });
  assert.deepEqual(c2.map((r) => [r.cls, r.mode]),
    [['authored', 'heuristic'], ['inherited', 'heuristic'], ['inherited', 'heuristic']]);
});

// ─── Control draw ────────────────────────────────────────────────────────────
test('drawControls: ISO-week stratified 2× draw, deterministic, capped by pool', () => {
  const s1 = [
    { capture_id: 's1a', created_at: '2026-08-03T10:00:00.000Z' },   // W32
    { capture_id: 's1b', created_at: '2026-08-04T10:00:00.000Z' },   // W32
    { capture_id: 's1c', created_at: '2026-08-12T10:00:00.000Z' },   // W33
  ];
  const pool = [];
  for (let i = 0; i < 6; i++) pool.push({ capture_id: `w32-${i}`, created_at: `2026-08-0${3 + (i % 5)}T0${i}:00:00.000Z` });
  pool.push({ capture_id: 'w33-only', created_at: '2026-08-13T10:00:00.000Z' });

  const one = drawControls({ s1, s2Pool: pool, seed: 20260801 });
  const two = drawControls({ s1, s2Pool: pool, seed: 20260801 });
  assert.deepEqual(one.s2.map((r) => r.capture_id), two.s2.map((r) => r.capture_id));   // deterministic
  const w32 = one.perWeek.find((w) => w.week === isoWeek('2026-08-03T00:00:00.000Z'));
  const w33 = one.perWeek.find((w) => w.week === isoWeek('2026-08-12T00:00:00.000Z'));
  assert.equal(w32.drawn, 4);                       // 2 × n1w
  assert.equal(w33.drawn, 1);                       // pool-capped (want 2, pool 1) — reported, not silent
  assert.equal(w33.poolW, 1);
});

// ─── Resolution + H2/H2b (mock qdrant) ───────────────────────────────────────
test('resolvePoints: batched retrieve, read-only hash re-resolution for dangling ids, H2b text-binding violations', async () => {
  const text = 'a durable fact';
  const mock = makeMockQdrant({ points: [
    { id: 'live-1', payload: { userId: OP, hash: md5(text), data: text } },
    { id: 'reminted', payload: { userId: OP, hash: md5('other fact'), data: 'other fact' } },
    { id: 'corrupt', payload: { userId: OP, hash: 'stored-hash', data: 'text that does not md5 to stored-hash' } },
  ] });
  const refs = new Map([
    ['cA', [{ id: 'live-1', hash: md5(text) }]],
    ['cB', [{ id: 'gone-1', hash: md5('other fact') }]],       // dangling → re-resolves to 'reminted'
    ['cC', [{ id: 'corrupt', hash: 'stored-hash' }]],          // H2b violation
    ['cD', [{ id: 'gone-2', hash: md5('never stored') }]],     // dangling, unresolvable → excluded
  ]);
  const res = await resolvePoints({ refsByExchange: refs, client: mock.client, collection: 'memories', userId: OP });
  assert.deepEqual(res.resolved.get('cA').map((x) => x.point.id), ['live-1']);
  assert.deepEqual(res.resolved.get('cB').map((x) => x.point.id), ['reminted']);
  assert.deepEqual(res.resolved.get('cC'), []);
  assert.equal(res.h2bViolations.length, 1);
  assert.equal(res.excludedFraction, 1 / 4);
  assert.equal(mock.retrieves.length, 1);                      // batched, one call
});

test('h2Gate: per-stratum cap and between-arm differential cap', () => {
  assert.equal(h2Gate({ exclS1: 0.05, exclS2: 0.04 }).ok, true);
  assert.equal(h2Gate({ exclS1: 0.12, exclS2: 0.04 }).ok, false);   // cap
  assert.equal(h2Gate({ exclS1: 0.09, exclS2: 0.02 }).ok, false);   // differential
});

// ─── H3 ──────────────────────────────────────────────────────────────────────
test('H3a: any point carrying a payload `id` key breaks the doSearch id-space precondition', () => {
  assert.equal(h3aPrecondition([{ id: 'q1', payload: { data: 'x' } }]).ok, true);
  const bad = h3aPrecondition([{ id: 'q1', payload: { data: 'x', id: 'vault-doc-stem' } }]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.violations, ['q1']);
});

test('H3b: healthy projection passes; broken projection fails; EMPTY stratum fails (never a silent pass); 1 miss tolerated', async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `pt${i}`, payload: { data: `fact ${i}` } }));
  const healthy = async (text) => [{ id: `pt${text.split(' ')[1]}` }];
  const broken = async () => [{ id: 'wrong' }];

  const ok = await h3bProbes({ strata: { S1: mk(10), S2: mk(10) }, probeFn: healthy });
  assert.equal(ok.ok, true);

  const brk = await h3bProbes({ strata: { S1: mk(10), S2: mk(10) }, probeFn: broken });
  assert.equal(brk.ok, false);

  const empty = await h3bProbes({ strata: { S1: mk(10), S2: [] }, probeFn: healthy });
  assert.equal(empty.ok, false);
  assert.match(empty.results.S2.reason, /empty/);

  let missed = 0;
  const oneMiss = async (text) => { if (missed++ === 0) return [{ id: 'wrong' }]; return healthy(text); };
  const tol = await h3bProbes({ strata: { S1: mk(10) }, probeFn: oneMiss });
  assert.equal(tol.ok, true);
  assert.equal(tol.results.S1.misses, 1);
});

// ─── Permutation test ────────────────────────────────────────────────────────
const ex = (week, arm, facts) => ({ week, arm, facts });

test('permutationTest: deterministic under seed; strong separation → tiny p; null data → large p; within-week shuffle', () => {
  const strong = [
    ...Array.from({ length: 8 }, (_, i) => ex(`W${i % 2}`, 'S1', [true, true, true])),
    ...Array.from({ length: 16 }, (_, i) => ex(`W${i % 2}`, 'S2', [false, false, false])),
  ];
  const a = permutationTest({ exchanges: strong, iterations: 2000, seed: 20260801 });
  const b = permutationTest({ exchanges: strong, iterations: 2000, seed: 20260801 });
  assert.equal(a.p, b.p);                                        // deterministic
  assert.ok(a.p < 0.01, `expected tiny p, got ${a.p}`);
  assert.ok(a.observed === 1);

  const nul = [
    ...Array.from({ length: 8 }, (_, i) => ex(`W${i % 2}`, 'S1', [i % 2 === 0])),
    ...Array.from({ length: 16 }, (_, i) => ex(`W${i % 2}`, 'S2', [i % 2 === 0])),
  ];
  const n = permutationTest({ exchanges: nul, iterations: 2000, seed: 20260801 });
  assert.ok(n.p > 0.2, `expected large p under the null, got ${n.p}`);
});

test('permutationTest: a purely BETWEEN-week difference is null under the within-week permutation (calibration matches the stratified draw)', () => {
  // Week A: both arms all-durable. Week B: both arms all-noise. Any pooled
  // imbalance comes only from week composition — within-week shuffling must
  // treat it as null (p not small).
  const exchanges = [
    ...Array.from({ length: 4 }, () => ex('WA', 'S1', [true])),
    ...Array.from({ length: 2 }, () => ex('WA', 'S2', [true])),
    ...Array.from({ length: 2 }, () => ex('WB', 'S1', [false])),
    ...Array.from({ length: 8 }, () => ex('WB', 'S2', [false])),
  ];
  const r = permutationTest({ exchanges, iterations: 2000, seed: 20260801 });
  assert.ok(r.p > 0.5, `between-week composition must not fake significance; p=${r.p}`);
});

// ─── Wilson + G1 ─────────────────────────────────────────────────────────────
test('wilson: reference values (7/10 → [0.397, 0.892] at 95%)', () => {
  const { lo, hi } = wilson(7, 10);
  assert.ok(Math.abs(lo - 0.3968) < 0.005, `lo=${lo}`);
  assert.ok(Math.abs(hi - 0.8922) < 0.005, `hi=${hi}`);
});

test('g1Pass: headroom-normalized margin — uniform across the nuisance q2', () => {
  assert.equal(g1Pass(0.4625, 0.15), true);    // needs ≥ 0.15 + 0.25·0.85 = 0.3625... 0.4625 clears
  assert.equal(g1Pass(0.36, 0.15), false);     // 0.21 < 0.2125 headroom margin
  assert.equal(g1Pass(0.81, 0.74), true);      // near ceiling: 0.065 margin suffices
  assert.equal(g1Pass(0.79, 0.74), false);
});

// ─── Staged evaluation (R4 stages 5-7 + R5 mapping) ──────────────────────────
function labeled({ n1 = 40, n2 = 80, q1 = 0.5, q2 = 0.15, d = 0.1 }) {
  const items = [];
  const pass1 = new Map(); const pass2 = new Map(); const adjudicated = new Map();
  const mk = (arm, n, q) => {
    for (let i = 0; i < n; i++) {
      const id = `${arm}-${i}`;
      items.push({ item_id: id, arm });
      const worthy = i < Math.round(n * q);
      const label = worthy ? 'D' : 'E';
      adjudicated.set(id, label);
      pass1.set(id, label);
      // Disagreement on the first ⌈d·n⌉ items of each arm: pass2 flips the binary class.
      pass2.set(id, i < Math.round(n * d) ? (worthy ? 'E' : 'U') : label);
    }
  };
  mk('S1', n1, q1); mk('S2', n2, q2);
  return { items, pass1, pass2, adjudicated };
}

test('staged: G3 abort computes d ONLY (no q fields); repair exhausted → terminal PARK-INSTRUMENT', () => {
  const fix = labeled({ d: 0.4 });
  const thunk = () => { throw new Error('permutation must not run on a G3 abort'); };
  const first = evaluateStaged({ ...fix, permThunk: thunk });
  assert.equal(first.outcome, 'G3_ABORT_REPAIR_PERMITTED');
  assert.equal(first.stage, 5);
  assert.ok(!('q1' in first) && !('q2' in first), 'outcomes must not exist on a stage-5 abort');
  const second = evaluateStaged({ ...fix, permThunk: thunk, repairUsed: true });
  assert.equal(second.outcome, 'PARK-INSTRUMENT');
  assert.equal(second.terminal, true);
});

test('staged: G0 ceiling abort computes q2 but NEVER q1; terminal', () => {
  const fix = labeled({ q2: 0.8, q1: 0.9 });
  const res = evaluateStaged({ ...fix, permThunk: () => { throw new Error('no stage 7 on G0'); } });
  assert.equal(res.outcome, 'ABORT-INSTRUMENT');
  assert.equal(res.stage, 6);
  assert.ok(res.q2 >= 0.75);
  assert.ok(!('q1' in res), 'q1 must not exist on a G0 abort');
});

test('staged: ordered mapping — FLIP-SPEC, PARK-NEGATIVE, PARK-INCONCLUSIVE', () => {
  const flip = evaluateStaged({ ...labeled({ q1: 0.6, q2: 0.15 }), permThunk: () => ({ p: 0.001, observed: 0.45 }) });
  assert.equal(flip.outcome, 'FLIP-SPEC');
  assert.equal(flip.capConsumed, true);

  const neg = evaluateStaged({ ...labeled({ q1: 0.10, q2: 0.15 }), permThunk: () => ({ p: 0.9, observed: -0.05 }) });
  assert.equal(neg.outcome, 'PARK-NEGATIVE');

  // Positive but sub-threshold effect → inconclusive (re-run branch), even with small p.
  const inc = evaluateStaged({ ...labeled({ q1: 0.30, q2: 0.15 }), permThunk: () => ({ p: 0.01, observed: 0.15 }) });
  assert.equal(inc.outcome, 'PARK-INCONCLUSIVE');
});

// ─── Blind item emission ─────────────────────────────────────────────────────
test('emitItems: shuffled deterministically, carries ONLY item_id + text, throws on forbidden fields', () => {
  const facts = Array.from({ length: 20 }, (_, i) => ({ item_id: blindItemId(`pt${i}`, 'salt'), text: `fact ${i}` }));
  const a = emitItems({ facts, seed: 20260801 });
  const b = emitItems({ facts, seed: 20260801 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.item_id), facts.map((x) => x.item_id));   // actually shuffled
  for (const it of a) assert.deepEqual(Object.keys(it).sort(), ['item_id', 'text']);

  assert.throws(
    () => emitItems({ facts: [{ item_id: 'x', text: 't', verdict: 'stored' }], seed: 1 }),
    /forbidden field/);
});

test('blindItemId: stable per (salt, pointId), unlinkable across salts', () => {
  assert.equal(blindItemId('pt1', 's'), blindItemId('pt1', 's'));
  assert.notEqual(blindItemId('pt1', 's'), blindItemId('pt1', 'other'));
});

// ─── Determinism plumbing ────────────────────────────────────────────────────
test('mulberry32/seededShuffle: reproducible and permutation-complete', () => {
  const r1 = mulberry32(42); const r2 = mulberry32(42);
  assert.deepEqual([r1(), r1(), r1()], [r2(), r2(), r2()]);
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(seededShuffle(arr, 7).slice().sort((a, b) => a - b), arr);
  assert.deepEqual(seededShuffle(arr, 7), seededShuffle(arr, 7));
});

test('isoWeek: known boundaries (2026-01-01 is W01; 2026-08-03 Mon → W32)', () => {
  assert.equal(isoWeek('2026-08-03T00:00:00.000Z'), '2026-W32');
  assert.equal(isoWeek('2026-08-09T23:59:59.000Z'), '2026-W32');
  assert.equal(isoWeek('2026-08-10T00:00:00.000Z'), '2026-W33');
});
