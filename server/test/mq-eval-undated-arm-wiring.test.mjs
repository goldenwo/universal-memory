// server/test/mq-eval-undated-arm-wiring.test.mjs — the undated arm's SEQUENCE and SCOPING.
//
// The individual pieces (strip, cohort assertions, back-dating, decay parameter) each have
// their own tests. What this file proves is that `runUndatedArm` composes them in the ONE
// order that makes the measurement meaningful, and addresses the right points:
//
//   - `materialiseValidFrom` actually runs. Skipping it is invisible: seedCorpus reads only
//     `valid_from`, so unmaterialised rows get stamped `now`, every cohort assertion still
//     passes, and the dated cohort has silently collapsed to age 0.
//   - Only the GOLD subset is stripped, addressed by WRITE ID rather than eval_ref.
//   - Both cohort assertions run BEFORE any number is computed — both failure directions
//     produce a vacuous pass that looks exactly like success.
//   - Dedup merging is REFUSED rather than assumed away.
//
// Everything live is injected, so this runs offline: no qdrant, no embedder, no API key.
// The live seams (does deletePayload really remove the key?) are proven by a live probe and
// by the run itself — a fake cannot testify about qdrant's behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runUndatedArm, undatedArmCohorts, undatedArmMetrics, materialiseValidFrom,
} from '../eval/memory-quality-eval.mjs';
import { isUsableDate, undatedFactorFor, UNDATED_FACTOR } from '../lib/ranking.mjs';
import { createUndatedImputation } from '../lib/undated-imputation.mjs';

const COL = 'eval_mq_wiring_test';
const NOW = Date.parse('2026-08-06T00:00:00.000Z');

/** Two gold rows and two dated rows — the smallest fixture with both cohorts non-empty. */
const rows = () => [
  { id: 'g1', undated_gold: true, query: 'q-g1', target_ref: 'g1:0', category: 'work', paraphrase_level: 'paraphrase', seed_facts: [{ text: 'gold one', lane: 'work', days_ago: 6 }] },
  { id: 'd1', undated_gold: false, query: 'q-d1', target_ref: 'd1:0', category: 'work', paraphrase_level: 'paraphrase', seed_facts: [{ text: 'dated one', lane: 'work', days_ago: 3 }] },
  { id: 'g2', undated_gold: true, query: 'q-g2', target_ref: 'g2:0', category: 'home', paraphrase_level: 'oblique', seed_facts: [{ text: 'gold two', lane: 'home', days_ago: 13 }] },
  { id: 'd2', undated_gold: false, query: 'q-d2', target_ref: 'd2:0', category: 'home', paraphrase_level: 'oblique', seed_facts: [{ text: 'dated two', lane: 'home', days_ago: 19 }] },
];

/**
 * A fake stack that records the ORDER of every significant operation, so the test can
 * assert the sequence rather than just the end state.
 */
