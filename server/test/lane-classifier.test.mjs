// server/test/lane-classifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, meanPool, classifyByCentroid, loadLaneTaxonomy } from '../lib/lane-classifier.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('cosineSimilarity: identical vectors = 1, orthogonal = 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: magnitude-invariant (unnormalized embeddings)', () => {
  assert.ok(Math.abs(cosineSimilarity([2, 0], [5, 0]) - 1) < 1e-9);
});

test('cosineSimilarity: zero vector returns 0 (no NaN)', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test('meanPool: elementwise mean', () => {
  assert.deepEqual(meanPool([[2, 4], [4, 8]]), [3, 6]);
});

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
