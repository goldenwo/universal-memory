// server/test/d3-batch.test.mjs — D3.2 batch contradiction detector unit tests
//
// TDD: tests written FIRST (before implementation), per task description.
//
// Contract verified here:
//   (1) GATE — both lane AND persona absent → no-op: _find/_judge/_facts/_embed
//       stubs are never invoked; returns []. Most important test (R1-B1).
//   (2) Single contradiction — lane present, one candidate judged ≥ judge τ →
//       returns [{ targetId, supersededBy, confidence, reasoning }].
//   (3) Multi-candidate — >1 candidate ≥ judge τ judged → only highest-confidence
//       returned (R1-Lens-B-G5). Length === 1, max confidence.
//   (4) Idempotency — candidate with payload.status:'superseded' is never
//       passed to _judge (R1-Lens-B-G2).
//   (5) Independent thresholds (D3.3 Task 3.2) — retrievalThreshold and
//       judgeThreshold are honored SEPARATELY: the low retrieval τ is what
//       reaches _find (so moderately-cosine candidates are still retrieved),
//       and the higher judge τ is what gates supersession (a judge confidence
//       between the two values does NOT supersede).
//   (7) Direction (#276) — a candidate is judged only when the supersession
//       direction rule resolves 'incoming-newer' from recorded truth time: the
//       candidate's `valid_from` against the session's assertion instant
//       (`assertedAt`, default the detector's own now), with the future bound
//       measured against the wall clock (`_now`). Every other direction skips
//       the candidate before `_judge`. The resolver's VALUE is asserted through
//       the `_resolveDirection` seam, not just the skip.
//
// Fixtures: a real stored point always carries `valid_from` (the write path
// stamps it), so every candidate in (2)-(6) carries a past one — the rule then
// resolves 'incoming-newer' against the wall clock and those cases are unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContradictionsInBatch } from '../lib/contradiction-batch.mjs';
import { computeFactId } from '../lib/add.mjs';
import { resolveSupersessionDirection } from '../lib/supersede.mjs';
import { CLOCK_SKEW_TOLERANCE_MS } from '../lib/ranking.mjs';

// ── Stub factories ──────────────────────────────────────────────────────────

/** Wrap a function to record call count. Returns { fn, count }. */
function trackCalls(fn) {
  const tracker = { count: 0 };
  tracker.fn = async (...args) => {
    tracker.count++;
    return fn(...args);
  };
  return tracker;
}

// Fixed test data
const TEST_USER    = 'u-batch-test';
const TEST_LANE    = 'work';
const TEST_TEXT    = 'I prefer TypeScript over JavaScript';
const TEST_VECTOR  = [0.1, 0.2, 0.3];
// D3.3 Task 3.2: the detector now takes TWO independent thresholds.
const JUDGE_THRESHOLD     = 0.8;  // judge-confidence cutoff to supersede
const RETRIEVAL_THRESHOLD = 0.45; // embedding candidate-retrieval cosine cutoff
// #276: the recorded truth time a real stored point carries. Past relative to any
// wall clock these tests run under, so (2)-(6) resolve 'incoming-newer' unchanged.
const STORED_PAST = '2026-01-01T00:00:00.000Z';

// ── (1) ELIGIBILITY GATE — most important test ──────────────────────────────
//
// When BOTH lane AND persona are absent (undefined / null / ''), the function
// must return [] IMMEDIATELY without invoking ANY seam: _facts, _embed, _find,
// or _judge. This is the hardest safety invariant — a miss = silent recall loss.

test('detectContradictionsInBatch: absent lane+persona → no-op (gate, R1-B1)', async () => {
  const factsTracker = trackCalls(async () => {
    assert.fail('_facts must NOT be called when lane+persona absent');
  });
  const embedTracker = trackCalls(async () => {
    assert.fail('_embed must NOT be called when lane+persona absent');
  });
  const findTracker = trackCalls(async () => {
    assert.fail('_find must NOT be called when lane+persona absent');
  });
  const judgeTracker = trackCalls(async () => {
    assert.fail('_judge must NOT be called when lane+persona absent');
  });

  const result = await detectContradictionsInBatch(
    'Some transcript text',
    {
      userId: TEST_USER,
      lane: undefined,
      persona: undefined,
      judgeThreshold: JUDGE_THRESHOLD,
      retrievalThreshold: RETRIEVAL_THRESHOLD,
      _facts: factsTracker.fn,
      _embed: embedTracker.fn,
      _find: findTracker.fn,
      _judge: judgeTracker.fn,
    },
  );

  assert.deepEqual(result, [], 'gate: must return [] when no lane and no persona');
  assert.equal(factsTracker.count,  0, '_facts must never be called (gate)');
  assert.equal(embedTracker.count,  0, '_embed must never be called (gate)');
  assert.equal(findTracker.count,   0, '_find must never be called (gate)');
  assert.equal(judgeTracker.count,  0, '_judge must never be called (gate)');
});

