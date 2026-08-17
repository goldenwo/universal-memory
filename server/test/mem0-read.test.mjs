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
import { searchConfig, umGetAll, umSearch, wrapMem0Read } from '../lib/mem0-read.mjs';

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

test('umSearch: embeds via mem0\'s embedder, dense-searches on the camel userId filter, projects with score', async () => {
  // mem0 3.x search() UNCONDITIONALLY requires a snake entity filter
  // (effectiveFilters check, index.mjs ~L17795) — even empty filters throw —
  // so the camel passthrough can never reach search. The native read is the
  // D8 continuation: mem0's embedder (config-driven, provider-correct) +
  // qdrant dense search on UM's actual payload key. Caught live by the A9
  // modern-arm eval; unit mocks were blind to the validator (the
  // seam-contracts lesson, again).
  const embedCalls = [];
  const memory = {
    embedder: { embed: async (text) => { embedCalls.push(text); return [0.1, 0.2]; } },
    config: { vectorStore: { config: { host: 'h', port: 1, collectionName: 'memories_test' } } },
  };
  const calls = [];
  const client = {
    search: async (collection, args) => {
      calls.push({ collection, args });
      return [
        { id: 'p1', score: 0.87, payload: { data: 'fact', hash: 'h1', createdAt: 'c1', userId: 'op', lane: 'work' } },
      ];
    },
  };
  const out = await umSearch(memory, 'where is tokyo', { userId: 'op', limit: 25 }, { getClient: async () => client });
  assert.deepEqual(embedCalls, ['where is tokyo']);
  assert.equal(calls[0].collection, 'memories_test');
  assert.deepEqual(calls[0].args, {
    vector: [0.1, 0.2],
    filter: { must: [{ key: 'userId', match: { value: 'op' } }] },
    limit: 25,
    with_payload: true,
  });
  assert.deepEqual(out, {
    results: [{
      id: 'p1', memory: 'fact', hash: 'h1', createdAt: 'c1', updatedAt: undefined,
      score: 0.87, metadata: { lane: 'work' }, userId: 'op',
    }],
  });
});

test('wrapMem0Read: .search routes native (searchConfig args translated); everything else delegates', async () => {
  const client = {
    search: async (_c, args) => { client.lastArgs = args; return []; },
  };
  const target = {
    embedder: { embed: async () => [0.5] },
    config: { vectorStore: { config: { host: 'h', port: 1, collectionName: 'c' } } },
    delete: async (id) => `deleted:${id}`,
    getAll: async () => 'real-mem0-getAll',
  };
  const wrapped = wrapMem0Read(target, { getClient: async () => client });
  // search: consumes the searchConfig() shape the call sites already emit.
  const res = await wrapped.search('q', searchConfig({ userId: 'op', limit: 7 }));
  assert.deepEqual(res, { results: [] });
  assert.equal(client.lastArgs.limit, 7);
  assert.deepEqual(client.lastArgs.filter, { must: [{ key: 'userId', match: { value: 'op' } }] });
  // delegation: methods bind to the target (mem0 privates stay intact),
  // plain props read through.
  assert.equal(await wrapped.delete('x'), 'deleted:x');
  assert.equal(wrapped.config.vectorStore.config.collectionName, 'c');
  // getAll stays MEM0'S OWN — the warmup discriminator must keep driving the
  // real public surface (spec F14); enumeration callers use umGetAll, not
  // the instance method.
  assert.equal(await wrapped.getAll(), 'real-mem0-getAll');
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
