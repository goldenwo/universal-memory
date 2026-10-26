// server/test/answer-grader-eval.test.mjs — pins the Layer-1 reliability eval pure-fns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, sweepThresholds, PRECISION_FLOOR, TAU_ANSWER, parseArgs, cliError, runGrader } from '../eval/answer-grader-eval.mjs';

const judged = [
  { gold: true,  answers: true,  confidence: 0.9,  ok: true },  // tp at τ≤0.9
  { gold: true,  answers: true,  confidence: 0.6,  ok: true },  // tp at τ≤0.6 else fn
  { gold: false, answers: true,  confidence: 0.95, ok: true },  // fp (hard negative the judge got wrong)
  { gold: false, answers: false, confidence: 0.1,  ok: true },  // tn
  { gold: true,  answers: false, confidence: 0,    ok: false }, // parse-fail → excluded
];

test('computeMetrics: excludes parse-fails and computes precision/recall at τ', () => {
  const m = computeMetrics(judged, 0.8);
  // at τ=0.8: row0 tp, row1 fn (0.6<0.8), row2 fp, row3 tn; row4 excluded
  assert.deepEqual({ tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn }, { tp: 1, fp: 1, fn: 1, tn: 1 });
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.equal(m.graded, 4); // parse-fail excluded
});

test('sweepThresholds: one row per threshold', () => {
  const rows = sweepThresholds({ judged, thresholds: [0.6, 0.8, 0.95] });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].tau, 0.6);
});

test('PRECISION_FLOOR is the single pinned constant 0.90', () => {
  assert.equal(PRECISION_FLOOR, 0.90);
});

test('TAU_ANSWER drift gate: pinned at 0.05 (2 live gpt-4o-mini runs; re-run the eval to change)', () => {
  assert.equal(TAU_ANSWER, 0.05);
});

// --- model migration Phase B (spec R2, plan T2): --runs, a required --out and model, per-call records ---

test('parseArgs: --fixture, --out and --runs (default 1)', () => {
  assert.deepEqual(parseArgs(['node', 'x', '--fixture', 'f', '--out', 'o.json']), { fixture: 'f', out: 'o.json', runs: 1 });
  assert.equal(parseArgs(['node', 'x', '--runs', '3']).runs, 3);
});

test('cliError: --fixture, --out and UM_ANSWER_GRADER_MODEL are all required — no silent default model', () => {
  const ok = { fixture: 'f', out: 'o.json', runs: 1 };
  assert.equal(cliError(ok, { UM_ANSWER_GRADER_MODEL: 'gpt-6-luna' }), null);
  assert.match(cliError(ok, {}), /UM_ANSWER_GRADER_MODEL/);
  assert.match(cliError({ ...ok, out: undefined }, { UM_ANSWER_GRADER_MODEL: 'm' }), /--out/);
  assert.match(cliError({ ...ok, fixture: undefined }, { UM_ANSWER_GRADER_MODEL: 'm' }), /--fixture/);
});

test('runGrader: per run, one record per triple with the verdict, ok/failCause, the R1 fields and latency', async () => {
  const rows = [{ id: 'r1', query: 'q1', memory: 'm1', gold: true, category: 'answerable' }, { id: 'r2', query: 'q2', memory: 'm2', gold: false, category: 'unanswerable' }];
  const seen = [];
  const grade = async (q, m, opts) => {
    seen.push(opts.model);
    return q === 'q1'
      ? { answers: true, confidence: 0.9, ok: true, requestParams: { model: opts.model }, servedModel: opts.model, systemFingerprint: null, reasoningTokens: 0, stopReason: 'stop' }
      : { answers: false, confidence: 0, ok: false, failCause: 'invoke-error' };
  };
  const runs = await runGrader({ rows, grade, model: 'gpt-6-luna', runs: 2 });
  assert.equal(runs.length, 2);
  assert.deepEqual(seen, ['gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna', 'gpt-6-luna'], 'the model is passed explicitly on every call');
  const [a, b] = runs[0].judged;
  assert.deepEqual([a.id, a.gold, a.answers, a.confidence, a.ok, a.servedModel, a.stopReason], ['r1', true, true, 0.9, true, 'gpt-6-luna', 'stop']);
  assert.equal(typeof a.ms, 'number');
  assert.deepEqual([b.ok, b.failCause, 'requestParams' in b], [false, 'invoke-error', false]);
  assert.equal(runs[0].sweep.length, 19, 'grid 0.05..0.95');
  assert.equal(runs[0].parseFails, 1);
});
