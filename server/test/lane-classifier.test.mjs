// server/test/lane-classifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
// cosineSimilarity lives in ./vector.mjs (rule-of-three extraction); its unit
// tests live in test/vector.test.mjs. classifyByPrototypes (below) exercises
// cosineSimilarity transitively via the top-K-mean scorer.
import { classifyByPrototypes, loadLaneTaxonomy, buildLanePrototypes, classifyLane, classifierEnabled, _resetPrototypesForTest, LANE_THRESHOLD_DEFAULT, LANE_MARGIN_DEFAULT, LANE_TOPK_DEFAULT } from '../lib/lane-classifier.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Lane prototypes: each lane carries its exemplar VECTORS (not a mean centroid).
const LANE_PROTOS = [
  { slug: 'work', vectors: [[1, 0]] },
  { slug: 'personal', vectors: [[0, 1]] },
];

test('classifyByPrototypes: argmax above threshold returns that lane', () => {
  const r = classifyByPrototypes([0.9, 0.1], LANE_PROTOS, { threshold: 0.5 });
  assert.equal(r.lane, 'work');
  assert.ok(r.score > 0.5);
});

test('classifyByPrototypes: below threshold returns null (omit)', () => {
  const r = classifyByPrototypes([1, 1], LANE_PROTOS, { threshold: 0.95 });
  assert.equal(r.lane, null); // 45° → cos ≈ 0.707 < 0.95
});

test('classifyByPrototypes: ambiguity margin → null when top1-top2 < margin', () => {
  const r = classifyByPrototypes([1, 1], LANE_PROTOS, { threshold: 0.5, margin: 0.2 });
  assert.equal(r.lane, null); // both ≈0.707, margin 0 < 0.2
});

test('classifyByPrototypes: empty taxonomy returns null', () => {
  assert.equal(classifyByPrototypes([1, 0], [], { threshold: 0.5 }).lane, null);
});

// --- multi-prototype top-K-mean mechanism (Gap-5 2026-06-07) ----------------
// The classifier scores a lane by the MEAN of its top-K nearest exemplar cosines,
// so a multi-modal lane is matched by the relevant exemplar, not a washed-out mean.
const MULTI = [
  { slug: 'work', vectors: [[1, 0], [0.8, 0.6]] }, // two work "modes"
  { slug: 'home', vectors: [[0, 1]] },
];

test('classifyByPrototypes: topK=1 scores by the NEAREST exemplar (max cosine)', () => {
  // [1,0] matches work exemplar #1 exactly (cos 1.0); exemplar #2 cos 0.8; home 0.
  const r = classifyByPrototypes([1, 0], MULTI, { threshold: 0.5, topK: 1 });
  assert.equal(r.lane, 'work');
  assert.ok(Math.abs(r.score - 1.0) < 1e-9, 'topK=1 = nearest-exemplar (max)');
});

test('classifyByPrototypes: topK=2 averages the top-2 exemplar cosines', () => {
  // work top-2 = mean(1.0, 0.8) = 0.9; home = 0.
  const r = classifyByPrototypes([1, 0], MULTI, { threshold: 0.5, topK: 2 });
  assert.equal(r.lane, 'work');
  assert.ok(Math.abs(r.score - 0.9) < 1e-9, 'topK=2 = mean of the top-2 cosines');
});

test('classifyByPrototypes: topK clamps to the lane exemplar count', () => {
  // work has 2 exemplars; topK=5 uses both → identical to topK=2 (0.9).
  const r = classifyByPrototypes([1, 0], MULTI, { threshold: 0.5, topK: 5 });
  assert.ok(Math.abs(r.score - 0.9) < 1e-9, 'topK > exemplar count clamps to the count');
});

test('classifyByPrototypes: a fact near ONE peripheral exemplar still routes (multi-modal capture)', () => {
  // [0.8,0.6] IS work mode #2 (cos 1.0) but only 0.8 to mode #1 — a single mean-pooled
  // centroid would dilute it; nearest-exemplar (topK=1) captures it.
  const r = classifyByPrototypes([0.8, 0.6], MULTI, { threshold: 0.7, topK: 1 });
  assert.equal(r.lane, 'work');
  assert.ok(r.score > 0.99);
});

