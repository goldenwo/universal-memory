/**
 * server/test/mem0-read.test.mjs — pins the #231 mem0ai-3.x read adapters.
 *
 * Two seams, both born from the 3.x API break (spec F15/F16):
 * - searchConfig(): 3.x rejects top-level entity params and silently ignores
 *   2.4.6's `limit` (renamed topK) + adds a default 0.1 relevance floor.
 *   UM's payloads keep camelCase `userId`, which 3.x's filter normalizer
 *   passes through verbatim — this test pins ALL THREE conversions so a
 *   future "simplification" (dropping threshold:0, renaming back to limit,
 *   snake_casing the filter key) fails loud instead of silently returning
 *   20 thresholded rows scoped to a key no UM point carries.
 * - umGetAll(): 3.x getAll() hard-requires snake_case filters that can never
 *   match UM's payloads, so enumeration is a native scroll projecting the
 *   EXACT 2.4.6 getAll shape. The projection contract (excluded keys,
 *   metadata nesting, conditional entity fields) is what doList/stats/
 *   compat/purge consumers were built against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchConfig, umGetAll } from '../lib/mem0-read.mjs';

test('searchConfig: camel userId filter passthrough + topK rename + threshold 0 parity', () => {
  assert.deepEqual(
    searchConfig({ userId: 'op', limit: 25 }),
    { filters: { userId: 'op' }, topK: 25, threshold: 0 },
  );
});

test('searchConfig: omitted limit stays omitted (mem0 default topK applies)', () => {
  assert.deepEqual(
    searchConfig({ userId: 'op' }),
    { filters: { userId: 'op' }, threshold: 0 },
  );
});

function fakeMemory() {
  return { config: { vectorStore: { config: { host: 'h', port: 1, collectionName: 'memories_test' } } } };
}

function stubClient(points) {
  const calls = [];
  return {
    calls,
    scroll: async (collection, args) => {
      calls.push({ collection, args });
      return { points };
    },
  };
}

test('umGetAll: scrolls the memory\'s collection filtered on camel userId, capped at 2.4.6\'s default 100', async () => {
  const client = stubClient([]);
  const out = await umGetAll(fakeMemory(), { userId: 'op' }, { getClient: async () => client });
  assert.deepEqual(out, { results: [] });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].collection, 'memories_test');
  assert.deepEqual(client.calls[0].args, {
    filter: { must: [{ key: 'userId', match: { value: 'op' } }] },
    limit: 100,
    with_payload: true,
    with_vector: false,
  });
});

test('umGetAll: explicit limit is passed through (FULL_SCAN_LIMIT callers)', async () => {
  const client = stubClient([]);
  await umGetAll(fakeMemory(), { userId: 'op', limit: 10000 }, { getClient: async () => client });
  assert.equal(client.calls[0].args.limit, 10000);
});

test('umGetAll: projects the exact 2.4.6 getAll result shape', async () => {
  const client = stubClient([
    {
      id: 'p1',
      payload: {
        data: 'the fact', hash: 'h1', createdAt: 'c1', updatedAt: 'u1',
        userId: 'op', lane: 'work', valid_from: '2026-01-01',
      },
    },
    // No updatedAt / no lane / no entity fields beyond userId — the
    // conditional spreads must not invent keys.
    { id: 'p2', payload: { data: 'bare', hash: 'h2', createdAt: 'c2', userId: 'op' } },
  ]);
  const out = await umGetAll(fakeMemory(), { userId: 'op' }, { getClient: async () => client });
  assert.deepEqual(out.results[0], {
    id: 'p1', memory: 'the fact', hash: 'h1', createdAt: 'c1', updatedAt: 'u1',
    metadata: { lane: 'work', valid_from: '2026-01-01' },
    userId: 'op',
  });
  assert.deepEqual(out.results[1], {
    id: 'p2', memory: 'bare', hash: 'h2', createdAt: 'c2', updatedAt: undefined,
    metadata: {}, userId: 'op',
  });
});
