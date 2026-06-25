// server/test/corpus-distractors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanesFromRows } from '../eval/lib/corpus-distractors.mjs';

test('lanesFromRows: distinct lanes from seed_facts, in first-seen order', () => {
  const rows = [
    { seed_facts: [{ text: 'a', lane: 'home' }] },
    { seed_facts: [{ text: 'b', lane: 'dev' }] },
    { seed_facts: [{ text: 'c', lane: 'home' }] },
  ];
  assert.deepEqual(lanesFromRows(rows), ['home', 'dev']);
});

test('lanesFromRows: handles multi-fact rows + missing lane (skipped), empty → []', () => {
  const rows = [
    { seed_facts: [{ text: 'a', lane: 'work' }, { text: 'b', lane: 'food' }] },
    { seed_facts: [{ text: 'c' }] }, // no lane → skipped
  ];
  assert.deepEqual(lanesFromRows(rows), ['work', 'food']);
  assert.deepEqual(lanesFromRows([]), []);
  assert.deepEqual(lanesFromRows(null), []);
});

// append to server/test/corpus-distractors.test.mjs
import { generateDistractors } from '../eval/lib/corpus-distractors.mjs';

const LANES = ['home', 'dev', 'finance']; // lanes with templates in this task's worked set

test('generateDistractors: exact count, every entry in the requested lanes', () => {
  const out = generateDistractors(12, { seed: 0, lanes: LANES });
  assert.equal(out.length, 12);
  for (const d of out) {
    assert.ok(LANES.includes(d.lane), `lane ${d.lane} not in requested set`);
    assert.equal(typeof d.text, 'string');
    assert.ok(d.text.length > 0);
  }
});

test('generateDistractors: count 0 → [], unknown lane skipped, no usable lane → throws', () => {
  assert.deepEqual(generateDistractors(0, { lanes: LANES }), []);
  assert.equal(generateDistractors(6, { lanes: ['home', 'NOPE'] }).every((d) => d.lane === 'home'), true);
  assert.throws(() => generateDistractors(3, { lanes: ['NOPE'] }), /no templates/);
  assert.throws(() => generateDistractors(3, { lanes: [] }), /lanes required/);
});

test('generateDistractors: deterministic (same seed → deepEqual) + seed-sensitive', () => {
  assert.deepEqual(generateDistractors(20, { seed: 7, lanes: LANES }), generateDistractors(20, { seed: 7, lanes: LANES }));
  assert.notDeepEqual(generateDistractors(20, { seed: 7, lanes: LANES }), generateDistractors(20, { seed: 8, lanes: LANES }));
});

test('generateDistractors: monotonic prefix — generate(m) ⊂ generate(m+k) for a fixed seed', () => {
  const small = generateDistractors(9, { seed: 3, lanes: LANES });
  const big = generateDistractors(30, { seed: 3, lanes: LANES });
  assert.deepEqual(big.slice(0, 9), small);
});

test('generateDistractors: lane-balanced round-robin', () => {
  const out = generateDistractors(30, { seed: 0, lanes: LANES });
  const counts = LANES.map((l) => out.filter((d) => d.lane === l).length);
  for (const c of counts) assert.equal(c, 10); // 30 / 3 lanes
});

test('generateDistractors: variety — no two identical texts across a moderate draw', () => {
  const out = generateDistractors(60, { seed: 1, lanes: LANES });
  const texts = new Set(out.map((d) => d.text));
  assert.equal(texts.size, out.length, 'generated texts must be distinct (low dedup risk)');
});

test('generateDistractors: each lane spans >= 3 structurally-distinct templates', () => {
  // first sentence "shape" proxy: text with digits/specific slots stripped is the template skeleton.
  const out = generateDistractors(90, { seed: 0, lanes: LANES });
  for (const lane of LANES) {
    const shapes = new Set(out.filter((d) => d.lane === lane).map((d) => d.text.replace(/[0-9$]+/g, '#')));
    assert.ok(shapes.size >= 3, `lane ${lane} must use >=3 distinct templates, saw ${shapes.size}`);
  }
});