// ── (2) Single contradiction ─────────────────────────────────────────────────
//
// lane present, one candidate, _judge returns contradicts:true at confidence 0.9 ≥ τ=0.8.
// Result must have length 1 with correct targetId + supersededBy + confidence.

test('detectContradictionsInBatch: lane present, single contradiction ≥ τ → [{ targetId, supersededBy, confidence }]', async () => {
  const CANDIDATE_ID   = 'candidate-uuid-001';
  const CANDIDATE_TEXT = 'I prefer JavaScript over TypeScript';

  const _facts = async () => ({ facts: [TEST_TEXT], usage: { tokensIn: 5, tokensOut: 2 } });
  const _embed = async () => ({ vector: TEST_VECTOR });
  const _find  = async () => ([
    { id: CANDIDATE_ID, payload: { data: CANDIDATE_TEXT, status: 'current', valid_from: STORED_PAST }, score: 0.88 },
  ]);
  const _judge = async (older, newer) => ({
    contradicts: true,
    confidence:  0.9,
    reasoning:   'newer fact asserts the opposite language preference',
    usage:       { tokensIn: 10, tokensOut: 5 },
  });

  const result = await detectContradictionsInBatch(
    'Some transcript text',
    {
      userId: TEST_USER,
      lane: TEST_LANE,
      persona: undefined,
      judgeThreshold: JUDGE_THRESHOLD,
      retrievalThreshold: RETRIEVAL_THRESHOLD,
      _facts,
      _embed,
      _find,
      _judge,
    },
  );

  assert.equal(result.length, 1, 'must return exactly 1 entry');
  const entry = result[0];
  assert.equal(entry.targetId,    CANDIDATE_ID, 'targetId must be the candidate id');
  assert.equal(entry.confidence,  0.9,          'confidence must match judge output');
  assert.ok(typeof entry.reasoning === 'string', 'reasoning must be a string');

  // supersededBy must be the deterministic fact id for TEST_TEXT under TEST_USER + TEST_LANE
  const expectedSupersededBy = computeFactId({ userId: TEST_USER, text: TEST_TEXT, lane: TEST_LANE, persona: undefined });
  assert.equal(entry.supersededBy, expectedSupersededBy, 'supersededBy must equal computeFactId(...)');
});

// ── (3) Multi-candidate — only highest-confidence returned (R1-Lens-B-G5) ────
//
// _find returns 3 candidates; 2 are judged as contradictions with confidence
// 0.85 and 0.72 (0.72 < τ so excluded), plus one at 0.95. Must return only
// the single highest-confidence entry (0.95).

test('detectContradictionsInBatch: multiple contradictions ≥ τ → only single max-confidence returned (G5)', async () => {
  const CAND_A = { id: 'cand-A', payload: { data: 'older fact A', status: 'current', valid_from: STORED_PAST }, score: 0.9 };
  const CAND_B = { id: 'cand-B', payload: { data: 'older fact B', status: 'current', valid_from: STORED_PAST }, score: 0.88 };
  const CAND_C = { id: 'cand-C', payload: { data: 'older fact C', status: 'current', valid_from: STORED_PAST }, score: 0.85 };

  // Judge map: cand-A → 0.85 ≥ τ, cand-B → 0.95 ≥ τ (highest), cand-C → 0.72 < τ (excluded)
  const judgeResults = {
    [CAND_A.id]: { contradicts: true,  confidence: 0.85, reasoning: 'a contradicts', usage: {} },
    [CAND_B.id]: { contradicts: true,  confidence: 0.95, reasoning: 'b contradicts', usage: {} },
    [CAND_C.id]: { contradicts: false, confidence: 0.72, reasoning: 'c compatible',  usage: {} },
  };

  const _facts = async () => ({ facts: [TEST_TEXT], usage: {} });
  const _embed = async () => ({ vector: TEST_VECTOR });
  const _find  = async () => ([CAND_A, CAND_B, CAND_C]);
  const _judge = async (older) => {
    const cand = [CAND_A, CAND_B, CAND_C].find((c) => c.payload.data === older);
    return judgeResults[cand.id];
  };

  const result = await detectContradictionsInBatch(
    'transcript',
    {
      userId: TEST_USER,
      lane: TEST_LANE,
      judgeThreshold: JUDGE_THRESHOLD,
      retrievalThreshold: RETRIEVAL_THRESHOLD,
      _facts,
      _embed,
      _find,
      _judge,
    },
  );

  assert.equal(result.length, 1, 'must return exactly 1 entry (max-confidence only)');
  assert.equal(result[0].targetId,   CAND_B.id, 'must pick cand-B (highest confidence 0.95)');
  assert.equal(result[0].confidence, 0.95,       'max confidence must be 0.95');
});

