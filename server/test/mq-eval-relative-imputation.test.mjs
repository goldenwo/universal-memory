// server/test/mq-eval-relative-imputation.test.mjs — #297 T5: the eval harness under the
// relative undated-imputation policy (spec §6.5, plan T5).
//
// Pins, all offline (no qdrant, no embedder, no key):
//   - parseArgs: `--aged <k>` and `--decay-policy <relative|fixed>` have explicit entries and
//     validate loudly (a silently-ignored flag is how a half-threaded k would publish a young
//     number under an aged label);
//   - materialiseValidFrom(rows, now, agedK) scales the DATE uniformly and leaves days_ago alone;
//   - the engagement precondition: the seam is used on every measured doSearch, the DI scan's
//     first invocation sees ZERO gold ids carrying valid_from (post-strip ordering), the cohort
//     is SET-based (|Set(writeId)| − |gold|), both policies' probe assertions hold, and any
//     failed assertion ABORTS the run (INVALID, never a pass);
//   - the aged arm's ±2 d realised-A_q assertion, the SCALED age spread, and the stamp (D26);
//   - the headroom report names the demotion the measured policy actually applied (P7).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runUndatedArm, engageUndatedImputation, parseArgs, materialiseValidFrom, undatedArmMetrics,
  answerCorrectnessPass, collectBounceRows, AGED_TARGET_DAYS, AGED_TOLERANCE_DAYS,
} from '../eval/memory-quality-eval.mjs';
import { createUndatedImputation } from '../lib/undated-imputation.mjs';
import { undatedFactorFor, UNDATED_FACTOR } from '../lib/ranking.mjs';

const COL = 'eval_mq_relative_test';
const DAY = 86400000;
const NOW = Date.parse('2026-09-04T00:00:00.000Z');
const quiet = { info: () => {}, warn: () => {} };

/** Two gold rows and two dated rows (days_ago 6 / 3 / 13 / 19 — the spread the distractors cycle). */
const rows = () => [
  { id: 'g1', undated_gold: true, query: 'q-g1', target_ref: 'g1:0', category: 'work', paraphrase_level: 'paraphrase', seed_facts: [{ text: 'gold one', lane: 'work', days_ago: 6 }] },
  { id: 'd1', undated_gold: false, query: 'q-d1', target_ref: 'd1:0', category: 'work', paraphrase_level: 'paraphrase', seed_facts: [{ text: 'dated one', lane: 'work', days_ago: 3 }] },
  { id: 'g2', undated_gold: true, query: 'q-g2', target_ref: 'g2:0', category: 'home', paraphrase_level: 'oblique', seed_facts: [{ text: 'gold two', lane: 'home', days_ago: 13 }] },
  { id: 'd2', undated_gold: false, query: 'q-d2', target_ref: 'd2:0', category: 'home', paraphrase_level: 'oblique', seed_facts: [{ text: 'dated two', lane: 'home', days_ago: 19 }] },
];

/**
 * A fake stack modelling exactly the contracts the precondition relies on:
 *   - umAdd dedups by TEXT the way the write path does: a duplicate returns the FIRST point's
 *     id with event DEDUP_MERGED (so |Set(writeId)| < seeds.length under collapse);
 *   - listAll enumerates the stored payloads in umGetAll's `{results}` shape;
 *   - doSearch honours the read path's contract: with UM_TEMPORAL_DECAY=true an UNDATED top
 *     hit is scaled by undatedFactorFor(ctx._undatedImputation.get().ageDaysAtQuantile, 30),
 *     and WITHOUT the seam by the module fallback (the unconfigured singleton's value).
 */
