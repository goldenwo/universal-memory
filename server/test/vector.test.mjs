// server/test/vector.test.mjs — shared vector math (Gap-5 P2 rule-of-three extraction).
//
// vector.mjs is the single source for cosine + mean-pool, consumed by THREE
// call sites with TWO deliberately distinct failure contracts:
//   - cosineSimilarity  → FAIL-SAFE  (returns 0, never throws): the production
//       classify path (lib/lane-classifier.mjs) — a malformed vector must never
//       fail a user's write.
//   - cosineStrict      → FAIL-LOUD  (throws on empty / mismatched-dim): the eval
//       harnesses (eval/dedup-threshold-sweep.mjs, eval/lane-eval.mjs) — a
//       malformed fixture vector is a bug that must surface, not silently score 0.
// These tests pin BOTH contracts so the extraction stays behaviour-preserving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, cosineStrict, meanPool } from '../lib/vector.mjs';

// ── cosineSimilarity (fail-safe) ─────────────────────────────────────────────

test('cosineSimilarity: identical vectors = 1, orthogonal = 0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosineSimilarity: magnitude-invariant (unnormalized embeddings)', () => {
  assert.ok(Math.abs(cosineSimilarity([2, 0], [5, 0]) - 1) < 1e-9);
  // dot=9, |a|=3, |b|=5 → 0.6
  assert.ok(Math.abs(cosineSimilarity([3, 0], [3, 4]) - 0.6) < 1e-12);
});

test('cosineSimilarity: zero vector returns 0 (no NaN, no throw)', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test('cosineSimilarity: fail-safe — empty input does not throw', () => {
  assert.doesNotThrow(() => cosineSimilarity([], []));
  assert.equal(cosineSimilarity([], []), 0);
});

// ── cosineStrict (fail-loud) ─────────────────────────────────────────────────

test('cosineStrict: correct cosine on valid same-dim inputs', () => {
  assert.ok(Math.abs(cosineStrict([1, 0], [0.6, 0.8]) - 0.6) < 1e-12);
  assert.ok(Math.abs(cosineStrict([3, 0], [3, 4]) - 0.6) < 1e-12);
  assert.ok(Math.abs(cosineStrict([1, 0], [0, 1])) < 1e-12);
});

test('cosineStrict: zero vector → 0 (degenerate magnitude, still no throw)', () => {
  assert.equal(cosineStrict([0, 0], [1, 1]), 0);
});

test('cosineStrict: throws on empty arrays', () => {
  assert.throws(() => cosineStrict([], []), /non-empty arrays of equal length/);
});

test('cosineStrict: throws on mismatched dimensions', () => {
  assert.throws(() => cosineStrict([1, 0], [1, 0, 0]), /non-empty arrays of equal length/);
});

test('cosineStrict: throws on non-array input', () => {
  assert.throws(() => cosineStrict('a', [1]), /non-empty arrays of equal length/);
  assert.throws(() => cosineStrict([1], null), /non-empty arrays of equal length/);
});

// ── meanPool ─────────────────────────────────────────────────────────────────

test('meanPool: elementwise mean', () => {
  assert.deepEqual(meanPool([[2, 4], [4, 8]]), [3, 6]);
});

test('meanPool: single vector returns that vector', () => {
  assert.deepEqual(meanPool([[1, 2, 3]]), [1, 2, 3]);
});

test('meanPool: empty input returns [] (defensive)', () => {
  assert.deepEqual(meanPool([]), []);
});
