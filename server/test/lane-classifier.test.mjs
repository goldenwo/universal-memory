// server/test/lane-classifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
// cosineSimilarity + meanPool moved to ./vector.mjs (rule-of-three extraction);
// their unit tests live in test/vector.test.mjs. classifyByCentroid (below)
// exercises cosineSimilarity transitively.
import { classifyByCentroid, loadLaneTaxonomy, buildCentroids, classifyLane, classifierEnabled, _resetCentroidsForTest, LANE_THRESHOLD_DEFAULT, LANE_MARGIN_DEFAULT } from '../lib/lane-classifier.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CENTROIDS = [
  { slug: 'work', centroid: [1, 0] },
  { slug: 'personal', centroid: [0, 1] },
];

test('classifyByCentroid: argmax above threshold returns that lane', () => {
  const r = classifyByCentroid([0.9, 0.1], CENTROIDS, { threshold: 0.5 });
  assert.equal(r.lane, 'work');
  assert.ok(r.score > 0.5);
});

test('classifyByCentroid: below threshold returns null (omit)', () => {
  const r = classifyByCentroid([1, 1], CENTROIDS, { threshold: 0.95 });
  assert.equal(r.lane, null); // 45° → cos ≈ 0.707 < 0.95
});

test('classifyByCentroid: ambiguity margin → null when top1-top2 < margin', () => {
  const r = classifyByCentroid([1, 1], CENTROIDS, { threshold: 0.5, margin: 0.2 });
  assert.equal(r.lane, null); // both ≈0.707, margin 0 < 0.2
});

test('classifyByCentroid: empty taxonomy returns null', () => {
  assert.equal(classifyByCentroid([1, 0], [], { threshold: 0.5 }).lane, null);
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

test('buildCentroids: embeds each exemplar via injected embedFn, mean-pools per lane', async () => {
  // Deterministic stub embedder: maps text → vector (no network).
  const embedStub = async (t) => ({ vector: t.includes('work') ? [1, 0] : [0, 1] });
  const taxonomy = [
    { slug: 'work', exemplars: ['work a', 'work b'] },
    { slug: 'home', exemplars: ['home a'] },
  ];
  const centroids = await buildCentroids(taxonomy, embedStub);
  assert.equal(centroids.length, 2);
  assert.deepEqual(centroids.find((c) => c.slug === 'work').centroid, [1, 0]);
  assert.deepEqual(centroids.find((c) => c.slug === 'home').centroid, [0, 1]);
});

const TAX = [{ slug: 'work', exemplars: ['work a'] }, { slug: 'home', exemplars: ['home a'] }];
const embedStub = async (t) => ({ vector: t.includes('work') ? [1, 0] : [0, 1] });

test('classifyLane: routes above threshold (reuses provided vector, no embed of the fact)', async () => {
  _resetCentroidsForTest();
  const r = await classifyLane([1, 0], { _taxonomy: TAX, _embedFn: embedStub, threshold: 0.5 });
  assert.equal(r.lane, 'work');
});

test('classifyLane: omits below threshold', async () => {
  _resetCentroidsForTest();
  const r = await classifyLane([1, 1], { _taxonomy: TAX, _embedFn: embedStub, threshold: 0.95 });
  assert.equal(r.lane, null);
});

test('classifyLane: fail-safe — internal throw returns {lane:null}, never rejects', async () => {
  _resetCentroidsForTest();
  const boom = async () => { throw new Error('embed down'); };
  const r = await classifyLane([1, 0], { _taxonomy: TAX, _embedFn: boom, threshold: 0.5 });
  assert.equal(r.lane, null); // did not throw
});

// Fail-safe robustness: a transient build failure must NOT be permanently cached.
test('classifyLane: a transient build failure is NOT cached — a later call retries the build', async () => {
  _resetCentroidsForTest();
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

// Gap-5 P2 drift gate — the eval-pinned threshold + margin defaults.
test('Gap-5 P2 drift gate: eval-pinned defaults τ_lane=0.30 + margin=0.06', async () => {
  // LITERAL match to LANE_THRESHOLD_DEFAULT / LANE_MARGIN_DEFAULT in lib/lane-classifier.mjs
  // and server/.env.example UM_LANE_CLASSIFIER_THRESHOLD / _MARGIN — update all three together.
  // Pinned by the 2026-06-05 labelled eval: precision 0.953 / recall 0.854 ≥ the 0.95 floor
  // (eval/results/2026-06-05-lane-run{1,2}.json). The margin is load-bearing: at margin 0 no
  // τ clears the floor at non-trivial recall.
  assert.equal(LANE_THRESHOLD_DEFAULT, 0.30);
  assert.equal(LANE_MARGIN_DEFAULT, 0.06);

  // Behavioral: with the threshold/margin env UNSET, classifyLane applies the pinned
  // NON-ZERO margin — a top1≈top2 tie (margin 0) is omitted, not routed.
  const prevT = process.env.UM_LANE_CLASSIFIER_THRESHOLD;
  const prevM = process.env.UM_LANE_CLASSIFIER_MARGIN;
  delete process.env.UM_LANE_CLASSIFIER_THRESHOLD;
  delete process.env.UM_LANE_CLASSIFIER_MARGIN;
  try {
    _resetCentroidsForTest();
    const centroids = [{ slug: 'a', centroid: [1, 0] }, { slug: 'b', centroid: [0, 1] }];
    // [1,1] → cos 0.707 to both → margin 0 < 0.06 default → abstain.
    const tie = await classifyLane([1, 1], { _centroids: centroids });
    assert.equal(tie.lane, null, 'pinned margin (0.06) omits a top1/top2 tie');
    // [1,0.2] → cos≈0.98 to a, ≈0.20 to b → margin ≫ 0.06, top1 ≥ τ=0.30 → routes a.
    const clear = await classifyLane([1, 0.2], { _centroids: centroids });
    assert.equal(clear.lane, 'a', 'clear winner above τ with margin ≥ 0.06 routes');
  } finally {
    if (prevT === undefined) delete process.env.UM_LANE_CLASSIFIER_THRESHOLD; else process.env.UM_LANE_CLASSIFIER_THRESHOLD = prevT;
    if (prevM === undefined) delete process.env.UM_LANE_CLASSIFIER_MARGIN; else process.env.UM_LANE_CLASSIFIER_MARGIN = prevM;
    _resetCentroidsForTest();
  }
});