function fakes(opts = {}) {
  const { dupeDistractors = 0, ignoreSeam = false, resurrectGoldDates = false } = opts;
  const calls = [];
  const payloads = new Map();
  const refToId = new Map();
  const textToId = new Map();
  let n = 0;

  const umAdd = async ({ text, metadata }) => {
    calls.push({ op: 'umAdd', ref: metadata.eval_ref, valid_from: metadata.valid_from });
    if (textToId.has(text)) {
      const id = textToId.get(text);
      refToId.set(metadata.eval_ref, id);
      return { results: [{ id, event: 'DEDUP_MERGED' }] };
    }
    const id = `pt-${++n}`;
    textToId.set(text, id);
    refToId.set(metadata.eval_ref, id);
    payloads.set(id, { eval_ref: metadata.eval_ref, lane: metadata.lane, ...(metadata.valid_from !== undefined ? { valid_from: metadata.valid_from } : {}) });
    return { results: [{ id, event: 'ADD' }] };
  };
  const goldIds = () => new Set(['g1:0', 'g2:0'].map((r) => refToId.get(r)));
  const client = {
    async deletePayload(_c, { points, keys }) {
      calls.push({ op: 'deletePayload', points: [...points], keys: [...keys] });
      for (const id of points) for (const k of keys) delete payloads.get(id)?.[k];
    },
    async retrieve(_c, { ids }) {
      calls.push({ op: 'retrieve', ids: [...ids] });
      return ids.filter((id) => payloads.has(id)).map((id) => ({ id, payload: payloads.get(id) }));
    },
  };
  const listAll = async (_memory, args) => {
    const g = goldIds();
    const results = [...payloads].map(([id, p]) => ({
      id,
      metadata: { eval_ref: p.eval_ref, lane: p.lane, ...(p.valid_from !== undefined ? { valid_from: p.valid_from } : {}), ...(resurrectGoldDates && g.has(id) ? { valid_from: new Date(NOW - 6 * DAY).toISOString() } : {}) },
    }));
    calls.push({ op: 'listAll', args, goldWithDate: results.filter((r) => g.has(r.id) && r.metadata.valid_from != null).length });
    return { results };
  };
  const embed = async () => ({ vector: [1, 0, 0], tokensIn: 1, tokensOut: 0, costUsd: 0 });
  const cosineStrict = () => 0.1;
  const doSearch = async (query, _limit, _inc, _full, ctx) => {
    calls.push({ op: 'doSearch', query, ctx });
    const ref = `${query.replace(/^q-/, '')}:0`;
    const target = refToId.get(ref);
    let score = 0.9;
    if (process.env.UM_TEMPORAL_DECAY === 'true' && goldIds().has(target)) {
      const seam = ignoreSeam ? undefined : ctx?._undatedImputation;
      score = 0.9 * (seam ? undatedFactorFor(seam.get().ageDaysAtQuantile, 30) : UNDATED_FACTOR);
    }
    return { results: [{ id: target, score }, { id: 'noise', score: 0.1 }] };
  };
  const generateDistractors = (count, { seed }) => Array.from({ length: count }, (_, i) => ({
    text: i < dupeDistractors ? 'colliding distractor' : `distractor text ${seed}-${i}`, lane: 'work',
  }));
  const lanesFromRows = () => ['work', 'home'];
  const createImputation = (o) => createUndatedImputation({ ...o, log: quiet, retry: (fn) => fn() });
  return { calls, payloads, refToId, goldIds, umAdd, client, listAll, embed, cosineStrict, doSearch, generateDistractors, lanesFromRows, createImputation, memory: {}, NOOP_METRICS: {} };
}

const run = (f, over = {}) => runUndatedArm({
  rows: rows(), collection: COL, now: NOW,
  umAdd: f.umAdd, memory: f.memory, client: f.client, doSearch: f.doSearch,
  embed: f.embed, cosineStrict: f.cosineStrict, NOOP_METRICS: f.NOOP_METRICS,
  generateDistractors: f.generateDistractors, lanesFromRows: f.lanesFromRows,
  createImputation: f.createImputation, listAll: f.listAll,
  distractors: 25, distractorSeed: 1, // 2 dated fixture rows + 25 distractors = 27 dated ≥ UNDATED_MIN_COHORT
  ...over,
});

// The seeded dated cohort under the fixture above: d1 3 d, d2 19 d, and 25 distractors cycling
// the row spread [6, 3, 13, 19] → ages {3 ×7, 6 ×7, 13 ×6, 19 ×7}, n = 27 → type-7 median = 6.
const EXPECTED_AQ = 6;

// ── parseArgs ──────────────────────────────────────────────────────────────────

