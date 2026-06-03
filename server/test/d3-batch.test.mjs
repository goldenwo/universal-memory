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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContradictionsInBatch } from '../lib/contradiction-batch.mjs';
import { computeFactId } from '../lib/add.mjs';

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
    { id: CANDIDATE_ID, payload: { data: CANDIDATE_TEXT, status: 'current' }, score: 0.88 },
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
  const CAND_A = { id: 'cand-A', payload: { data: 'older fact A', status: 'current' }, score: 0.9 };
  const CAND_B = { id: 'cand-B', payload: { data: 'older fact B', status: 'current' }, score: 0.88 };
  const CAND_C = { id: 'cand-C', payload: { data: 'older fact C', status: 'current' }, score: 0.85 };

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
    { id: 'already-superseded', payload: { data: 'old fact', status: 'superseded' }, score: 0.95 },
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
  const CANDIDATE = { id: 'cand-mid', payload: { data: 'older fact mid', status: 'current' }, score: 0.55 };

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
  const CANDIDATE = { id: 'cand-default', payload: { data: 'older fact default', status: 'current' }, score: 0.50 };

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