// ── (4) Idempotency — superseded candidate never judged (R1-Lens-B-G2) ──────
//
// _find returns one candidate with payload.status:'superseded'. The function
// must skip it defensively without calling _judge.

test('detectContradictionsInBatch: superseded candidate skipped — _judge never called (G2)', async () => {
  const judgeTracker = trackCalls(async () => ({
    contradicts: true,
    confidence:  0.99,
    reasoning:   'would supersede again',
    usage:       {},
  }));

  const _facts = async () => ({ facts: [TEST_TEXT], usage: {} });
  const _embed = async () => ({ vector: TEST_VECTOR });
  const _find  = async () => ([
    { id: 'already-superseded', payload: { data: 'old fact', status: 'superseded', valid_from: STORED_PAST }, score: 0.95 },
  ]);

  const result = await detectContradictionsInBatch(
    'transcript',
    {
      userId: TEST_USER,
      lane: TEST_LANE,
      judgeThreshold: JUDGE_THRESHOLD,
      retrievalThreshold: RETRIEVAL_THRESHOLD,
      _facts,
      _embed,
      _find,
      _judge: judgeTracker.fn,
    },
  );

  assert.equal(judgeTracker.count, 0,  '_judge must NOT be called for superseded candidate');
  assert.deepEqual(result, [],          'superseded candidate must not appear in result');
});

// ── (5) Independent thresholds (D3.3 Task 3.2) ──────────────────────────────
//
// The detector must honor retrievalThreshold and judgeThreshold SEPARATELY:
//
//   (a) RETRIEVAL uses the LOW value. The `threshold` passed into _find must be
//       retrievalThreshold (0.45), NOT judgeThreshold (0.80). The eval proved
//       true contradictions cluster at cosine 0.50–0.87 — all below 0.80 — so a
//       coupled high value would retrieve NONE of them and the judge would never
//       see the candidate. We capture the threshold _find receives and assert it.
//
//   (b) JUDGE uses the HIGH value. A judged contradiction at confidence 0.60 —
//       above retrievalThreshold (0.45) but below judgeThreshold (0.80) — must
//       NOT be superseded. If the gate wrongly used the low retrieval value,
//       0.60 ≥ 0.45 would supersede. Asserting [] proves the gate uses judge τ.

