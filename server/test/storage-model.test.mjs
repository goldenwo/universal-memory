// server/test/storage-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectorBytes, indexed, DEFAULT_INDEXING_THRESHOLD } from '../eval/lib/storage-model.mjs';

test('vectorBytes: n * dim * 4 (float32), zero at n=0', () => {
  assert.equal(vectorBytes(1, 1536), 6144);
  assert.equal(vectorBytes(1000, 1536), 6_144_000);
  assert.equal(vectorBytes(10, 768), 30_720);
  assert.equal(vectorBytes(0, 1536), 0);
});

test('indexed: HNSW onset at the threshold (default 20000), override respected', () => {
  assert.equal(indexed(19999), false);
  assert.equal(indexed(20000), true);
  assert.equal(indexed(20001), true);
  assert.equal(indexed(50, 10), true);
  assert.equal(indexed(9, 10), false);
  assert.equal(DEFAULT_INDEXING_THRESHOLD, 20000);
});