function fakes(fakeOpts = {}) {
  const { mergedCount = 0 } = fakeOpts;
  const calls = [];
  const payloads = new Map();       // writeId -> payload
  const refToId = new Map();
  let n = 0;

  const seenText = new Set();
  const umAdd = async ({ text, metadata }) => {
    const dupText = seenText.has(text);
    seenText.add(text);
    const id = `pt-${++n}`;
    refToId.set(metadata.eval_ref, id);
    payloads.set(id, { eval_ref: metadata.eval_ref, lane: metadata.lane, ...(metadata.valid_from !== undefined ? { valid_from: metadata.valid_from } : {}) });
    calls.push({ op: 'umAdd', ref: metadata.eval_ref, valid_from: metadata.valid_from });
    return { results: [{ id, event: (n <= mergedCount || dupText) ? 'DEDUP_MERGED' : 'ADD' }] };
  };

  const client = {
    async deletePayload(collection, { points, keys }) {
      calls.push({ op: 'deletePayload', points: [...points], keys: [...keys] });
      for (const id of points) for (const k of keys) delete payloads.get(id)?.[k];
    },
    async retrieve(collection, { ids }) {
      calls.push({ op: 'retrieve', ids: [...ids] });
      return ids.filter((id) => payloads.has(id)).map((id) => ({ id, payload: payloads.get(id) }));
    },
  };

  // #297: the engagement precondition (spec §6.5) needs the full-corpus scan seam in umGetAll's
  // `{results}` shape and a cache factory; the read path's factor contract is modelled in
  // doSearch below (an UNDATED top hit scales by the seam's statistic when decay is on).
  const goldIds = () => new Set(['g1:0', 'g2:0'].map((r) => refToId.get(r)));
  const listAll = async (_memory, args) => {
    calls.push({ op: 'listAll', args });
    return { results: [...payloads].map(([id, p]) => ({ id, metadata: { eval_ref: p.eval_ref, lane: p.lane, ...(p.valid_from !== undefined ? { valid_from: p.valid_from } : {}) } })) };
  };
  const createImputation = (o) => createUndatedImputation({ ...o, log: { info: () => {}, warn: () => {} }, retry: (fn) => fn() });

  // recallPass embeds each seed then searches per row; return the target first every time.
  const embed = async () => ({ vector: [1, 0, 0], tokensIn: 1, tokensOut: 0, costUsd: 0 });
  const cosineStrict = () => 0.1;
  const doSearch = async (query, _limit, _inc, _full, ctx) => {
    calls.push({ op: 'doSearch', query });
    const ref = `${query.replace(/^q-/, '')}:0`;
    const target = refToId.get(ref);
    let score = 0.9;
    if (process.env.UM_TEMPORAL_DECAY === 'true' && goldIds().has(target)) {
      const seam = ctx?._undatedImputation;
      score = 0.9 * (seam ? undatedFactorFor(seam.get().ageDaysAtQuantile, 30) : UNDATED_FACTOR);
    }
    return { results: [{ id: target, score }, { id: 'noise', score: 0.1 }] };
  };

  // Distractor generator: deterministic, and `dupes` of them collide so the test can prove
  // distractor collapse is TOLERATED while a fixture collapse is refused.
  const generateDistractors = (count, { seed }) => Array.from({ length: count }, (_, i) => ({
    text: i < (fakeOpts.dupeDistractors ?? 0) ? 'colliding distractor' : `distractor text ${seed}-${i}`,
    lane: 'work',
  }));
  const lanesFromRows = () => ['work', 'home'];

  return { calls, payloads, refToId, umAdd, client, listAll, createImputation, embed, cosineStrict, doSearch, generateDistractors, lanesFromRows, memory: {}, NOOP_METRICS: {} };
}

const run = (f, over = {}) => runUndatedArm({
  rows: rows(), collection: COL, now: NOW,
  umAdd: f.umAdd, memory: f.memory, client: f.client, doSearch: f.doSearch,
  embed: f.embed, cosineStrict: f.cosineStrict, NOOP_METRICS: f.NOOP_METRICS,
  generateDistractors: f.generateDistractors, lanesFromRows: f.lanesFromRows,
  createImputation: f.createImputation, listAll: f.listAll,
  // #297: 2 dated fixture rows + 25 distractors = 27 dated points ≥ UNDATED_MIN_COHORT, so the
  // engagement precondition (decay-ON runs) can reach `mode: relative`.
  distractors: 25, distractorSeed: 1,
  ...over,
});

// --- pure pieces -----------------------------------------------------------

test('undatedArmCohorts: splits by undated_gold and maps only DATED refs to expectations', () => {
  const { goldRefs, datedRefs, expectedByRef } = undatedArmCohorts(materialiseValidFrom(rows(), NOW));
  assert.deepEqual(goldRefs, ['g1:0', 'g2:0']);
  assert.deepEqual(datedRefs, ['d1:0', 'd2:0']);
  assert.deepEqual(Object.keys(expectedByRef), ['d1:0', 'd2:0'], 'gold refs must NOT appear — their dates are about to be deleted');
  for (const v of Object.values(expectedByRef)) assert.ok(isUsableDate(v));
});

test('undatedArmMetrics: G2 is recall@5 over the gold subset only', () => {
  const details = [
    { target_ref: 'g1:0', rr: 1, recallByK: { 5: 1 } },
    { target_ref: 'g2:0', rr: 0, recallByK: { 5: 0 } },   // missed
    { target_ref: 'd1:0', rr: 1, recallByK: { 5: 1 } },   // dated — must be ignored
  ];
  const { g2 } = undatedArmMetrics(details, ['g1:0', 'g2:0']);
  assert.equal(g2.rows, 2, 'dated rows must not dilute the subset');
  assert.equal(g2.value, 0.5);
});

