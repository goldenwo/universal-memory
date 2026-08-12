import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowRows, WINDOW_ARM_ALLOWED_KINDS } from '../eval/lib/window-arm-fixture.mjs';
import { parseTemporalWindow } from '../lib/temporal-query.mjs';
import { recallPass } from '../eval/memory-quality-eval.mjs';

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
