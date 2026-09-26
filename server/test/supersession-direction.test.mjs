// server/test/supersession-direction.test.mjs — #276: supersession direction keys on
// recorded truth time (valid_from), never on arrival order.
//
// Seeded RED on purpose: `resolveSupersessionDirection` did not exist on base. The
// pure-rule table lives in test/helpers/direction-policy-cases.mjs (shared with the
// red-control runner); this file runs it and then pins the in-band evaluator's
// short-circuit — placed AFTER the band gate and BEFORE the judge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSupersessionDirection, evaluateInBandSupersession } from '../lib/supersede.mjs';
import { CASES, runCase } from './helpers/direction-policy-cases.mjs';
import * as supersedeModule from '../lib/supersede.mjs';

for (const id of Object.keys(CASES)) {
  test(`resolveSupersessionDirection: ${id}`, () => {
    const r = runCase(id, resolveSupersessionDirection, supersedeModule);
    assert.ok(r.passed, `${id} failed at "${r.label}": ${r.error && (r.error.stack || r.error.message)}`);
  });
}

// ---------------------------------------------------------------------------
// evaluateInBandSupersession — the direction short-circuit.
// ---------------------------------------------------------------------------
function judgeStub(verdict) {
  const calls = [];
  const fn = async (olderFact, newerFact) => { calls.push({ olderFact, newerFact }); return verdict; };
  fn.calls = calls;
  return fn;
}

const PAST = '2026-01-01T00:00:00.000Z';
const T0 = '2026-06-01T00:00:00.000Z';
const LATER = '2026-09-01T00:00:00.000Z';
const FAR = new Date(8.64e15).toISOString();
const ABSTAIN = { supersede: false, judged: false, confidence: 0, reasoning: '' };

const ELIGIBLE = { lane: 'work', persona: undefined, bandFloor: 0.84, bandCeiling: 0.95, judgeThreshold: 0.80, enabled: true };
const CONTRADICTS = { contradicts: true, confidence: 0.9, reasoning: 'newer invalidates older' };

async function evaluate(overrides) {
  const judge = judgeStub(CONTRADICTS);
  const r = await evaluateInBandSupersession({ ...ELIGIBLE, score: 0.85, olderText: 'a', newerText: 'b', _judge: judge, ...overrides });
  return { r, judge };
}

test('E1: stored newer than incoming -> abstain with direction stored-newer + instants, judge not consulted', async () => {
  const { r, judge } = await evaluate({ olderTruth: { valid_from: LATER }, newerTruth: { valid_from: PAST, assertedAt: LATER } });
  assert.deepEqual(r, { ...ABSTAIN, direction: 'stored-newer', incomingAt: PAST, storedAt: LATER });
  assert.equal(judge.calls.length, 0);
});

test('E2: stored has no truth time -> abstain with direction ambiguous, storedAt null, judge not consulted', async () => {
  const { r, judge } = await evaluate({ olderTruth: {}, newerTruth: { valid_from: PAST, assertedAt: T0 } });
  assert.deepEqual(r, { ...ABSTAIN, direction: 'ambiguous', incomingAt: PAST, storedAt: null });
  assert.equal(judge.calls.length, 0);
});

test('E3: stored beyond now + skew -> abstain with direction stored-future, judge not consulted', async () => {
  const { r, judge } = await evaluate({ olderTruth: { valid_from: FAR }, newerTruth: { assertedAt: T0 } });
  assert.deepEqual(r, { ...ABSTAIN, direction: 'stored-future', incomingAt: T0, storedAt: FAR });
  assert.equal(judge.calls.length, 0);
});

