// server/test/supersede.test.mjs — Gap-5 P3 (ADR-0007 Option C) decision surface.
//
// Covers the NEW public surface added in P3 to the supersession module:
//   - isAutoSupersedeEnabled  — the single-source opt-out flag predicate
//     (extracted; previously inlined at checkpoint.mjs + mem0-mcp-http.mjs).
//   - contradictionBandCeiling / autoSupersedeJudgeThreshold — eval-pinned
//     config readers (drift gates).
//   - evaluateInBandSupersession — the write-time "dedup defers to supersession
//     in-band" decision (band + eligibility + bounded inline judge).
//
// The point-level primitives (supersedePoint / unsupersedePoint) stay covered
// by d3-substrate.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAutoSupersedeEnabled,
  contradictionBandCeiling,
  autoSupersedeJudgeThreshold,
  evaluateInBandSupersession,
} from '../lib/supersede.mjs';

// A judge stub that records its call and returns a canned verdict.
function judgeStub(verdict) {
  const calls = [];
  const fn = async (olderFact, newerFact) => { calls.push({ olderFact, newerFact }); return verdict; };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// isAutoSupersedeEnabled — opt-out polarity, whitespace-trimmed
// (must match the gate predicate in checkpoint.mjs + mem0-mcp-http.mjs byte-for-byte)
// ---------------------------------------------------------------------------

test('isAutoSupersedeEnabled: opt-out — unset/empty/true/other → enabled', () => {
  assert.equal(isAutoSupersedeEnabled({}), true, 'unset → ON (default since v1.2 flip)');
  assert.equal(isAutoSupersedeEnabled({ UM_AUTOSUPERSEDE_ENABLED: '' }), true);
  assert.equal(isAutoSupersedeEnabled({ UM_AUTOSUPERSEDE_ENABLED: 'true' }), true);
  assert.equal(isAutoSupersedeEnabled({ UM_AUTOSUPERSEDE_ENABLED: '1' }), true);
});

test('isAutoSupersedeEnabled: only literal "false" (whitespace-trimmed) disables', () => {
  assert.equal(isAutoSupersedeEnabled({ UM_AUTOSUPERSEDE_ENABLED: 'false' }), false);
  assert.equal(isAutoSupersedeEnabled({ UM_AUTOSUPERSEDE_ENABLED: ' false ' }), false, 'padded false still opts out (#94 trim)');
});

// ---------------------------------------------------------------------------
// Config readers — eval-pinned defaults + env override (drift gates)
// ---------------------------------------------------------------------------

test('contradictionBandCeiling: default 0.95 (band-widening validation; confident-duplicate floor), env-overridable', () => {
  assert.equal(contradictionBandCeiling({}), 0.95, 'pinned default — lockstep with .env.example + the band-widening validation (results/2026-06-19-supersession-band-widening-validation.md; s009)');
  assert.equal(contradictionBandCeiling({ UM_CONTRADICTION_BAND_CEILING: '0.90' }), 0.90);
  assert.equal(contradictionBandCeiling({ UM_CONTRADICTION_BAND_CEILING: 'not-a-number' }), 0.95, 'invalid → default');
});

test('autoSupersedeJudgeThreshold: default 0.80 (mirrors detector judgeThreshold), env-overridable', () => {
  assert.equal(autoSupersedeJudgeThreshold({}), 0.80);
  assert.equal(autoSupersedeJudgeThreshold({ UM_AUTOSUPERSEDE_THRESHOLD: '0.95' }), 0.95);
  assert.equal(autoSupersedeJudgeThreshold({ UM_AUTOSUPERSEDE_THRESHOLD: 'x' }), 0.80, 'invalid → default');
});

// ---------------------------------------------------------------------------
// evaluateInBandSupersession — the Option C decision.
// Contract: never supersede unless flag-on AND partitioned AND in-band AND the
// judge confirms a contradiction at/above the confidence threshold. The judge
// is consulted ONLY for the eligible-in-band slice (`judged:true`).
// ---------------------------------------------------------------------------

// bandCeiling mirrors the production default (0.95 since the band-widening) so these
// parameterized tests exercise the live band edge, not a stale one (R3 lens C).
const ELIGIBLE = { lane: 'work', persona: undefined, bandFloor: 0.84, bandCeiling: 0.95, judgeThreshold: 0.80, enabled: true };

test('evaluateInBandSupersession: flag off → no supersede, judge NOT consulted', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, enabled: false, score: 0.85, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false);
  assert.equal(r.judged, false);
  assert.equal(judge.calls.length, 0, 'flag-off must short-circuit before the judge (no hot-path cost)');
});

test('evaluateInBandSupersession: unpartitioned (no lane/persona) → no supersede, judge NOT consulted (R1-B1)', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, lane: undefined, persona: undefined, score: 0.85, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false);
  assert.equal(r.judged, false);
  assert.equal(judge.calls.length, 0, 'unpartitioned must short-circuit (mirrors the detector eligibility gate)');
});

