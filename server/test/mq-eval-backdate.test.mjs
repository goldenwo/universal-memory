// server/test/mq-eval-backdate.test.mjs — back-dating the dated cohort.
//
// Without back-dating every seed is ~0 days old, sits at a decay factor of ~1.0, and the
// "decay on" arm is indistinguishable from "decay off" — the measurement degenerates to
// its worst-case corner and tests the fixture rather than the policy.
//
// THE TRAP THIS FILE EXISTS FOR: lib/add.mjs preserves a caller-supplied `valid_from`
// only when `isUsableDate` accepts it, and isUsableDate demands `typeof v === 'string'`.
// A `Date` object or an epoch number is rejected and silently replaced with `now`. The
// point still HAS a valid_from afterwards — so a PRESENCE check passes while the entire
// cohort has reverted to ~0 days old. Equality is the only assertion that can tell the
// difference, and every test below is written against the real predicate (isUsableDate
// imported from the read path) rather than a local regex, so the two cannot drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backdatedIso, assertBackdated, seedCorpus } from '../eval/memory-quality-eval.mjs';
import { isUsableDate } from '../lib/ranking.mjs';

const NOW = Date.parse('2026-08-06T00:00:00.000Z');

// --- backdatedIso: a string the WRITE PATH will actually keep ---------------

test('backdatedIso: returns a string', () => {
  assert.equal(typeof backdatedIso(6, NOW), 'string');
});

test('backdatedIso: its output is ACCEPTED by the read path predicate that gates the write', () => {
  // Pinned to isUsableDate itself, not to a regex — if that predicate ever tightens,
  // this fails here rather than silently re-stamping every dated seed at run time.
  for (const d of [0, 1, 6, 13, 19, 400]) {
    assert.ok(isUsableDate(backdatedIso(d, NOW)), `isUsableDate rejected backdatedIso(${d})`);
  }
});

test('backdatedIso: NEGATIVE CONTROL — a Date object and an epoch number are REJECTED', () => {
  // This is why the helper returns a string. Both of these reach add.mjs, fail
  // isUsableDate, and get clobbered by a freshly minted `now`.
  assert.equal(isUsableDate(new Date(NOW)), false, 'a Date object must be rejected');
  assert.equal(isUsableDate(NOW), false, 'an epoch number must be rejected');
  assert.equal(isUsableDate(String(NOW)), false, 'a stringified epoch is not a usable date either');
  assert.equal(isUsableDate(null), false);
  assert.equal(isUsableDate(undefined), false);
});

test('backdatedIso: lands the requested number of days before `now`', () => {
  for (const d of [1, 6, 13, 19]) {
    const ms = Date.parse(backdatedIso(d, NOW));
    assert.equal(NOW - ms, d * 86400000, `backdatedIso(${d}) is not ${d} days back`);
  }
});

test('backdatedIso: is deterministic for a pinned `now` (fixtures must be reproducible)', () => {
  assert.equal(backdatedIso(6, NOW), backdatedIso(6, NOW));
  assert.equal(backdatedIso(6, NOW), '2026-07-31T00:00:00.000Z');
});

test('backdatedIso: refuses a non-finite daysAgo instead of minting Invalid Date', () => {
  for (const bad of [NaN, Infinity, undefined, null, '6']) {
    assert.throws(() => backdatedIso(bad, NOW), /finite daysAgo/);
  }
});

test('backdatedIso: refuses a NEGATIVE daysAgo — a future date inflates the decay factor above 1', () => {
  // applyTemporalDecay has no upper clamp, so a sign typo would silently BOOST a seed
  // rather than degrade it — the failure mode hardest to spot in a result table.
  for (const bad of [-1, -0.5, -19]) {
    assert.throws(() => backdatedIso(bad, NOW), /negative daysAgo/);
  }
  assert.doesNotThrow(() => backdatedIso(0, NOW), 'zero is a legitimate "today"');
});

