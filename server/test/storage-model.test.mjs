// server/test/storage-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectorBytes, indexed, DEFAULT_INDEXING_THRESHOLD } from '../eval/lib/storage-model.mjs';
import { buildSyntheticPayload, payloadBytes } from '../eval/lib/storage-model.mjs';

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

test('buildSyntheticPayload: exact add.mjs field set (golden keys), lane present when given', () => {
  const p = buildSyntheticPayload({ text: 'hello world', lane: 'dev', userId: 'um-mq-eval', index: 3 });
  assert.deepEqual(
    Object.keys(p).sort(),
    ['createdAt', 'data', 'dedupCount', 'dedupVersion', 'hash', 'lane', 'status', 'userId'].sort(),
  );
  assert.equal(p.data, 'hello world');
  assert.equal(p.userId, 'um-mq-eval');
  assert.equal(p.status, 'current');
  assert.equal(p.dedupCount, 1);
  assert.equal(p.dedupVersion, 1);
  assert.equal(p.lane, 'dev');
  assert.match(p.hash, /^[0-9a-f]{32}$/);          // md5 hex
  assert.match(p.createdAt, /^\d{4}-\d{2}-\d{2}T/); // ISO 8601
  assert.doesNotThrow(() => JSON.stringify(p));     // serializable
});

test('buildSyntheticPayload: lane omitted → no lane key (matches add.mjs conditional spread)', () => {
  const p = buildSyntheticPayload({ text: 'x', userId: 'um-mq-eval', index: 0 });
  assert.equal('lane' in p, false);
});

test('payloadBytes: utf8 byte length, monotonic in text length', () => {
  const short = buildSyntheticPayload({ text: 'a', userId: 'u', index: 0 });
  const long = buildSyntheticPayload({ text: 'a'.repeat(500), userId: 'u', index: 0 });
  assert.ok(payloadBytes(long) > payloadBytes(short));
  assert.equal(payloadBytes(short), Buffer.byteLength(JSON.stringify(short), 'utf8'));
});