test('evaluateInBandSupersession: above the ceiling (pure duplicate) → no supersede, judge NOT consulted', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, score: 0.97, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false);
  assert.equal(r.judged, false);
  assert.equal(judge.calls.length, 0, 'score > 0.95 ceiling = confident duplicate → keep-older without judging');
});

test('evaluateInBandSupersession: below the floor → no supersede, judge NOT consulted', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, score: 0.50, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false);
  assert.equal(r.judged, false);
});

test('evaluateInBandSupersession: omitted bandFloor → fail-safe never-in-band (no supersede, no judge)', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    lane: 'work', enabled: true, bandCeiling: 0.95, judgeThreshold: 0.80,
    score: 0.85, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false, 'no bandFloor → NaN comparison → never in-band → safe');
  assert.equal(judge.calls.length, 0);
});

test('evaluateInBandSupersession: in-band + eligible + judge confirms contradiction → supersede, judged', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.91, reasoning: 'newer invalidates older' });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, score: 0.85, olderText: 'lives in Boston', newerText: 'lives in Denver now', _judge: judge,
  });
  assert.equal(r.supersede, true);
  assert.equal(r.judged, true);
  assert.equal(r.confidence, 0.91);
  assert.equal(r.reasoning, 'newer invalidates older');
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(judge.calls[0], { olderFact: 'lives in Boston', newerFact: 'lives in Denver now' },
    'directionality: older=existing candidate, newer=incoming (mirrors the detector)');
});

test('evaluateInBandSupersession: in-band but judge says NOT a contradiction → no supersede (keep-older)', async () => {
  const judge = judgeStub({ contradicts: false, confidence: 0.10 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, score: 0.86, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false);
  assert.equal(r.judged, true, 'the judge WAS consulted (eligible-in-band slice) but declined');
});

test('evaluateInBandSupersession: in-band contradiction but confidence below threshold → no supersede', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.70 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, score: 0.86, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false, '0.70 < 0.80 judge threshold → fail-safe keep-older');
  assert.equal(r.judged, true);
});

test('evaluateInBandSupersession: boundary — score exactly at ceiling is in-band', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, score: 0.95, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.judged, true, 'inclusive upper edge — score === ceiling (0.95) still judged');
  assert.equal(r.supersede, true);
});

// The production DEFAULT ceiling (NO bandCeiling override) — the band-widening change (0.87 → 0.95).
// The write path (add.mjs) passes no bandCeiling, so only these tests prove the SHIPPED default
// end-to-end (R3 lens C: every other test injects an explicit ceiling and so can't catch a default
// regression). 0.95 = the confident-duplicate floor: judge the whole dedup band [0.84, 0.95], cost-
// skip only confident duplicates above it (validation results/2026-06-19-supersession-band-widening-*).
test('evaluateInBandSupersession: DEFAULT ceiling — a 0.92 in-band hit routes to the judge and supersedes', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.91, reasoning: 'newer invalidates older' });
  const r = await evaluateInBandSupersession({
    lane: 'work', enabled: true, bandFloor: 0.84, judgeThreshold: 0.80, // NO bandCeiling → default 0.95
    score: 0.92, olderText: 'production db is postgres', newerText: 'production db is mysql now', _judge: judge,
  });
  assert.equal(r.judged, true, '0.92 ∈ [0.84, 0.95 default] → judged (dup-skipped at the old 0.87 ceiling = the s009 bug)');
  assert.equal(r.supersede, true);
  assert.equal(judge.calls.length, 1);
});

test('evaluateInBandSupersession: DEFAULT ceiling — a 0.97 hit is above the confident-dup floor → NOT judged', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    lane: 'work', enabled: true, bandFloor: 0.84, judgeThreshold: 0.80, // NO bandCeiling → default 0.95
    score: 0.97, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.judged, false, '0.97 > 0.95 default → confident duplicate, cost-skip the judge');
  assert.equal(r.supersede, false);
  assert.equal(judge.calls.length, 0);
});

test('evaluateInBandSupersession: non-string olderText → fail-safe no supersede, no judge', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    ...ELIGIBLE, score: 0.85, olderText: undefined, newerText: 'b', _judge: judge,
  });
  assert.equal(r.supersede, false);
  assert.equal(judge.calls.length, 0, 'cannot judge a non-string candidate → keep-older');
});

test('evaluateInBandSupersession: persona-only partition is eligible', async () => {
  const judge = judgeStub({ contradicts: true, confidence: 0.99 });
  const r = await evaluateInBandSupersession({
    enabled: true, lane: undefined, persona: 'engineer', bandFloor: 0.84, bandCeiling: 0.95, judgeThreshold: 0.80,
    score: 0.85, olderText: 'a', newerText: 'b', _judge: judge,
  });
  assert.equal(r.judged, true, 'persona alone satisfies the partition-eligibility gate');
  assert.equal(r.supersede, true);
});