test('backdatedIso: refuses a daysAgo that overflows the Date range, with its own message', () => {
  assert.throws(() => backdatedIso(1e12, NOW), /representable Date range/);
});

// --- assertBackdated: EQUALITY, not presence -------------------------------

test('assertBackdated: passes when every dated point carries its exact fixture value', () => {
  const want = backdatedIso(6, NOW);
  const got = assertBackdated([{ eval_ref: 'r1:0', valid_from: want }], { 'r1:0': want });
  assert.deepEqual(got, { checked: 1 });
});

test('assertBackdated: FAILS on a present-but-different value — the presence-vs-equality trap', () => {
  // Exactly what a silent re-stamp looks like: the key is there, the value is `now`.
  const want = backdatedIso(6, NOW);
  const restamped = new Date(NOW).toISOString();
  assert.throws(
    () => assertBackdated([{ eval_ref: 'r1:0', valid_from: restamped }], { 'r1:0': want }),
    /BACK-DATE VIOLATION/,
  );
  // And prove the weaker check would NOT have caught it — this is the whole point.
  assert.notEqual(restamped, want);
  assert.ok(restamped !== undefined, 'a presence check passes here, which is why presence is not enough');
});

test('assertBackdated: FAILS when a point is missing entirely', () => {
  assert.throws(() => assertBackdated([], { 'r1:0': backdatedIso(6, NOW) }), /not found/);
});

test('assertBackdated: FAILS when valid_from is absent on an expected point', () => {
  assert.throws(
    () => assertBackdated([{ eval_ref: 'r1:0' }], { 'r1:0': backdatedIso(6, NOW) }),
    /BACK-DATE VIOLATION/,
  );
});

test('assertBackdated: refuses an EMPTY expectation map (it would assert nothing)', () => {
  assert.throws(() => assertBackdated([{ eval_ref: 'r1:0', valid_from: 'x' }], {}), /non-empty/);
  assert.throws(() => assertBackdated([], undefined), /non-empty/);
});

test('assertBackdated: refuses UNDEFINED expectations — undefined === undefined would pass vacuously', () => {
  // The natural construction over a MIXED fixture is
  //   Object.fromEntries(rows.flatMap(r => r.seed_facts.map((f,i) => [`${r.id}:${i}`, f.valid_from])))
  // which yields `undefined` for every UNDATED seed. Comparing undefined to undefined
  // succeeds, so those refs would inflate `checked` while asserting nothing at all.
  assert.throws(
    () => assertBackdated([{ eval_ref: 'r1:0' }], { 'r1:0': undefined }),
    /must all be usable date strings/,
  );
  assert.throws(
    () => assertBackdated([{ eval_ref: 'a', valid_from: backdatedIso(6, NOW) }, { eval_ref: 'b' }],
      { a: backdatedIso(6, NOW), b: undefined }),
    /must all be usable date strings/,
  );
});

test('assertBackdated: refuses a non-string expectation (Date object / epoch number)', () => {
  assert.throws(() => assertBackdated([{ eval_ref: 'a', valid_from: 'x' }], { a: new Date(NOW) }), /usable date strings/);
  assert.throws(() => assertBackdated([{ eval_ref: 'a', valid_from: 'x' }], { a: NOW }), /usable date strings/);
});

test('assertBackdated: refuses DUPLICATE eval_refs — last-wins could mask a re-stamped point', () => {
  const want = backdatedIso(6, NOW);
  assert.throws(
    () => assertBackdated(
      [{ eval_ref: 'dup', valid_from: 'wrong' }, { eval_ref: 'dup', valid_from: want }],
      { dup: want },
    ),
    /duplicate eval_refs/,
  );
});

test('assertBackdated: accepts a Map as well as a plain object', () => {
  const want = backdatedIso(13, NOW);
  const got = assertBackdated([{ eval_ref: 'r2:0', valid_from: want }], new Map([['r2:0', want]]));
  assert.deepEqual(got, { checked: 1 });
});