test('detectContradictionsInBatch: retrievalThreshold and judgeThreshold honored independently (D3.3)', async () => {
  // Candidate whose cosine (0.55) sits BETWEEN retrieval (0.45) and judge (0.80):
  // it must be retrievable, and its judged confidence (0.60) sits in the same
  // gap — so it is retrieved but NOT superseded.
  const CANDIDATE = { id: 'cand-mid', payload: { data: 'older fact mid', status: 'current', valid_from: STORED_PAST }, score: 0.55 };

  let findThreshold; // capture the threshold value the detector hands to _find
  const findTracker = trackCalls(async ({ threshold }) => {
    findThreshold = threshold;
    return [CANDIDATE];
  });
  const judgeTracker = trackCalls(async () => ({
    contradicts: true,
    confidence:  0.60, // between retrieval (0.45) and judge (0.80)
    reasoning:   'moderate-confidence contradiction',
    usage:       {},
  }));

  const _facts = async () => ({ facts: [TEST_TEXT], usage: {} });
  const _embed = async () => ({ vector: TEST_VECTOR });

  const result = await detectContradictionsInBatch(
    'transcript',
    {
      userId: TEST_USER,
      lane: TEST_LANE,
      judgeThreshold: JUDGE_THRESHOLD,
      retrievalThreshold: RETRIEVAL_THRESHOLD,
      _facts,
      _embed,
      _find: findTracker.fn,
      _judge: judgeTracker.fn,
    },
  );

  // (a) retrieval used the LOW value — _find received retrievalThreshold, not judgeThreshold.
  assert.equal(findTracker.count, 1, '_find must be called once');
  assert.equal(findThreshold, RETRIEVAL_THRESHOLD,
    '_find must receive retrievalThreshold (0.45), NOT judgeThreshold — else true contradictions (cosine 0.50–0.87) are never retrieved');

  // The candidate WAS retrieved and judged (proves it passed the low retrieval gate).
  assert.equal(judgeTracker.count, 1, '_judge must be called — candidate was retrieved at the low retrieval τ');

  // (b) judge gate used the HIGH value — confidence 0.60 < judgeThreshold 0.80 → no supersession.
  assert.deepEqual(result, [],
    'confidence 0.60 is below judgeThreshold 0.80 → must NOT supersede; if the gate used retrievalThreshold (0.45) it would wrongly supersede');
});

// ── (6) Eval-derived defaults applied when thresholds omitted (D3.3) ────────
//
// When neither threshold is supplied, the detector must apply its pinned
// eval-derived defaults: retrieval τ = 0.45, judge τ = 0.80. A candidate at
// cosine 0.50 (≥ default retrieval, < default judge) judged at confidence 0.90
// (≥ default judge) must be retrieved (proving default retrieval τ ≤ 0.50) and
// superseded (proving default judge τ ≤ 0.90). The same candidate judged at
// 0.70 must NOT supersede (proving default judge τ > 0.70, i.e. it is 0.80).

test('detectContradictionsInBatch: omitted thresholds apply eval-derived defaults (retrieval 0.45 / judge 0.80)', async () => {
  const CANDIDATE = { id: 'cand-default', payload: { data: 'older fact default', status: 'current', valid_from: STORED_PAST }, score: 0.50 };

  let findThreshold;
  const _facts = async () => ({ facts: [TEST_TEXT], usage: {} });
  const _embed = async () => ({ vector: TEST_VECTOR });
  const makeFind = () => async ({ threshold }) => { findThreshold = threshold; return [CANDIDATE]; };

  // Judged at 0.90 (≥ default judge 0.80) → supersedes.
  const resultHigh = await detectContradictionsInBatch('transcript', {
    userId: TEST_USER,
    lane: TEST_LANE,
    // judgeThreshold + retrievalThreshold intentionally omitted → defaults apply.
    _facts,
    _embed,
    _find: makeFind(),
    _judge: async () => ({ contradicts: true, confidence: 0.90, reasoning: 'high', usage: {} }),
  });

  // Default retrieval τ must be ≤ 0.50 (candidate at 0.50 was retrievable) and is the pinned 0.45.
  assert.equal(findThreshold, 0.45, 'default retrievalThreshold must be the eval-derived 0.45');
  assert.equal(resultHigh.length, 1, 'confidence 0.90 ≥ default judge τ (0.80) → must supersede');
  assert.equal(resultHigh[0].targetId, CANDIDATE.id);

  // Judged at 0.70 (< default judge 0.80) → does NOT supersede, proving the default judge τ is 0.80 not lower.
  const resultLow = await detectContradictionsInBatch('transcript', {
    userId: TEST_USER,
    lane: TEST_LANE,
    _facts,
    _embed,
    _find: makeFind(),
    _judge: async () => ({ contradicts: true, confidence: 0.70, reasoning: 'mid', usage: {} }),
  });
  assert.deepEqual(resultLow, [], 'confidence 0.70 < default judge τ (0.80) → must NOT supersede');
});

// ── (7) Direction (#276) — judge only when truth time resolves incoming-newer ──
//
// Fixed clocks so every case is deterministic: DET_NOW is what the detector's
// `_now` seam returns (the wall clock at decision), SESSION_PAST is a windowed
// backfill's `until` bound passed as `assertedAt`. The judge stub always
// confirms a contradiction, so a skip shows up as `[]` AND judge count 0.

