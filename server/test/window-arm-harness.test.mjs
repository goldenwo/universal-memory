import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolveWindowRows, WINDOW_ARM_ALLOWED_KINDS } from '../eval/lib/window-arm-fixture.mjs';
import { parseTemporalWindow } from '../lib/temporal-query.mjs';
import { recallPass, windowArmCohorts, runWindowArm, parseArgs, evaluateGate } from '../eval/memory-quality-eval.mjs';

const NOW = Date.UTC(2026, 7, 12, 15, 0, 0); // Wed 2026-08-12
const row = (over = {}) => ({
  id: 'w001', window_kind: 'last_n',
  seed_facts: [
    { text: 'standup moved to 09:15', lane: 'work', days_ago: 3 },
    { text: 'sprint review recorded', lane: 'work', days_ago: 5 },
  ],
  query: 'what changed about the standup in the last 2 weeks',
  target_ref: 'w001:0', category: 'work', paraphrase_level: 'paraphrase', undated_gold: true,
  ...over,
});

test('F1: a query that does not parse throws, naming the row', () => {
  assert.throws(() => resolveWindowRows([row({ query: 'what changed about the standup' })], { now: NOW }),
    /w001.*does not parse/);
});

test('F1: a kind outside the allowed list throws', () => {
  assert.throws(() => resolveWindowRows([row({ query: 'what changed yesterday about the standup' })], { now: NOW }),
    /w001.*kind 'yesterday' not allowed/);
});

test('F2: a companion outside the parsed window throws', () => {
  assert.throws(() => resolveWindowRows([row({
    seed_facts: [{ text: 't', lane: 'work', days_ago: 3 }, { text: 'c', lane: 'work', days_ago: 40 }],
  })], { now: NOW }), /w001.*outside/);
});

test('days_ago: null resolves to the parsed window midpoint', () => {
  const { rows, windowsByRowId } = resolveWindowRows([row({
    window_kind: 'last_month',
    query: 'what did we decide last month about the standup',
    seed_facts: [{ text: 't', lane: 'work', days_ago: null }, { text: 'c', lane: 'work', days_ago: null }],
  })], { now: NOW });
  const w = windowsByRowId.w001;
  const midDays = (NOW - (w.start + w.end) / 2) / 86400000;
  for (const f of rows[0].seed_facts) assert.ok(Math.abs(f.days_ago - midDays) < 1e-9);
});

test('an undated_gold row without exactly one companion throws', () => {
  assert.throws(() => resolveWindowRows([row({ seed_facts: [{ text: 't', lane: 'work', days_ago: 3 }] })],
    { now: NOW }), /w001.*companion/);
});

test('a non-finite now throws (the one-clock guard)', () => {
  assert.throws(() => resolveWindowRows([row()], { now: NaN }), /finite/);
});

test('the shipped fixture passes its own validator at arbitrary clock positions', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../eval/window-arm-set.jsonl', import.meta.url), 'utf8');
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.undated_gold).length, 24, 'arm size is pinned at 24 golds');
  assert.equal(rows.length, 48);
  // Month start, month end, year boundary, leap-adjacent, plus "today": the validator must
  // hold at ANY plausible run time, not just the authoring date.
  const clocks = [Date.UTC(2026, 0, 1, 0, 30), Date.UTC(2026, 2, 31, 23, 0),
    Date.UTC(2026, 11, 31, 12, 0), Date.UTC(2028, 1, 29, 12, 0), Date.now()];
  for (const now of clocks) {
    const { rows: resolved } = resolveWindowRows(rows, { now });
    for (const r of resolved) {
      const w = parseTemporalWindow(r.query, { now });
      assert.ok(w, `${r.id} must parse at ${new Date(now).toISOString()}`);
      assert.ok(WINDOW_ARM_ALLOWED_KINDS.includes(w.kind), `${r.id} kind ${w.kind}`);
    }
  }
});

