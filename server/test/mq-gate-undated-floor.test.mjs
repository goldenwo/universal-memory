/**
 * mq-gate-undated-floor.test.mjs — the undated-arm subset floor (plan Task 7.3).
 *
 * Pins the `undatedThresholds` key in mq-gate-thresholds.json: its derivation, its
 * shape against the arm artifact, and that evaluateGate over it actually bites in
 * both directions. The floor's provenance lives in the file's own _undatedComment
 * and issue #239; this test makes a silent edit to either side (floor moved, key
 * renamed, path drifted from the artifact shape) go red instead of green.
 *
 * Run with: node --test server/test/mq-gate-undated-floor.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { evaluateGate } from '../eval/memory-quality-eval.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../eval/mq-gate-thresholds.json', import.meta.url));
const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

// The before-arm's pinned inputs (2026-08-07-undated-arm-run{1,2}.json, committed):
// G2 = 1.000 in both runs, over the 24-row undated-gold subset.
const OBSERVED_MIN = 1.0;
const ARM_SIZE = 24;

test('undatedThresholds: present, exactly the pinned roster', () => {
  assert.ok(Array.isArray(config.undatedThresholds), 'undatedThresholds key must exist');
  assert.deepEqual(
    config.undatedThresholds.map((t) => t.metric).sort(),
    ['undatedG2Recall@5', 'undatedGoldRows'],
  );
});

test('undatedThresholds: G2 floor follows the pre-registered recipe exactly', () => {
  // round3(observed_min - 1.5/N) — the extractionThresholds recipe form, mandated by
  // the plan for the zero-dispersion case. Recomputed here from the pinned inputs so
  // the floor cannot move without this line (and the provenance comment) moving too.
  const expected = Math.round((OBSERVED_MIN - 1.5 / ARM_SIZE) * 1000) / 1000;
  const g2 = config.undatedThresholds.find((t) => t.metric === 'undatedG2Recall@5');
  assert.equal(g2.floor, expected);
  assert.equal(g2.floor, 0.938);
  assert.deepEqual(g2.path, ['g2', 'value'], 'path must match the arm artifact shape');
  assert.equal(g2.direction, 'min');
});

test('undatedThresholds: the rows floor pins the denominator at authoring size', () => {
  const rows = config.undatedThresholds.find((t) => t.metric === 'undatedGoldRows');
  assert.equal(rows.floor, ARM_SIZE);
  assert.deepEqual(rows.path, ['g2', 'rows']);
  assert.equal(rows.direction, 'min');
});

test('evaluateGate over undatedThresholds: passes a clean arm, tolerates ONE eviction', () => {
  const gate = (g2) => evaluateGate({ g2 }, { thresholds: config.undatedThresholds });
  assert.equal(gate({ value: 1.0, rows: 24 }).pass, true, 'the expected after-arm must pass');
  assert.equal(gate({ value: 23 / 24, rows: 24 }).pass, true, 'one eviction (0.958) is inside the margin');
});

test('evaluateGate over undatedThresholds: breaches at two evictions, a shrunken arm, and an unmeasured G2', () => {
  const gate = (result) => evaluateGate(result, { thresholds: config.undatedThresholds });
  const two = gate({ g2: { value: 22 / 24, rows: 24 } });
  assert.equal(two.pass, false, 'two evictions (0.917) must breach');
  assert.equal(two.breaches[0].reason, 'below_floor');

  const shrunk = gate({ g2: { value: 1.0, rows: 23 } });
  assert.equal(shrunk.pass, false, 'a shrunken denominator must breach, not re-scale');

  const missing = gate({});
  assert.equal(missing.pass, false);
  assert.ok(missing.breaches.every((b) => b.reason === 'unmeasured'), 'absent metrics are unmeasured breaches, never silent passes');
});

test('isolation: the nightly `thresholds` block never gates arm keys', () => {
  // The nightly reads `thresholds` and must not see the arm floor (a g2 path there
  // would breach every night as unmeasured — the exact failure the separate key avoids).
  assert.ok(
    config.thresholds.every((t) => t.path[0] !== 'g2'),
    'no shared-threshold path may reach into the arm artifact',
  );
});