test('E3b: incoming beyond now + skew -> abstain with direction incoming-future, judge not consulted (#318)', async () => {
  // A caller-posted far-future valid_from on the incoming side used to resolve incoming-newer
  // and reach the judge; the write path passes no `now`, so the bound is assertedAt + skew.
  const { r, judge } = await evaluate({ olderTruth: { valid_from: PAST }, newerTruth: { valid_from: FAR, assertedAt: T0 } });
  assert.deepEqual(r, { ...ABSTAIN, direction: 'incoming-future', incomingAt: FAR, storedAt: PAST });
  assert.equal(judge.calls.length, 0);
});

test('E4: equal instants -> ambiguous, judge not consulted', async () => {
  const { r, judge } = await evaluate({ olderTruth: { valid_from: T0 }, newerTruth: { valid_from: T0, assertedAt: T0 } });
  assert.deepEqual(r, { ...ABSTAIN, direction: 'ambiguous', incomingAt: T0, storedAt: T0 });
  assert.equal(judge.calls.length, 0);
});

test('E5: truth objects omitted -> ambiguous with null instants, judge not consulted', async () => {
  const { r, judge } = await evaluate({});
  assert.deepEqual(r, { ...ABSTAIN, direction: 'ambiguous', incomingAt: null, storedAt: null });
  assert.equal(judge.calls.length, 0);
});

test('E6: incoming newer -> judged and supersedes, direction incoming-newer + instants', async () => {
  const { r, judge } = await evaluate({ olderTruth: { valid_from: PAST }, newerTruth: { assertedAt: T0 } });
  assert.equal(r.supersede, true);
  assert.equal(r.judged, true);
  assert.equal(r.direction, 'incoming-newer');
  assert.equal(r.incomingAt, T0);
  assert.equal(r.storedAt, PAST);
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(judge.calls[0], { olderFact: 'a', newerFact: 'b' }, 'argument order unchanged');
});

test('E7: out-of-band hit -> direction null (the check sits after the band gate)', async () => {
  // Truth objects that WOULD resolve stored-newer: if the direction check ran before the band
  // gate, direction would be 'stored-newer' here. null pins the position.
  const { r, judge } = await evaluate({ score: 0.50, olderTruth: { valid_from: LATER }, newerTruth: { valid_from: PAST, assertedAt: LATER } });
  assert.deepEqual(r, { ...ABSTAIN, direction: null, incomingAt: null, storedAt: null });
  assert.equal(judge.calls.length, 0);
});

test('E8: flag off -> direction null, judge not consulted', async () => {
  const { r, judge } = await evaluate({ enabled: false, olderTruth: { valid_from: LATER }, newerTruth: { valid_from: PAST, assertedAt: LATER } });
  assert.deepEqual(r, { ...ABSTAIN, direction: null, incomingAt: null, storedAt: null });
  assert.equal(judge.calls.length, 0);
});

test('E9: unpartitioned -> direction null (R1-B1 untouched), judge not consulted', async () => {
  const { r, judge } = await evaluate({ lane: undefined, persona: undefined, olderTruth: { valid_from: LATER }, newerTruth: { valid_from: PAST, assertedAt: LATER } });
  assert.deepEqual(r, { ...ABSTAIN, direction: null, incomingAt: null, storedAt: null });
  assert.equal(judge.calls.length, 0);
});

// NOTE: this is the live pair's SHAPE under the identity follow-up (truth time recorded as
// valid_from) and a partition it does not carry today; the real ADR points are unpartitioned
// and outside both D3 paths. It pins what the rule does when such a pair DOES reach it.
test('E10: the live pair through the evaluator — the retired fact is kept, the older arrival does not displace it', async () => {
  const { r, judge } = await evaluate({
    olderText: 'The Kuzu commitment is retired',
    olderTruth: { valid_from: '2026-08-18' },
    newerText: 'Kuzu is used as the graph backend for relationship edges',
    newerTruth: { valid_from: '2026-04-16', assertedAt: '2026-08-18T02:09:47.029Z' },
  });
  assert.equal(r.supersede, false);
  assert.equal(r.judged, false);
  assert.equal(r.direction, 'stored-newer');
  assert.equal(judge.calls.length, 0);
});
