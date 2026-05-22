// server/test/d3-batch.test.mjs — D3.2 batch contradiction detector unit tests
//
// TDD: 4 tests written FIRST (before implementation), per task description.
//
// Contract verified here:
//   (1) GATE — both lane AND persona absent → no-op: _find/_judge/_facts/_embed
//       stubs are never invoked; returns []. Most important test (R1-B1).
//   (2) Single contradiction — lane present, one candidate judged ≥ τ →
//       returns [{ targetId, supersededBy, confidence, reasoning }].
//   (3) Multi-candidate — >1 candidate ≥ τ judged → only highest-confidence
//       returned (R1-Lens-B-G5). Length === 1, max confidence.
//   (4) Idempotency — candidate with payload.status:'superseded' is never
//       passed to _judge (R1-Lens-B-G2).

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
const THRESHOLD    = 0.8;

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
      threshold: THRESHOLD,
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
      threshold: THRESHOLD,
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
      threshold: THRESHOLD,
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
      threshold: THRESHOLD,
      _facts,
      _embed,
      _find,
      _judge: judgeTracker.fn,
    },
  );

  assert.equal(judgeTracker.count, 0,  '_judge must NOT be called for superseded candidate');
  assert.deepEqual(result, [],          'superseded candidate must not appear in result');
});
