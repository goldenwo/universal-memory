// server/test/lane-classifier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, meanPool } from '../lib/lane-classifier.mjs';

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
