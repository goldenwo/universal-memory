/**
 * Tests for server/lib/envelope.mjs
 *
 * Run with: node --test server/test/envelope.test.mjs
 *
 * The envelope helper is the single choke-point for building the list-endpoint
 * `{results: [...]}` response shape. These tests pin the contract:
 *   - happy path: array-only and array+extras
 *   - type safety: non-array inputs throw TypeError (loud shape drift)
 *   - key priority: extras cannot override the `results` field
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listEnvelope } from '../lib/envelope.mjs';

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------
test('listEnvelope([]) returns {results: []}', () => {
  assert.deepEqual(listEnvelope([]), { results: [] });
});

test('listEnvelope([{id:1}]) returns {results: [{id:1}]}', () => {
  assert.deepEqual(listEnvelope([{ id: 1 }]), { results: [{ id: 1 }] });
});

test('listEnvelope with extras merges top-level sibling fields', () => {
  const env = listEnvelope([], { provider: 'mem0', latency_ms: 42 });
  assert.deepEqual(env, { results: [], provider: 'mem0', latency_ms: 42 });
});

test('listEnvelope with populated array + extras preserves both', () => {
  const env = listEnvelope([{ id: 'a' }, { id: 'b' }], { latency_ms: 7 });
  assert.equal(env.results.length, 2);
  assert.equal(env.latency_ms, 7);
  assert.equal(env.results[0].id, 'a');
});

// ---------------------------------------------------------------------------
// Type safety — loud failure on shape drift
// ---------------------------------------------------------------------------
test('listEnvelope(null) throws TypeError', () => {
  assert.throws(() => listEnvelope(null), TypeError);
});

test("listEnvelope('not-array') throws TypeError", () => {
  assert.throws(() => listEnvelope('not-array'), TypeError);
});

test('listEnvelope(undefined) throws TypeError', () => {
  assert.throws(() => listEnvelope(undefined), TypeError);
});

test('listEnvelope({}) throws TypeError', () => {
  assert.throws(() => listEnvelope({}), TypeError);
});

// ---------------------------------------------------------------------------
// Key priority — extras cannot clobber `results`
// ---------------------------------------------------------------------------
test('extras.results is ignored; first-arg results wins', () => {
  const env = listEnvelope([], { results: [1, 2] });
  assert.deepEqual(env.results, []);
});

test('extras.results clash still preserves other extras', () => {
  const env = listEnvelope([{ id: 'x' }], { results: [99], provider: 'mem0' });
  assert.deepEqual(env.results, [{ id: 'x' }]);
  assert.equal(env.provider, 'mem0');
});