test('loadLaneTaxonomy: reads {lanes:[{slug,exemplars}]} from UM_LANE_TAXONOMY_PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanetax-'));
  const p = join(dir, 'tax.json');
  writeFileSync(p, JSON.stringify({ lanes: [{ slug: 'work', exemplars: ['sprint planning', 'PR review'] }] }));
  try {
    const tax = loadLaneTaxonomy({ UM_LANE_TAXONOMY_PATH: p });
    assert.equal(tax.length, 1);
    assert.equal(tax[0].slug, 'work');
    assert.equal(tax[0].exemplars.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// NOTE (plan correction): loadLaneTaxonomy({}) would resolve the BUNDLED default file (4 lanes),
// so to assert "empty" we must pass an explicit nonexistent path.
test('loadLaneTaxonomy: nonexistent path → empty (classifier inert)', () => {
  assert.deepEqual(loadLaneTaxonomy({ UM_LANE_TAXONOMY_PATH: '/nonexistent/lane-tax-does-not-exist.json' }), []);
});

test('loadLaneTaxonomy: lane with no exemplars is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanetax-'));
  const p = join(dir, 'tax.json');
  writeFileSync(p, JSON.stringify({ lanes: [{ slug: 'empty', exemplars: [] }] }));
  try { assert.deepEqual(loadLaneTaxonomy({ UM_LANE_TAXONOMY_PATH: p }), []); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

// NOTE (plan correction): validateLanePersonaSlug puts INPUT_INVALID on err.code, and its MESSAGE
// is "metadata.lane must match <regex>" (no "invalid" substring) — a message-regex would NOT match.
// Assert on the real contract: err.code === 'INPUT_INVALID'.
test('loadLaneTaxonomy: invalid slug throws INPUT_INVALID (no silent skip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanetax-'));
  const p = join(dir, 'tax.json');
  writeFileSync(p, JSON.stringify({ lanes: [{ slug: '../evil', exemplars: ['x'] }] }));
  try {
    assert.throws(
      () => loadLaneTaxonomy({ UM_LANE_TAXONOMY_PATH: p }),
      (err) => err && err.code === 'INPUT_INVALID',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildLanePrototypes: embeds each exemplar via injected embedFn, retains per-lane vectors', async () => {
  // Deterministic stub embedder: maps text → vector (no network).
  const embedStub = async (t) => ({ vector: t.includes('work') ? [1, 0] : [0, 1] });
  const taxonomy = [
    { slug: 'work', exemplars: ['work a', 'work b'] },
    { slug: 'home', exemplars: ['home a'] },
  ];
  const protos = await buildLanePrototypes(taxonomy, embedStub);
  assert.equal(protos.length, 2);
  assert.deepEqual(protos.find((c) => c.slug === 'work').vectors, [[1, 0], [1, 0]]);
  assert.deepEqual(protos.find((c) => c.slug === 'home').vectors, [[0, 1]]);
});

const TAX = [{ slug: 'work', exemplars: ['work a'] }, { slug: 'home', exemplars: ['home a'] }];
const embedStub = async (t) => ({ vector: t.includes('work') ? [1, 0] : [0, 1] });

test('classifyLane: routes above threshold (reuses provided vector, no embed of the fact)', async () => {
  _resetPrototypesForTest();
  const r = await classifyLane([1, 0], { _taxonomy: TAX, _embedFn: embedStub, threshold: 0.5 });
  assert.equal(r.lane, 'work');
});

test('classifyLane: omits below threshold', async () => {
  _resetPrototypesForTest();
  const r = await classifyLane([1, 1], { _taxonomy: TAX, _embedFn: embedStub, threshold: 0.95 });
  assert.equal(r.lane, null);
});

test('classifyLane: fail-safe — internal throw returns {lane:null}, never rejects', async () => {
  _resetPrototypesForTest();
  const boom = async () => { throw new Error('embed down'); };
  const r = await classifyLane([1, 0], { _taxonomy: TAX, _embedFn: boom, threshold: 0.5 });
  assert.equal(r.lane, null); // did not throw
});

// Fail-safe robustness: a transient build failure must NOT be permanently cached.
test('classifyLane: a transient build failure is NOT cached — a later call retries the build', async () => {
  _resetPrototypesForTest();
  let calls = 0;
  const flaky = async (t) => {
    calls += 1;
    if (calls === 1) throw new Error('embed down'); // first exemplar embed fails the first build
    return { vector: t.includes('work') ? [1, 0] : [0, 1] };
  };
  const r1 = await classifyLane([1, 0], { _taxonomy: TAX, _embedFn: flaky, threshold: 0.5 });
  assert.equal(r1.lane, null); // first build failed → fail-safe omit
  const r2 = await classifyLane([1, 0], { _taxonomy: TAX, _embedFn: flaky, threshold: 0.5 });
  assert.equal(r2.lane, 'work'); // rejection not cached → rebuild succeeded
});

test('classifierEnabled: only strict "true" enables (opt-in, whitespace-trim)', () => {
  assert.equal(classifierEnabled({ UM_LANE_CLASSIFIER_ENABLED: 'true' }), true);
  assert.equal(classifierEnabled({ UM_LANE_CLASSIFIER_ENABLED: ' true ' }), true);
  assert.equal(classifierEnabled({ UM_LANE_CLASSIFIER_ENABLED: 'false' }), false);
  assert.equal(classifierEnabled({}), false);
  assert.equal(classifierEnabled({ UM_LANE_CLASSIFIER_ENABLED: '1' }), false);
  assert.equal(classifierEnabled({ UM_LANE_CLASSIFIER_ENABLED: 'TRUE' }), false);
});

test('loadLaneTaxonomy: non-array lanes → empty (fail-safe, not a throw)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lanetax-'));
  const p = join(dir, 'tax.json');
  writeFileSync(p, JSON.stringify({ lanes: 'work' }));
  try { assert.deepEqual(loadLaneTaxonomy({ UM_LANE_TAXONOMY_PATH: p }), []); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

// Gap-5 drift gate — the eval-pinned multi-prototype defaults (re-pinned 2026-06-07).
test('Gap-5 drift gate: eval-pinned defaults τ_lane=0.30 + margin=0.08 + topK=3', async () => {
  // LITERAL match to LANE_THRESHOLD_DEFAULT / LANE_MARGIN_DEFAULT / LANE_TOPK_DEFAULT in
  // lib/lane-classifier.mjs and server/.env.example UM_LANE_CLASSIFIER_THRESHOLD/_MARGIN/_TOPK
  // — update all three together. Pinned by the 2026-06-07 grown-fixture eval: top-3-mean
  // multi-prototype scored precision 0.977 / recall 0.875 ≥ the 0.95 floor on the
  // representative fixture (eval/results/2026-06-07-lane-run{1,2}.json), beating the
  // superseded P2 single-centroid pin (0.30/0.06, which fell to 0.479 recall on the grown set).
  assert.equal(LANE_THRESHOLD_DEFAULT, 0.30);
  assert.equal(LANE_MARGIN_DEFAULT, 0.08);
  assert.equal(LANE_TOPK_DEFAULT, 3);

  // Behavioral: with the threshold/margin env UNSET, classifyLane applies the pinned
  // NON-ZERO margin — a top1≈top2 tie (margin 0) is omitted, not routed.
  const prevT = process.env.UM_LANE_CLASSIFIER_THRESHOLD;
  const prevM = process.env.UM_LANE_CLASSIFIER_MARGIN;
  delete process.env.UM_LANE_CLASSIFIER_THRESHOLD;
  delete process.env.UM_LANE_CLASSIFIER_MARGIN;
  try {
    _resetPrototypesForTest();
    const protos = [{ slug: 'a', vectors: [[1, 0]] }, { slug: 'b', vectors: [[0, 1]] }];
    // [1,1] → cos 0.707 to both → margin 0 < 0.08 default → abstain.
    const tie = await classifyLane([1, 1], { _prototypes: protos });
    assert.equal(tie.lane, null, 'pinned margin (0.08) omits a top1/top2 tie');
    // [1,0.2] → cos≈0.98 to a, ≈0.20 to b → margin ≫ 0.08, top1 ≥ τ=0.30 → routes a.
    const clear = await classifyLane([1, 0.2], { _prototypes: protos });
    assert.equal(clear.lane, 'a', 'clear winner above τ with margin ≥ 0.08 routes');
  } finally {
    if (prevT === undefined) delete process.env.UM_LANE_CLASSIFIER_THRESHOLD; else process.env.UM_LANE_CLASSIFIER_THRESHOLD = prevT;
    if (prevM === undefined) delete process.env.UM_LANE_CLASSIFIER_MARGIN; else process.env.UM_LANE_CLASSIFIER_MARGIN = prevM;
    _resetPrototypesForTest();
  }
});