// --- windowArmCohorts (pure) -------------------------------------------------

test('windowArmCohorts: gold target strips, companion and dated targets stay dated', () => {
  const rows = [
    { id: 'w1', undated_gold: true, seed_facts: [
      { text: 't', valid_from: '2026-08-01T00:00:00.000Z' },
      { text: 'c', valid_from: '2026-08-05T00:00:00.000Z' }] },
    { id: 'w2', undated_gold: false, seed_facts: [{ text: 'd', valid_from: '2026-08-06T00:00:00.000Z' }] },
  ];
  const { goldRefs, datedRefs, expectedByRef } = windowArmCohorts(rows);
  assert.deepEqual(goldRefs, ['w1:0']);
  assert.deepEqual(datedRefs, ['w1:1', 'w2:0']);
  assert.equal(expectedByRef['w1:1'], '2026-08-05T00:00:00.000Z');
  assert.equal(expectedByRef['w2:0'], '2026-08-06T00:00:00.000Z');
});

const stubEmbed = async () => ({ vector: [1, 0], tokensIn: 0, tokensOut: 0, costUsd: 0 });
const stubCosine = () => 0; // no twins
const NOOP = {};
const mkSeeds = () => [
  { eval_ref: 'w001:0', text: 't', lane: 'work', writeId: 'id-gold' },
  { eval_ref: 'w001:1', text: 'c', lane: 'work', writeId: 'id-dated' },
];
const mkRows = () => [{ id: 'w001', query: 'q in the last 2 weeks', target_ref: 'w001:0', paraphrase_level: 'p' }];
const baseArgs = (doSearch) => ({
  doSearch, embed: stubEmbed, cosineStrict: stubCosine, NOOP_METRICS: NOOP, memory: {},
  rows: mkRows(), seeds: mkSeeds(), ks: [1, 3, 5], cost: { embedTokensIn: 0, embedTokensOut: 0, embedCostUsd: 0 },
  latency: { doSearch: [] },
});

test('project: gold demoted below a dated competitor is an eviction the projection sees', async () => {
  const doSearch = async () => ({ _temporalWidened: true, results: [
    { id: 'id-gold', score: 0.80 },   // undated gold, rank 1 observed
    { id: 'id-dated', score: 0.75 },  // in-window dated
  ] });
  const r = await recallPass({ ...baseArgs(doSearch), captureScores: true,
    project: { cohort: 'undated', factor: 0.5, writeIds: new Set(['id-gold']) } });
  // 0.80*0.5 = 0.40 < 0.75 → projected rank 2, still recall@5 = 1; identity unchanged.
  assert.equal(r.projection.perRow[0].identityRecall5, 1);
  assert.equal(r.projection.perRow[0].projectedRecall5, 1);
  assert.equal(r.projection.undatedCandidatesScaled, 1);
  assert.equal(r.projection.datedCandidatesTouched, 0);
});

test('project: an actual top-5 eviction shows projectedRecall5 = 0 while identity stays 1', async () => {
  const filler = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, score: 0.5 - i * 0.01 }));
  const doSearch = async () => ({ _temporalWidened: true, results: [
    { id: 'id-gold', score: 0.51 }, ...filler,
  ] });
  const r = await recallPass({ ...baseArgs(doSearch), captureScores: true,
    project: { cohort: 'undated', factor: 0.5, writeIds: new Set(['id-gold']) } });
  // 0.51*0.5 = 0.255 sorts below all five fillers → out of top 5.
  assert.equal(r.projection.perRow[0].projectedRecall5, 0);
  assert.equal(r.projection.perRow[0].identityRecall5, 1);
});

test('requireTemporalWidened throws when the live result lacks the stamp', async () => {
  const doSearch = async () => ({ results: [{ id: 'id-gold', score: 0.8 }] }); // no stamp
  await assert.rejects(() => recallPass({ ...baseArgs(doSearch), requireTemporalWidened: true }),
    /w001.*_temporalWidened/);
});