test('parseArgs: --aged <k> and --decay-policy <relative|fixed> have explicit entries', () => {
  const a = parseArgs(['node', 'x', '--undated-arm', '--aged', '4.78', '--decay-policy', 'fixed', '--gate', 'eval/mq-gate-thresholds.json']);
  assert.equal(a.undatedArm, true);
  assert.equal(a.aged, 4.78);
  assert.equal(a.decayPolicy, 'fixed');
  assert.equal(a.gate, 'eval/mq-gate-thresholds.json', 'neighbours undisturbed');
  assert.equal(parseArgs(['node', 'x', '--undated-arm']).aged, undefined);
  assert.equal(parseArgs(['node', 'x', '--decay-policy', 'relative']).decayPolicy, 'relative');
});

test('parseArgs: --aged rejects 0 / negative / non-numeric; --decay-policy rejects anything but the two spellings', () => {
  for (const bad of ['0', '-1', 'abc', '']) {
    assert.throws(() => parseArgs(['node', 'x', '--aged', bad]), /--aged needs a positive finite k/, `--aged ${bad}`);
  }
  assert.throws(() => parseArgs(['node', 'x', '--decay-policy', 'on']), /--decay-policy must be 'relative' or 'fixed'/);
});

// ── materialiseValidFrom(agedK) ────────────────────────────────────────────────

test('materialiseValidFrom: agedK scales the DATE uniformly and leaves days_ago untouched', () => {
  const out = materialiseValidFrom(rows(), NOW, 2);
  const g2 = out.find((r) => r.id === 'g2').seed_facts[0];
  assert.equal(NOW - Date.parse(g2.valid_from), 26 * DAY, '13 d × 2');
  assert.equal(g2.days_ago, 13, 'days_ago is a pure mirror of the input');
  assert.throws(() => materialiseValidFrom(rows(), NOW, 0), /positive finite agedK/);
});

// ── the engagement precondition, relative policy ────────────────────────────────

test('relative run: the stamp carries the corpus statistic, the seam factor, and the probe; the headroom uses the same factor', async () => {
  const f = fakes();
  const r = await run(f);
  const s = r.undatedImputation;
  assert.equal(s.policy, 'relative');
  assert.equal(s.mode, 'relative');
  assert.equal(s.cohortN, 27);
  assert.equal(s.ageDaysAtQuantile, EXPECTED_AQ);
  assert.equal(s.factor, Math.exp(-EXPECTED_AQ / 30));
  assert.equal(s.halfLife, 30);
  assert.equal(s.agedK, 1);
  assert.ok(f.goldIds().has(s.probeId), 'the probe is a known undated seed');
  assert.equal(s.rawScore, 0.9);
  assert.ok(Math.abs(s.returnedScore - 0.9 * Math.exp(-EXPECTED_AQ / 30)) < 1e-12);
  assert.equal(r.headroom.policyDemotion, 1 / Math.exp(-EXPECTED_AQ / 30), 'the report names the applied demotion, not the constant');
  assert.deepEqual(r.fixture.ageSpreadDays, [3, 6, 13, 19]);
  assert.equal(r.fixture.agedK, 1);
});

test('relative run: every measured doSearch carries ctx._undatedImputation; the decay-OFF probe carries none', async () => {
  const f = fakes();
  await run(f);
  const searches = f.calls.filter((c) => c.op === 'doSearch');
  assert.ok(searches.length >= 4 + 2, 'probe (off + on) + one per fixture row');
  const [probeOff, probeOn, ...measured] = searches;
  assert.equal(probeOff.ctx._undatedImputation, undefined, 'the decay-OFF probe runs without the seam');
  assert.ok(probeOn.ctx._undatedImputation, 'the decay-ON probe runs through the seam');
  for (const c of measured) assert.ok(c.ctx._undatedImputation, `measured search "${c.query}" must ride the seam`);
  assert.equal(new Set(measured.map((c) => c.ctx._undatedImputation)).size, 1, 'one instance for the whole pass');
});

test('post-strip ordering: the DI scan\'s FIRST invocation runs after the strip and sees zero gold ids carrying valid_from', async () => {
  const f = fakes();
  await run(f);
  const ops = f.calls.map((c) => c.op);
  const firstScan = ops.indexOf('listAll');
  assert.ok(firstScan > ops.indexOf('deletePayload'), 'scan after strip');
  assert.ok(firstScan < ops.indexOf('doSearch'), 'scan before the first search');
  assert.equal(f.calls[firstScan].goldWithDate, 0);
  assert.equal(f.calls[firstScan].args.userId, 'um-mq-eval', 'scoped to the eval user');
});

