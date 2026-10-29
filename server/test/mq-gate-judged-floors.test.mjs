/**
 * mq-gate-judged-floors.test.mjs — the four judge-read mq floors (model migration Phase B, T5).
 *
 * The answerCorrectness, noAnswerPrecision, fireRate and staleReturnRate floors in
 * mq-gate-thresholds.json read an LLM judge, so moving the judge and grader to gpt-6-luna
 * re-pinned them. T5 ran 7 observations under the verdict (committed 894dcec as
 * eval/results/2026-10-27-phaseb-mq-{1..7}.json), and the pre-registered recipe
 * (Phase B prereg, "mq floors") sets each floor to the minimum over the 7 minus that floor's
 * original margin, rounded down to 3 dp; staleReturnRate stays a max of 0. This test
 * recomputes the recipe from the committed observations, so a floor cannot move without its
 * evidence moving too, and checks that each new minimum is non-inferior to the old floor.
 *
 * Run with: node --test server/test/mq-gate-judged-floors.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = fileURLToPath(new URL('../eval/mq-gate-thresholds.json', import.meta.url));
const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const OBSERVATIONS = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(async (i) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../eval/results/2026-10-27-phaseb-mq-${i}.json`, import.meta.url)), 'utf8'))));

// The registered recipe: margin per floor, and the pre-Phase-B floor it must not fall below.
const RECIPE = [
  { metric: 'answerCorrectness', path: ['answerCorrectness', 'rate'], margin: 0.06, oldFloor: 0.78 },
  { metric: 'noAnswerPrecision', path: ['noAnswer', 'precision'], margin: 1.5 / 30, oldFloor: 0.95 },
  { metric: 'fireRate', path: ['staleness', 'fireRate'], margin: 0.2, oldFloor: 0.80 },
];
const floor3 = (x) => Math.floor(x * 1000 + 1e-9) / 1000;
const at = (obj, path) => path.reduce((o, k) => o?.[k], obj);
const threshold = (metric) => config.thresholds.find((t) => t.metric === metric);

test('the 7 observations ran under the verdict: gpt-6-luna judge at τ* 0.85, gpt-6-luna grader at τ_answer 0.05', () => {
  assert.equal(OBSERVATIONS.length, 7);
  for (const o of OBSERVATIONS) {
    assert.deepEqual(o.judges, { tauAnswer: 0.05, autosupersedeThreshold: 0.85, contradictionModel: 'gpt-6-luna', answerGraderModel: 'gpt-6-luna' });
  }
});

for (const r of RECIPE) {
  test(`${r.metric}: floor = floor3(min over the 7 − ${r.margin.toFixed(3)}), non-inferior to the old ${r.oldFloor}`, () => {
    const min = Math.min(...OBSERVATIONS.map((o) => at(o, r.path)));
    assert.ok(min >= r.oldFloor, `observed min ${min} must clear the old floor ${r.oldFloor}`);
    const t = threshold(r.metric);
    assert.deepEqual(t.path, r.path);
    assert.equal(t.direction, 'min');
    assert.equal(t.floor, floor3(min - r.margin));
  });
}

test('the recipe lands on the reported floors: answerCorrectness 0.841, noAnswerPrecision 0.95, fireRate 0.744', () => {
  assert.equal(threshold('answerCorrectness').floor, 0.841);
  assert.equal(threshold('noAnswerPrecision').floor, 0.95);
  assert.equal(threshold('fireRate').floor, 0.744);
});

test('staleReturnRate: 0 in all 7, and its max-floor stays 0', () => {
  for (const o of OBSERVATIONS) assert.equal(o.staleness.staleReturnRate, 0);
  const t = threshold('staleReturnRate');
  assert.equal(t.direction, 'max');
  assert.equal(t.floor, 0);
});

test('pinnedFrom names the Phase B record and its recipe', () => {
  const entry = config.pinnedFrom.find((p) => p.includes('2026-10-27-phaseb-mq-'));
  assert.ok(entry, 'a pinnedFrom entry for the Phase B observations');
  for (const needle of ['894dcec', 'gpt-6-luna', '0.85', '0.05', 'minus', '0.841', '0.744']) {
    assert.ok(entry.includes(needle), `pinnedFrom entry mentions ${needle}`);
  }
});
