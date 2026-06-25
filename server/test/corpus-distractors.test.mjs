// server/test/corpus-distractors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lanesFromRows, generateDistractors } from '../eval/lib/corpus-distractors.mjs';

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

test('generateDistractors: every fixture lane is templated (>=3 shapes) + corpus reaches >=1000 distinct', () => {
  const raw = readFileSync(new URL('../eval/recall-set.jsonl', import.meta.url), 'utf8');
  const rows = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const lanes = lanesFromRows(rows); // all 10 fixture lanes
  const big = generateDistractors(3000, { seed: 0, lanes });
  for (const lane of lanes) {
    const inLane = big.filter((d) => d.lane === lane);
    assert.ok(inLane.length > 0, `lane ${lane} produced no distractors (missing templates)`);
    const shapes = new Set(inLane.map((d) => d.text.replace(/[0-9$]+/g, '#')));
    assert.ok(shapes.size >= 3, `lane ${lane} must use >=3 templates, saw ${shapes.size}`);
  }
  const distinct = new Set(big.map((d) => d.text));
  assert.ok(distinct.size >= 1000, `expected >=1000 distinct distractors across 10 lanes, saw ${distinct.size}`);
});

test('generateDistractors: no generated text contains a recall-set target answer span', () => {
  const raw = readFileSync(new URL('../eval/recall-set.jsonl', import.meta.url), 'utf8');
  const rows = raw.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const lanes = lanesFromRows(rows);
  // distinctive answer spans = the target seed_facts' salient tokens (numbers, capitalized words, quoted spans)
  const spans = [];
  for (const r of rows) for (const f of r.seed_facts ?? []) {
    for (const m of (f.text.match(/\b\d{1,4}(?:am|pm)?\b|\b[A-Z][a-zA-Z]{3,}\b/g) ?? [])) spans.push(m.toLowerCase());
  }
  const distractors = generateDistractors(2000, { seed: 0, lanes });
  for (const d of distractors) {
    const t = d.text.toLowerCase();
    for (const span of spans) {
      assert.ok(!t.includes(span), `distractor "${d.text}" contains target span "${span}"`);
    }
  }
});