test('now is threaded into ctx; absent now leaves ctx exactly { memory }', async () => {
  let ctx;
  const doSearch = async (q, k, full, x, c) => { ctx = c; return { results: [] }; };
  await recallPass({ ...baseArgs(doSearch), now: 123 });
  assert.equal(ctx.now, 123);
  await recallPass(baseArgs(doSearch));
  assert.deepEqual(Object.keys(ctx), ['memory']);
});

test('absent opts leave the return shape byte-identical (no projection key)', async () => {
  const doSearch = async () => ({ results: [{ id: 'id-gold', score: 0.8 }] });
  const r = await recallPass(baseArgs(doSearch));
  assert.ok(!('projection' in r));
});

// --- parseArgs: --window-arm / --decay (pure) -------------------------------

test('parseArgs: --window-arm sets the flag; --decay captures the raw value', () => {
  const a = parseArgs(['node', 'x', '--window-arm', '--decay', 'off']);
  assert.equal(a.windowArm, true);
  assert.equal(a.decay, 'off');
});

test('parseArgs: absent --window-arm leaves the flag falsy (default runs unaffected)', () => {
  assert.ok(!parseArgs(['node', 'x']).windowArm);
  assert.ok(!parseArgs(['node', 'x', '--recall', 'a.jsonl', '--gate', 'g.json']).windowArm);
});

// --- runWindowArm: offline stub-DI tests for the guards ---------------------
//
// Same stub-DI pattern the undated arm's own wiring tests use
// (mq-eval-undated-arm-wiring.test.mjs `fakes()`): every live dependency (umAdd, client,
// embed, doSearch) is a fake, so this runs with no qdrant, no embedder, no API key. Two
// window-arm rows — one gold (2 seed_facts), one dated (1 seed_fact) — are the smallest
// fixture that satisfies resolveWindowRows' F1/F2 AND assertDateCohorts' both-cohorts-
// non-empty rule.

const windowRows = () => [
  {
    id: 'w1', undated_gold: true, category: 'work', paraphrase_level: 'paraphrase',
    query: 'w1 standup update in the last 2 weeks', target_ref: 'w1:0',
    seed_facts: [
      { text: 'w1 gold fact', lane: 'work', days_ago: 3 },
      { text: 'w1 companion fact', lane: 'work', days_ago: 5 },
    ],
  },
  {
    id: 'w2', undated_gold: false, category: 'dev', paraphrase_level: 'oblique',
    query: 'w2 deploy pipeline change in the last 3 weeks', target_ref: 'w2:0',
    seed_facts: [{ text: 'w2 dated fact', lane: 'dev', days_ago: 5 }],
  },
];

/** `resultIdsMode: 'mismatched'` reproduces the wrong-id-space hazard: doSearch returns ids
 *  that never appear in ANY seed's write-id space, so a projection keyed correctly still
 *  scales nothing — exactly what guard (b) exists to catch. */