const DET_NOW      = '2026-09-20T12:00:00.000Z';
const SESSION_PAST = '2026-06-01T00:00:00.000Z';
const isoAt = (ms) => new Date(ms).toISOString();
const DET_NOW_MS = Date.parse(DET_NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Wraps the REAL resolver and records every argument it receives and value it returns. */
function recordingResolver() {
  const calls = [];
  const fn = (arg) => {
    const result = resolveSupersessionDirection(arg);
    calls.push({ arg, result });
    return result;
  };
  return { fn, calls };
}

/** Counts `_now` reads; always returns DET_NOW. */
function fixedNow() {
  const tracker = { count: 0 };
  tracker.fn = () => { tracker.count++; return DET_NOW; };
  return tracker;
}

/**
 * Run the detector over ONE fact and ONE candidate whose payload is `payload`,
 * with the direction seams wired. `extraOpts` may carry `assertedAt` (or omit it).
 */
async function runDirectionCase(payload, extraOpts = {}) {
  const judge = trackCalls(async () => ({
    contradicts: true, confidence: 0.9, reasoning: 'confirmed', usage: {},
  }));
  const resolver = recordingResolver();
  const now = fixedNow();
  const result = await detectContradictionsInBatch('transcript', {
    userId: TEST_USER,
    lane: TEST_LANE,
    judgeThreshold: JUDGE_THRESHOLD,
    retrievalThreshold: RETRIEVAL_THRESHOLD,
    _facts: async () => ({ facts: [TEST_TEXT], usage: {} }),
    _embed: async () => ({ vector: TEST_VECTOR }),
    _find: async () => ([{ id: 'cand-dir', payload: { data: 'older fact', status: 'current', ...payload }, score: 0.7 }]),
    _judge: judge.fn,
    _resolveDirection: resolver.fn,
    _now: now.fn,
    ...extraOpts,
  });
  return { result, judge, resolver, now };
}

test('direction (#276): candidate without valid_from → skipped as ambiguous, _judge never called', async () => {
  const { result, judge, resolver } = await runDirectionCase({}, { assertedAt: SESSION_PAST });
  assert.deepEqual(result, [], 'a stored point with no recorded truth time must never be superseded');
  assert.equal(judge.count, 0, '_judge must not be consulted when direction forbids acting');
  assert.equal(resolver.calls.length, 1, 'the direction rule must be consulted once for the one candidate');
  assert.equal(resolver.calls[0].result.direction, 'ambiguous');
  assert.equal(resolver.calls[0].result.storedAt, null);
});

test('direction (#276): candidate valid_from after a PAST assertedAt but before now → skipped as stored-newer (not stored-future)', async () => {
  const storedBetween = '2026-08-01T00:00:00.000Z'; // after SESSION_PAST, before DET_NOW
  const { result, judge, resolver } = await runDirectionCase(
    { valid_from: storedBetween }, { assertedAt: SESSION_PAST },
  );
  assert.deepEqual(result, []);
  assert.equal(judge.count, 0);
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].result.direction, 'stored-newer',
    'a point dated after a backfill bound but before the wall clock is simply newer — the future test is against now, never the past bound');
});

test('direction (#276): candidate valid_from beyond now + skew → skipped as stored-future', async () => {
  const storedFuture = isoAt(DET_NOW_MS + CLOCK_SKEW_TOLERANCE_MS + 1);
  const { result, judge, resolver } = await runDirectionCase(
    { valid_from: storedFuture }, { assertedAt: SESSION_PAST },
  );
  assert.deepEqual(result, []);
  assert.equal(judge.count, 0);
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].result.direction, 'stored-future');
  assert.equal(resolver.calls[0].result.storedAt, storedFuture);
});

test('direction (#276): candidate valid_from before assertedAt → judged, and the resolver receives exactly the truth-time inputs', async () => {
  const storedOlder = '2026-03-01T00:00:00.000Z'; // before SESSION_PAST
  const { result, judge, resolver } = await runDirectionCase(
    { valid_from: storedOlder }, { assertedAt: SESSION_PAST },
  );
  assert.equal(judge.count, 1, 'incoming-newer is the one arm that reaches the judge');
  assert.equal(result.length, 1);
  assert.equal(result[0].targetId, 'cand-dir');
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].result.direction, 'incoming-newer');
  // Seam pin: the rule sees the session instant, the candidate's recorded truth
  // time, and the wall clock — nothing else from either side.
  assert.deepEqual(resolver.calls[0].arg, {
    incoming: { assertedAt: SESSION_PAST },
    stored: { valid_from: storedOlder },
    now: DET_NOW,
  });
});

