// server/test/lane-classifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, meanPool, classifyByCentroid } from '../lib/lane-classifier.mjs';

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