test('undatedArmMetrics: G1 excludes unranked rows from the mean and COUNTS them', () => {
  // Averaging only over found rows while hiding how many vanished is how a mean-rank
  // "improvement" gets manufactured by losing the hard rows.
  const details = [
    { target_ref: 'g1:0', rr: 1, recallByK: { 5: 1 } },       // rank 1
    { target_ref: 'g2:0', rr: 1 / 3, recallByK: { 5: 1 } },   // rank 3
    { target_ref: 'g3:0', rr: 0, recallByK: { 5: 0 } },       // never surfaced
  ];
  const { g1 } = undatedArmMetrics(details, ['g1:0', 'g2:0', 'g3:0']);
  assert.equal(g1.meanRank, 2);
  assert.equal(g1.rowsRanked, 2);
  assert.equal(g1.rowsUnranked, 1);
});

test('undatedArmMetrics: an empty gold subset reports null rather than 0', () => {
  const { g2 } = undatedArmMetrics([{ target_ref: 'd1:0', rr: 1, recallByK: { 5: 1 } }], []);
  assert.equal(g2.value, null, '0 would read as "the policy destroyed recall"');
});

// --- the sequence ----------------------------------------------------------

test('runUndatedArm: materialises days_ago into valid_from BEFORE seeding', async () => {
  const f = fakes();
  await run(f);
  const seeded = f.calls.filter((c) => c.op === 'umAdd');
  assert.equal(seeded.length, 29, '4 fixture rows + 25 distractors');
  for (const c of seeded) {
    assert.ok(isUsableDate(c.valid_from), `${c.ref} reached umAdd without a usable valid_from`);
  }
  // g2 is 13 days old in the fixture — proves the AGE survived, not just the key.
  const g2 = seeded.find((c) => c.ref === 'g2:0');
  assert.equal(NOW - Date.parse(g2.valid_from), 13 * 86400000);
});

test('runUndatedArm: strips ONLY the gold subset, addressed by write id', async () => {
  const f = fakes();
  await run(f);
  const del = f.calls.filter((c) => c.op === 'deletePayload');
  assert.equal(del.length, 1, 'exactly one strip');
  assert.deepEqual(del[0].keys, ['valid_from']);
  assert.deepEqual(del[0].points, [f.refToId.get('g1:0'), f.refToId.get('g2:0')]);
  // and the dated points still carry theirs
  assert.equal(f.payloads.get(f.refToId.get('d1:0')).valid_from !== undefined, true);
  assert.equal(f.payloads.get(f.refToId.get('g1:0')).valid_from, undefined);
});

test('runUndatedArm: the strip happens BEFORE the first search', async () => {
  const f = fakes();
  await run(f);
  const ops = f.calls.map((c) => c.op);
  assert.ok(ops.indexOf('deletePayload') < ops.indexOf('doSearch'),
    'searching before the strip would measure a fully-dated corpus');
});

test('runUndatedArm: BOTH cohort checks run before any search', async () => {
  const f = fakes();
  await run(f);
  const ops = f.calls.map((c) => c.op);
  const firstRetrieveAfterStrip = ops.indexOf('retrieve', ops.indexOf('deletePayload'));
  assert.ok(firstRetrieveAfterStrip > -1, 'the cohorts must be verified');
  assert.ok(firstRetrieveAfterStrip < ops.indexOf('doSearch'),
    'a vacuous corpus must be caught before a single number is computed');
});

test('runUndatedArm: REFUSES a run where dedup merged a seed', async () => {
  // mergedCount must be MEASURED, not true by construction — this is exactly what the
  // _systemMigration shortcut would have silently guaranteed.
  const f = fakes({ mergedCount: 1 });
  await assert.rejects(() => run(f), /DEDUP_MERGED/);
});

test('runUndatedArm: refuses a non-scratch collection before touching anything', async () => {
  const f = fakes();
  await assert.rejects(() => run(f, { collection: 'memories' }), /refusing non-scratch collection|scratch/i);
  assert.equal(f.calls.length, 0);
});

