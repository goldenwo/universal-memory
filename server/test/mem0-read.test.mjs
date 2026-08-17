/**
 * server/test/mem0-read.test.mjs — pins the #231 mem0ai-3.x read adapters.
 *
 * The seams, all born from the 3.x API break (spec F15/F16/F18):
 * - searchConfig(): the cfg shape call sites emit ({filters:{userId}, topK})
 *   — translated by wrapMem0Read into umSearch. Pins the camel filter key
 *   and the topK rename so a future "simplification" (renaming back to
 *   limit, snake_casing the key) fails loud.
 * - umSearch(): the native dense read (mem0 3.x's search validator can
 *   never scope UM's camel payloads). Pins: embedder-driven vector, the
 *   scope filter, the EXPLICIT limit key (omitted → 100, 2.4.6 parity —
 *   never the qdrant client's own default of 10), payload guards, and the
 *   data-less filter.
 * - umGetAll(): native scroll projecting the EXACT 2.4.6 getAll shape. The
 *   projection contract (excluded keys, metadata nesting, conditional
 *   entity fields, payload-less degradation) is what doList/stats/compat/
 *   purge consumers were built against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchConfig, umGetAll, umSearch, wrapMem0Read } from '../lib/mem0-read.mjs';

test('searchConfig: camel userId filter passthrough + topK rename (no threshold field — the native read has no floor)', () => {
  assert.deepEqual(
    searchConfig({ userId: 'op', limit: 25 }),
    { filters: { userId: 'op' }, topK: 25 },
  );
});

test("searchConfig: omitted limit stays omitted (umSearch's 2.4.6-parity default applies at execution)", () => {
  assert.deepEqual(
    searchConfig({ userId: 'op' }),
    { filters: { userId: 'op' } },
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

test('umSearch: omitted limit sends 100 (2.4.6 parity) — NEVER the qdrant client default of 10', async () => {
  // Round-1 code-review catch: omitting the key entirely let the client's
  // own default (10) silently shrink the candidate pool.
  const memory = {
    embedder: { embed: async () => [0.1] },
    config: { vectorStore: { config: { host: 'h', port: 1, collectionName: 'c' } } },
  };
  const calls = [];
  const client = { search: async (_c, args) => { calls.push(args); return []; } };
  await umSearch(memory, 'q', { userId: 'op' }, { getClient: async () => client });
  assert.equal(calls[0].limit, 100);
});

test('umSearch: payload-less and data-less hits degrade, never throw or surface', async () => {
  const memory = {
    embedder: { embed: async () => [0.1] },
    config: { vectorStore: { config: { host: 'h', port: 1, collectionName: 'c' } } },
  };
  const client = {
    search: async () => [
      { id: 'p0', score: 0.9, payload: null },
      { id: 'p1', score: 0.8, payload: { hash: 'h', userId: 'op' } },
      { id: 'p2', score: 0.7, payload: { data: 'kept', userId: 'op' } },
    ],
  };
  const out = await umSearch(memory, 'q', { userId: 'op' }, { getClient: async () => client });
  // Only the data-bearing hit survives (mem0-search parity); the null-payload
  // hit must not TypeError the whole read.
  assert.deepEqual(out.results.map((r) => r.id), ['p2']);
});

test('umGetAll: a payload-less point projects sparse instead of throwing (enumeration keeps ALL rows)', async () => {
  const client = {
    scroll: async () => ({ points: [{ id: 'p0', payload: null }, { id: 'p1', payload: { data: 'd', userId: 'op' } }] }),
  };
  const out = await umGetAll(fakeMemory(), { userId: 'op' }, { getClient: async () => client });
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0], { id: 'p0', memory: undefined, hash: undefined, createdAt: undefined, updatedAt: undefined, metadata: {} });
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