function windowFakes({ resultIdsMode = 'correct' } = {}) {
  const calls = [];
  const payloads = new Map();
  const refToId = new Map();
  let n = 0;

  const umAdd = async ({ metadata }) => {
    const id = `pt-${++n}`;
    refToId.set(metadata.eval_ref, id);
    payloads.set(id, { eval_ref: metadata.eval_ref, lane: metadata.lane, ...(metadata.valid_from !== undefined ? { valid_from: metadata.valid_from } : {}) });
    calls.push({ op: 'umAdd', ref: metadata.eval_ref, valid_from: metadata.valid_from });
    return { results: [{ id, event: 'ADD' }] };
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

  const embed = async () => ({ vector: [1, 0, 0], tokensIn: 1, tokensOut: 0, costUsd: 0 });
  const cosineStrict = () => 0.1;
  // Records the LIVE UM_TEMPORAL_DECAY the wrapper pinned, so the --decay off test can
  // assert doSearch actually observed 'false' rather than just trusting the return value.
  const doSearch = async (query) => {
    calls.push({ op: 'doSearch', query, decayEnv: process.env.UM_TEMPORAL_DECAY });
    if (resultIdsMode === 'mismatched') {
      return { _temporalWidened: true, results: [{ id: 'unrelated-1', score: 0.9 }, { id: 'unrelated-2', score: 0.1 }] };
    }
    const rowId = query.split(' ')[0];
    const target = refToId.get(`${rowId}:0`);
    if (resultIdsMode === 'unsorted-gold' && rowId === 'w1') {
      // Raw order ranks the gold target FIRST (index 0) — "observed" recall (recallPass's
      // recallAtK, which trusts doSearch's own order) sees it at rank 1, recall@5 = 1. But
      // its SCORE is the lowest of the six — the identity projection re-sorts by score
      // before checking rank, so it lands OUTSIDE the top 5, identityRecall5 = 0. This is
      // exactly the mechanism guard (a) exists to catch: a doSearch whose results are not
      // already score-sorted makes "observed" and "identity re-rank at factor 1" disagree
      // even though nothing was scaled.
      return { _temporalWidened: true, results: [
        { id: target, score: 0.1 },
        { id: 'f1', score: 0.9 }, { id: 'f2', score: 0.8 }, { id: 'f3', score: 0.7 },
        { id: 'f4', score: 0.6 }, { id: 'f5', score: 0.5 },
      ] };
    }
    return { _temporalWidened: true, results: [{ id: target, score: 0.9 }, { id: 'noise', score: 0.1 }] };
  };

  const generateDistractors = (count, { seed }) => Array.from({ length: count }, (_, i) => ({ text: `distractor ${seed}-${i}`, lane: 'work' }));
  const lanesFromRows = () => ['work', 'dev'];

  return { calls, payloads, refToId, umAdd, client, embed, cosineStrict, doSearch, generateDistractors, lanesFromRows, memory: {}, NOOP_METRICS: {} };
}

const runWindowArgs = (f, over = {}) => ({
  rows: windowRows(), collection: 'eval_mq_window_test', now: NOW,
  umAdd: f.umAdd, memory: f.memory, client: f.client, doSearch: f.doSearch,
  embed: f.embed, cosineStrict: f.cosineStrict, NOOP_METRICS: f.NOOP_METRICS,
  generateDistractors: f.generateDistractors, lanesFromRows: f.lanesFromRows,
  distractors: 3, distractorSeed: 1,
  ...over,
});

/** w1's `target_ref` uses '#' instead of ':' — matches nothing `windowArmCohorts` ever
 *  produces (its refs are always `${row.id}:${i}`). Reproduces the fully-null-measurement
 *  hazard: the row still seeds/strips/asserts fine (those key off eval_ref, not
 *  target_ref), but recallPass can never resolve a target for it, and the row never counts
 *  as "gold" in undatedArmMetrics either — so BOTH g2.value and identityG2W come back null. */
const windowRowsWithBadTargetRef = () => {
  const rows = windowRows();
  rows[0] = { ...rows[0], target_ref: 'w1#0' };
  return rows;
};

test('runWindowArm: guard (a) fires when observed recall (raw order) disagrees with the identity re-rank (score order)', async () => {
  const f = windowFakes({ resultIdsMode: 'unsorted-gold' });
  await assert.rejects(() => runWindowArm(runWindowArgs(f)), /GUARD \(a\)/);
});

test('runWindowArm: guard (a) fires on a fully null measurement (target_ref matches no goldRef)', async () => {
  const f = windowFakes();
  await assert.rejects(
    () => runWindowArm(runWindowArgs(f, { rows: windowRowsWithBadTargetRef() })),
    /GUARD \(a\).*unmeasured/,
  );
});

test('runWindowArm: guard (b) fires when the live result ids never fall in the gold write-id space', async () => {
  const f = windowFakes({ resultIdsMode: 'mismatched' });
  await assert.rejects(() => runWindowArm(runWindowArgs(f)), /GUARD \(b\)|undatedCandidatesScaled/);
});

test('runWindowArm: --decay off pins UM_TEMPORAL_DECAY=false for doSearch and still runs to completion', async () => {
  const f = windowFakes();
  const out = await runWindowArm(runWindowArgs(f, { decay: 'off' }));
  const searches = f.calls.filter((c) => c.op === 'doSearch');
  assert.ok(searches.length > 0, 'the run must actually search');
  for (const s of searches) assert.equal(s.decayEnv, 'false', 'doSearch must observe the pinned value, not just the return');
  assert.equal(out.arm, 'window');
  assert.equal(out.flags.UM_TEMPORAL_DECAY, 'false');
  assert.equal(out.flags.UM_TEMPORAL_QUERY, 'true');
  assert.equal(out.projection.evictedRefs.length, 0, 'the happy-path fixture has no eviction');
  assert.equal(process.env.UM_TEMPORAL_DECAY, undefined, 'the pin must not leak past the run');
  assert.equal(process.env.UM_TEMPORAL_QUERY, undefined, 'the pin must not leak past the run');
});

test('runWindowArm: the one-clock guard throws when `now` is not finite, before touching any dependency', async () => {
  const f = windowFakes();
  await assert.rejects(() => runWindowArm(runWindowArgs(f, { now: undefined })), /finite/);
  assert.equal(f.calls.length, 0, 'nothing should run before the guard');
});

// --- windowThresholds gate wiring (Task 6, plan Sec7.3 step 4) --------------
//
// Cheaper than a fresh `--window-arm --decay on --gate ... --seed 3` run: loads the REAL
// pinned config and the REAL committed run1 artifact (both in-repo, no keys needed) and
// proves `evaluateGate` actually bites in both directions over `windowThresholds` — a
// silent edit to the floor, the key, or the artifact path would go green instead of red.

const GATE_CONFIG_PATH = fileURLToPath(new URL('../eval/mq-gate-thresholds.json', import.meta.url));
const gateConfig = JSON.parse(await readFile(GATE_CONFIG_PATH, 'utf8'));

const RUN1_PATH = fileURLToPath(new URL('../eval/results/2026-08-12-window-arm-run1.json', import.meta.url));
const windowRun1 = JSON.parse(await readFile(RUN1_PATH, 'utf8'));

test('windowThresholds: present, exactly the pinned roster', () => {
  assert.ok(Array.isArray(gateConfig.windowThresholds), 'windowThresholds key must exist');
  assert.deepEqual(
    gateConfig.windowThresholds.map((t) => t.metric).sort(),
    ['windowG2Recall@5', 'windowGoldRows'],
  );
});

test('evaluateGate over windowThresholds: a below-floor synthetic result FAILS the gate', () => {
  const belowFloorValue = evaluateGate({ g2: { value: 0.90, rows: 24 } }, { thresholds: gateConfig.windowThresholds });
  assert.equal(belowFloorValue.pass, false, 'g2.value 0.90 is below the 0.938 floor');
  assert.equal(belowFloorValue.breaches[0].reason, 'below_floor');

  const shrunkRows = evaluateGate({ g2: { value: 1.0, rows: 23 } }, { thresholds: gateConfig.windowThresholds });
  assert.equal(shrunkRows.pass, false, 'g2.rows 23 breaches the denominator floor, never silently re-scales');
});

test('evaluateGate over windowThresholds: the committed run1 artifact PASSES the pinned floor', () => {
  const gate = evaluateGate(windowRun1, { thresholds: gateConfig.windowThresholds });
  assert.equal(gate.pass, true, 'run1 (g2.value 1.000, g2.rows 24) must clear the 0.938 / 24 floors');
  assert.deepEqual(gate.breaches, []);
});
