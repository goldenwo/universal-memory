/**
 * No-answer precision eval primitives (v1.6) — pure, offline.
 *
 * deLeak: n-gram leakage guard so a distractor's "no answer" isn't an artifact of
 *   shared phrasing with a gold seed (spec §3.1 / §7 R3).
 * retainedAtFloor: the recall-retention primitive (spec §3) — does a query's gold
 *   answer survive the relevance floor AND the top-`limit` window? recallAtK is
 *   rank-only and cannot express a floor, so this is a new metric.
 *
 * Importing the eval module must stay fully offline (no live umAdd/doSearch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deLeak, retainedAtFloor, pickPin, hardnessZoneOk } from '../eval/memory-quality-eval.mjs';

// ---------------------------------------------------------------------------
// deLeak — reject distractors sharing a ≥3-gram with any gold seed
// ---------------------------------------------------------------------------

test('deLeak: flags a distractor that shares a 3-gram with a seed (leaked)', () => {
  const r = deLeak('what is the vendor renewal date', ['the vendor renewal contract is signed annually']);
  assert.equal(r.clean, false, 'shares "the vendor renewal" / "vendor renewal" trigram');
  assert.ok(r.shared.includes('the vendor renewal') || r.shared.includes('vendor renewal date') === false);
});

test('deLeak: clean when no 3-gram overlap with any seed', () => {
  const r = deLeak('how tall is mount everest', ['standup moved to 10am next sprint', 'manager prefers async updates']);
  assert.equal(r.clean, true);
  assert.deepEqual(r.shared, []);
});

test('deLeak: case-insensitive and punctuation-insensitive', () => {
  const r = deLeak('When is the Vendor Renewal, exactly?', ['The vendor renewal happens in Q3']);
  assert.equal(r.clean, false, '"the vendor renewal" matches regardless of case/punctuation');
});

test('deLeak: a query with fewer than 3 tokens has no 3-gram → vacuously clean', () => {
  assert.equal(deLeak('blood type', ['my resting heart rate is 58']).clean, true);
});

// ---------------------------------------------------------------------------
// retainedAtFloor — gold survives the floor AND the top-limit window
// ---------------------------------------------------------------------------

const ranked = (...pairs) => pairs.map(([id, score]) => ({ id, score }));

test('retainedAtFloor: gold above floor and within limit → retained', () => {
  assert.equal(retainedAtFloor(ranked(['g', 0.50], ['x', 0.40]), ['g'], 0.30, 5), true);
});

test('retainedAtFloor: gold below floor → dropped → NOT retained', () => {
  assert.equal(retainedAtFloor(ranked(['g', 0.20], ['x', 0.50]), ['g'], 0.30, 5), false);
});

test('retainedAtFloor: gold present but pushed beyond limit by distractors → NOT retained', () => {
  const r = ranked(['a', 0.9], ['b', 0.8], ['g', 0.5]);
  assert.equal(retainedAtFloor(r, ['g'], 0.30, 2), false, 'limit=2 excludes gold at rank 3');
  assert.equal(retainedAtFloor(r, ['g'], 0.30, 5), true, 'limit=5 includes it');
});

test('retainedAtFloor: gold with missing score is KEPT by the floor (recall-safe)', () => {
  assert.equal(retainedAtFloor([{ id: 'g' }, { id: 'x', score: 0.5 }], ['g'], 0.30, 5), true);
});

test('retainedAtFloor: floor 0 is inert — pure rank/limit recall', () => {
  assert.equal(retainedAtFloor(ranked(['g', 0.05]), ['g'], 0, 5), true);
});

// ---------------------------------------------------------------------------
// pickPin — the quantified pin rule: pin = F* - 0.02, F* = highest floor at
// recallRetention == 1.0 (spec §3.4). No "knee".
// ---------------------------------------------------------------------------

test('pickPin: F* = highest floor at retention 1.0; pin = F*-0.02', () => {
  const rows = [
    { floor: 0.20, retention: 1.0, precision: 0.30 },
    { floor: 0.30, retention: 1.0, precision: 0.55 },
    { floor: 0.34, retention: 1.0, precision: 0.80 },
    { floor: 0.38, retention: 0.98, precision: 0.95 }, // drops a real answer → ineligible
  ];
  const r = pickPin(rows);
  assert.equal(r.fStar, 0.34);
  assert.equal(r.pin, 0.32, 'F*-0.02');
});

test('pickPin: null when NO floor keeps full recall (STOP condition)', () => {
  const r = pickPin([{ floor: 0.20, retention: 0.98, precision: 0.4 }, { floor: 0.30, retention: 0.9, precision: 0.8 }]);
  assert.equal(r.fStar, null);
  assert.equal(r.pin, null);
});

test('pickPin: ignores higher floors once retention dips, even if a later one recovers', () => {
  // F* is the MAX floor at 1.0, regardless of ordering.
  const r = pickPin([{ floor: 0.36, retention: 1.0, precision: 0.9 }, { floor: 0.30, retention: 1.0, precision: 0.6 }]);
  assert.equal(r.fStar, 0.36);
  assert.equal(r.pin, 0.34);
});

// ---------------------------------------------------------------------------
// hardnessZoneOk — ≥5 answerable golds in [pin-0.05, pin+0.05] (spec §3.2)
// ---------------------------------------------------------------------------

test('hardnessZoneOk: true when ≥5 answerable golds land in the overlap zone', () => {
  const scores = [0.26, 0.28, 0.30, 0.31, 0.34, 0.62, 0.71];
  assert.equal(hardnessZoneOk(scores, 0.30), true, '5 in [0.25,0.35]');
});

test('hardnessZoneOk: false when fewer than 5 in the zone (sweep INVALID)', () => {
  const scores = [0.26, 0.28, 0.62, 0.71, 0.80];
  assert.equal(hardnessZoneOk(scores, 0.30), false, 'only 2 in [0.25,0.35]');
});