test('assertBackdated: reports every offender, not just the first', () => {
  const want = backdatedIso(6, NOW);
  try {
    assertBackdated(
      [{ eval_ref: 'a', valid_from: 'wrong' }, { eval_ref: 'b', valid_from: 'wrong' }],
      { a: want, b: want },
    );
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /2\/2 dated points/);
  }
});

// --- seedCorpus: the pass-through, and the byte-identical default ----------

/** Capture what seedCorpus hands to umAdd, without touching a live path. */
function captureSeeds() {
  const seen = [];
  const umAdd = async (args) => { seen.push(args); return { results: [{ id: `id-${seen.length}`, event: 'ADD' }] }; };
  const latency = { umAdd: [], doSearch: [] };
  return { seen, umAdd, latency };
}

test('seedCorpus: forwards a seed fact\'s valid_from into umAdd metadata', async () => {
  const want = backdatedIso(6, NOW);
  const { seen, umAdd, latency } = captureSeeds();
  await seedCorpus({
    umAdd, memory: {}, client: {}, latency, metrics: {},
    rows: [{ id: 'r1', seed_facts: [{ text: 't', lane: 'work', valid_from: want }] }],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].metadata.valid_from, want);
});

test('seedCorpus: a fact WITHOUT valid_from yields metadata identical to before (nightly gate)', async () => {
  // memory-quality-eval IS the nightly drift gate; its default rows must not move.
  // deepEqual on the exact object, so an added `valid_from: undefined` key would fail.
  const { seen, umAdd, latency } = captureSeeds();
  await seedCorpus({
    umAdd, memory: {}, client: {}, latency, metrics: {},
    rows: [{ id: 'r1', seed_facts: [{ text: 't', lane: 'work' }] }],
  });
  assert.deepEqual(seen[0].metadata, { eval_ref: 'r1:0', lane: 'work' });
  assert.ok(!('valid_from' in seen[0].metadata), 'no valid_from key may appear on a default row');
});

test('seedCorpus: mixed rows — only the fact that supplied a date carries one', async () => {
  const want = backdatedIso(13, NOW);
  const { seen, umAdd, latency } = captureSeeds();
  await seedCorpus({
    umAdd, memory: {}, client: {}, latency, metrics: {},
    rows: [{ id: 'r1', seed_facts: [{ text: 'a', lane: 'work', valid_from: want }, { text: 'b', lane: 'work' }] }],
  });
  assert.equal(seen[0].metadata.valid_from, want);
  assert.ok(!('valid_from' in seen[1].metadata));
});

test('seedCorpus: still pins eval_ref and lane, and keeps infer:false', async () => {
  const { seen, umAdd, latency } = captureSeeds();
  await seedCorpus({
    umAdd, memory: {}, client: {}, latency, metrics: {},
    rows: [{ id: 'r9', seed_facts: [{ text: 't', lane: 'personal' }] }],
  });
  assert.equal(seen[0].metadata.eval_ref, 'r9:0');
  assert.equal(seen[0].metadata.lane, 'personal');
  assert.equal(seen[0].infer, false);
});

test('seedCorpus: a forwarded value that the write path would REJECT is still forwarded verbatim', async () => {
  // seedCorpus must not silently "fix" a bad fixture value — that would hide the defect
  // from assertBackdated, which is the layer designed to catch it.
  const { seen, umAdd, latency } = captureSeeds();
  const badDate = new Date(NOW);
  await seedCorpus({
    umAdd, memory: {}, client: {}, latency, metrics: {},
    rows: [{ id: 'r1', seed_facts: [{ text: 't', lane: 'work', valid_from: badDate }] }],
  });
  assert.equal(seen[0].metadata.valid_from, badDate);
  assert.equal(isUsableDate(seen[0].metadata.valid_from), false, 'and the write path would reject it — assertBackdated is the guard');
});