test('set-based cohort arithmetic: collapsed distractors share a write id and are counted ONCE', async () => {
  const f = fakes({ dupeDistractors: 3 }); // three texts collapse to one point → 2 fewer distinct ids
  const r = await run(f);
  assert.equal(r.corpus.distractorsCollapsed, 2);
  assert.equal(r.undatedImputation.cohortN, 27 - 2, '|Set(writeId)| − |gold|, not seeds.length − gold');
});

// ── the fixed policy (D19 stub) ────────────────────────────────────────────────

test('fixed run: the stub engages the production path — mode fallback, the constant applied, the mirror assertions hold', async () => {
  const f = fakes();
  const r = await run(f, { decayPolicy: 'fixed' });
  const s = r.undatedImputation;
  assert.equal(s.policy, 'fixed');
  assert.equal(s.mode, 'fallback');
  assert.equal(s.cohortN, 27);
  assert.equal(s.ageDaysAtQuantile, EXPECTED_AQ, 'the harness still reports the corpus statistic');
  assert.equal(s.factor, UNDATED_FACTOR);
  assert.ok(Math.abs(s.returnedScore - 0.9 * Math.exp(-0.25)) < 1e-12);
  assert.equal(r.headroom.policyDemotion, 1 / UNDATED_FACTOR);
});

// ── aborts: a failed precondition is INVALID, never a pass ──────────────────────

test('abort: a read path that ignores the seam (still applying the constant) fails the relative probe', async () => {
  await assert.rejects(run(fakes({ ignoreSeam: true })), /INVALID .*did not engage the relative policy/);
});

test('abort: a read path that ignores the seam ALSO fails the fixed mirror? no — it coincides with the constant; the mirror catches a relative leak instead', async () => {
  // Under the fixed policy a seam-ignoring read path applies the constant, which IS the fixed
  // expectation — so the mirror's second half (≠ raw × uf_rel) is what discriminates. A read
  // path applying the RELATIVE factor while the run claims `fixed` must abort:
  const f = fakes();
  const leaky = async (query, l, i, full, ctx) => f.doSearch(query, l, i, full, { ...ctx, _undatedImputation: { get: () => ({ ageDaysAtQuantile: EXPECTED_AQ }) } });
  await assert.rejects(run(f, { decayPolicy: 'fixed', doSearch: leaky }), /INVALID .*did not engage the fixed policy/);
});

test('abort: a cache that stays in fallback after its refresh', async () => {
  const f = fakes();
  const stuck = () => ({ get: () => ({ mode: 'fallback', ageDaysAtQuantile: null, cohortN: null, lastError: 'scan exploded' }), refreshIfDue: () => Promise.resolve() });
  await assert.rejects(run(f, { createImputation: stuck }), /INVALID .*cache mode 'fallback'/);
});

test('abort: too few dated points for a statistic', async () => {
  await assert.rejects(run(fakes(), { distractors: 3 }), /INVALID .*no statistic/);
});

test('abort: golds still dated at the first scan', async () => {
  await assert.rejects(run(fakes({ resurrectGoldDates: true })), /INVALID .*still carry valid_from/);
});

test('abort: no probe row whose decay-OFF top hit is a known undated seed', async () => {
  const f = fakes();
  const noisy = async (query, l, i, full, ctx) => {
    const r = await f.doSearch(query, l, i, full, ctx);
    return { results: [{ id: 'noise', score: 0.95 }, ...r.results] };
  };
  await assert.rejects(run(f, { doSearch: noisy }), /INVALID .*no probe row/);
});

// ── the aged arm ───────────────────────────────────────────────────────────────