test('runUndatedArm: records the resolved decay flag truthfully and clears the env', async () => {
  const prior = process.env.UM_TEMPORAL_DECAY;
  delete process.env.UM_TEMPORAL_DECAY;
  try {
    const on = await run(fakes());
    assert.equal(on.flags.UM_TEMPORAL_DECAY, 'true', 'the arm defaults to decay ON');
    assert.equal(process.env.UM_TEMPORAL_DECAY, undefined, 'the pin must not leak past the run');

    const off = await run(fakes(), { decay: false });
    assert.equal(off.flags.UM_TEMPORAL_DECAY, 'false');
  } finally {
    if (prior === undefined) delete process.env.UM_TEMPORAL_DECAY; else process.env.UM_TEMPORAL_DECAY = prior;
  }
});

test('runUndatedArm: reports the fixture parameters alongside G1 (never a bare number)', async () => {
  // G1 is fixture-determined, so it is meaningless without the parameters that produced it.
  const out = await run(fakes());
  assert.equal(out.fixture.undatedGold, 2);
  assert.equal(out.fixture.dated, 2);
  assert.deepEqual(out.fixture.ageSpreadDays, [3, 6, 13, 19]);
  assert.match(out.g1.metric, /REPORTED, not gated/);
  assert.equal(out.g2.rows, 2);
  assert.equal(out.g2.value, 1, 'the fake search returns every target at rank 1');
});

// --- distractors: competition, not cohort members --------------------------

test('runUndatedArm: distractors ARE seeded but NEVER queried', async () => {
  // Without them every gold wins at rank 1 by a wide margin and the gate sits at ceiling —
  // it would return the same number for any imputed factor, which is not evidence.
  const f = fakes();
  const out = await run(f, { distractors: 25 });
  const seededRefs = f.calls.filter((c) => c.op === 'umAdd').map((c) => c.ref);
  assert.equal(seededRefs.filter((r) => r.startsWith('distractor:')).length, 25, 'distractors must reach the collection');
  const queried = f.calls.filter((c) => c.op === 'doSearch').map((c) => c.query);
  // #297: the engagement precondition's two probe searches (decay-off raw, decay-on through
  // the seam) precede the measured pass and target a gold row; the measured pass is unchanged.
  assert.deepEqual(queried.slice(0, 2), ['q-g1', 'q-g1'], 'the probe pair targets the first gold row');
  assert.deepEqual(queried.slice(2), ['q-g1', 'q-d1', 'q-g2', 'q-d2'], 'only fixture rows carry queries');
  assert.equal(out.corpus.distractorsRequested, 25);
  assert.equal(out.corpus.fixtureSeeds, 4);
});

test('runUndatedArm: distractors are back-dated across the FIXTURE spread, not left at age 0', async () => {
  const f = fakes();
  await run(f, { distractors: 24 });
  const ages = f.calls.filter((c) => c.op === 'umAdd' && c.ref.startsWith('distractor:'))
    .map((c) => Math.round((NOW - Date.parse(c.valid_from)) / 86400000));
  assert.deepEqual(ages.slice(0, 4), [6, 3, 13, 19], 'cycles the fixture ages, so the competition looks like the corpus');
  assert.ok(ages.every((a) => [6, 3, 13, 19].includes(a)), 'every distractor sits on the fixture spread');
});

test('runUndatedArm: a DISTRACTOR collapse is tolerated — only FIXTURE merges abort', async () => {
  // 353 generated distractors really do collapse to ~342 against a live qdrant. Aborting on
  // that would make every run red, and "relax the guard" would be the tempting wrong fix.
  const f = fakes({ dupeDistractors: 3 });
  const out = await run(f, { distractors: 25 });
  assert.equal(out.corpus.fixtureSeeds, 4, 'the cohort split is untouched by distractor collapse');
  assert.ok(out.mergedCount > 0, 'and the collapse is still REPORTED, not hidden');
});

test('runUndatedArm: still refuses a FIXTURE merge even with distractors present', async () => {
  const f = fakes({ mergedCount: 1 });
  await assert.rejects(() => run(f, { distractors: 3 }), /FIXTURE seed\(s\) were DEDUP_MERGED/);
});