test('direction (#276): assertedAt omitted → the detector\'s own now is the assertion instant (a candidate dated yesterday is judged)', async () => {
  const yesterday = isoAt(DET_NOW_MS - DAY_MS);
  const { result, judge, resolver } = await runDirectionCase({ valid_from: yesterday });
  assert.equal(judge.count, 1);
  assert.equal(result.length, 1);
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].arg.incoming.assertedAt, DET_NOW,
    'an absent assertedAt must be normalised to the detector\'s now BEFORE the rule — never handed through as undefined (which would abstain every candidate)');
  assert.equal(resolver.calls[0].result.direction, 'incoming-newer');
});

test('direction (#276): unusable assertedAt (\'not a date\') → normalised to now, candidate dated yesterday is judged', async () => {
  const yesterday = isoAt(DET_NOW_MS - DAY_MS);
  const { result, judge, resolver } = await runDirectionCase(
    { valid_from: yesterday }, { assertedAt: 'not a date' },
  );
  assert.equal(judge.count, 1, 'a malformed assertedAt from a direct caller must fail LIVE (judged), not silently skip every candidate');
  assert.equal(result.length, 1);
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].arg.incoming.assertedAt, DET_NOW);
});

test('direction (#276): assertedAt beyond now + skew → skipped as incoming-future (#318 arm; anything but incoming-newer skips)', async () => {
  const futureBound = isoAt(DET_NOW_MS + CLOCK_SKEW_TOLERANCE_MS + 1);
  const { result, judge, resolver } = await runDirectionCase(
    { valid_from: STORED_PAST }, { assertedAt: futureBound },
  );
  assert.deepEqual(result, []);
  assert.equal(judge.count, 0);
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].result.direction, 'incoming-future');
});

test('direction (#276): candidate carrying a past decided_at but no valid_from → skipped (the decision-date field is not read)', async () => {
  const { result, judge, resolver } = await runDirectionCase(
    { decided_at: '2026-04-16' }, { assertedAt: SESSION_PAST },
  );
  assert.deepEqual(result, []);
  assert.equal(judge.count, 0);
  assert.equal(resolver.calls.length, 1);
  assert.equal(resolver.calls[0].result.direction, 'ambiguous');
  assert.deepEqual(resolver.calls[0].arg.stored, { valid_from: undefined },
    'only valid_from crosses from the candidate payload into the rule');
});

test('direction (#276): now is read once per call and shared by every decision in it', async () => {
  const judge = trackCalls(async () => ({ contradicts: false, confidence: 0.1, reasoning: 'compatible', usage: {} }));
  const resolver = recordingResolver();
  const now = fixedNow();
  await detectContradictionsInBatch('transcript', {
    userId: TEST_USER,
    lane: TEST_LANE,
    _facts: async () => ({ facts: ['fact one', 'fact two'], usage: {} }),
    _embed: async () => ({ vector: TEST_VECTOR }),
    _find: async () => ([
      { id: 'c1', payload: { data: 'older 1', status: 'current', valid_from: STORED_PAST }, score: 0.7 },
      { id: 'c2', payload: { data: 'older 2', status: 'current', valid_from: STORED_PAST }, score: 0.6 },
    ]),
    _judge: judge.fn,
    _resolveDirection: resolver.fn,
    _now: now.fn,
  });
  assert.equal(now.count, 1, '_now must be read exactly once per detector call');
  assert.equal(resolver.calls.length, 4, 'two facts x two candidates = four direction decisions');
  for (const { arg } of resolver.calls) assert.equal(arg.now, DET_NOW);
  assert.equal(judge.count, 4);
});

test('direction (#276): the rule sits after the superseded-skip — a superseded candidate never reaches the resolver', async () => {
  const { result, judge, resolver } = await runDirectionCase(
    { status: 'superseded', valid_from: STORED_PAST }, { assertedAt: SESSION_PAST },
  );
  assert.deepEqual(result, []);
  assert.equal(judge.count, 0);
  assert.equal(resolver.calls.length, 0);
});