test('aged run: k threads to BOTH materialise sites; the realised A_q must land within ±2 d of 28.7 d; the spread is stamped SCALED', async () => {
  const k = AGED_TARGET_DAYS / EXPECTED_AQ; // closed-form, as plan T5 step 0 derives it
  const f = fakes();
  const r = await run(f, { agedK: k });
  const s = r.undatedImputation;
  assert.ok(Math.abs(s.ageDaysAtQuantile - AGED_TARGET_DAYS) < 1e-9, `realised A_q ${s.ageDaysAtQuantile}`);
  assert.equal(s.agedK, k);
  assert.equal(s.factor, Math.exp(-s.ageDaysAtQuantile / 30));
  assert.deepEqual(r.fixture.ageSpreadDays, [3, 6, 13, 19].map((d) => d * k), 'never raw days_ago under an aged label');
  // both sites scaled: the distractor seeds were back-dated at the SCALED spread
  const seededDistractor = f.calls.find((c) => c.op === 'umAdd' && c.ref.startsWith('distractor:'));
  const age = (NOW - Date.parse(seededDistractor.valid_from)) / DAY;
  assert.ok([3, 6, 13, 19].map((d) => d * k).some((x) => Math.abs(x - age) < 1e-9), `distractor age ${age} is on the scaled spread`);
  assert.equal(AGED_TOLERANCE_DAYS, 2);
});

test('aged run: a k that lands the median outside ±2 d is INVALID', async () => {
  await assert.rejects(run(fakes(), { agedK: 2 }), /INVALID .*aged run: realised A_q 12\.00 d/);
});

// ── decay-OFF runs have no policy to prove ─────────────────────────────────────

test('decay-off run: no precondition runs (no scan), the stamp is null but the key is PRESENT (version signal)', async () => {
  const f = fakes();
  const r = await run(f, { decay: false });
  assert.ok('undatedImputation' in r);
  assert.equal(r.undatedImputation, null);
  assert.equal(f.calls.filter((c) => c.op === 'listAll').length, 0);
  assert.equal(r.headroom.policyDemotion, 1 / UNDATED_FACTOR);
});

// ── the corpus-sweep seam sites ────────────────────────────────────────────────

test('answerCorrectnessPass / collectBounceRows thread `imputation` into the doSearch ctx (and omit it when not given)', async () => {
  const seen = [];
  const doSearch = async (_q, _l, _i, _f, ctx) => { seen.push(ctx); return { results: [] }; };
  const inst = { get: () => ({ ageDaysAtQuantile: 5 }), refreshIfDue: () => Promise.resolve() };
  const gradeAnswer = async () => ({ answers: false, confidence: 0, ok: true });
  const recallRows = [{ id: 'r', query: 'q' }];
  await answerCorrectnessPass({ gradeAnswer, doSearch, memory: {}, recallRows, noAnswerRows: [], model: 'm', tau: 0.5, imputation: inst });
  await collectBounceRows({ gradeAnswer, doSearch, memory: {}, recallRows, noAnswerRows: [], model: 'm', imputation: inst });
  await answerCorrectnessPass({ gradeAnswer, doSearch, memory: {}, recallRows, noAnswerRows: [], model: 'm', tau: 0.5 });
  assert.equal(seen[0]._undatedImputation, inst);
  assert.equal(seen[1]._undatedImputation, inst);
  assert.ok(!('_undatedImputation' in seen[2]), 'omitted ⇒ ctx shape byte-identical to before');
});

test('undatedArmMetrics: the headroom demotion follows the factor parameter (P7), defaulting to the constant', () => {
  const details = [{ target_ref: 'g:0', rr: 1, recallByK: { 5: 1 }, topScores: [0.9, 0.5] }];
  assert.equal(undatedArmMetrics(details, ['g:0']).headroom.policyDemotion, 1 / UNDATED_FACTOR);
  assert.equal(undatedArmMetrics(details, ['g:0'], { factor: 0.5 }).headroom.policyDemotion, 2);
});

test('engageUndatedImputation: refuses an unknown policy and a missing scan seam before touching anything', async () => {
  await assert.rejects(engageUndatedImputation({ policy: 'median', seeds: [], goldIds: [], fixtureRefs: new Set(), probeRows: [], listAll: async () => ({ results: [] }), doSearch: async () => ({}) }), /unknown policy/);
  await assert.rejects(engageUndatedImputation({ policy: 'relative', seeds: [], goldIds: [], fixtureRefs: new Set(), probeRows: [], doSearch: async () => ({}) }), /no listAll seam/);
});
