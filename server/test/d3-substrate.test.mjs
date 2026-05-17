import test from 'node:test';
import assert from 'node:assert/strict';
import { RESERVED_METADATA_FIELDS, assertNoReservedFields } from '../lib/dedup-constants.mjs';
import { umAdd } from '../lib/add.mjs';
// T1.3: fixture mock with seed + _get + additive setPayload + _store-backed scroll/search (D3.1 substrate)
import { makeMockQdrant } from './fixtures/qdrant-mock.mjs';

// ── Shared mock helpers (mirrors add.test.mjs idiom) ─────────────────────
// Inline weak mock: no _store, scroll/search hardwired empty.
// Named "Inline" to distinguish from the seeded fixture imported above.
function makeMockQdrantInline() {
  const upserts = [];
  return {
    upserts,
    client: {
      upsert: async (collection, body) => { upserts.push({ collection, body }); return { status: 'ok' }; },
      scroll: async () => ({ points: [] }),
      search: async () => [],
    },
  };
}

function makeMockMemory({ collection = 'memories' } = {}) {
  return { config: { vectorStore: { config: { collectionName: collection, host: 'localhost', port: 6333 } } } };
}

// ── T1.1 ─────────────────────────────────────────────────────────────────
test('D3.1 status/supersededBy/supersededAt are reserved', () => {
  for (const f of ['status', 'supersededBy', 'supersededAt']) {
    assert.ok(RESERVED_METADATA_FIELDS.includes(f), `${f} reserved`);
    assert.throws(() => assertNoReservedFields({ [f]: 'x' }), /reserved/i);
  }
});

// ── T1.2 ─────────────────────────────────────────────────────────────────
test('D3.1 buildPayload stamps status:current', async () => {
  const qdrant = makeMockQdrantInline();
  await umAdd({
    memory: makeMockMemory(),
    text: 'a new fact',
    userId: 'u-test',
    infer: false,
    _factsProviderOverride: {
      factsInvoke: async (text) => ({ facts: [text], usage: { tokensIn: 0, tokensOut: 0 } }),
    },
    _embedProviderOverride: {
      supports: { embeddings: true },
      defaults: { embeddingModel: 'mock' },
      embed: async () => ({ vector: [0.1, 0.2], usage: { tokensIn: 0, tokensOut: 0 } }),
    },
    _qdrantClient: qdrant.client,
  });
  assert.equal(qdrant.upserts.length, 1, 'expected exactly one upsert');
  const payload = qdrant.upserts[0].body.points[0].payload;
  assert.equal(payload.status, 'current', 'buildPayload must stamp status:current on every new write');
});

// ── T1.3 ─────────────────────────────────────────────────────────────────
test('D3.1 supersede then unsupersede round-trip', async () => {
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: 'u', status: 'current', data: 'x' } }] });
  const { supersedePoint, unsupersedePoint } = await import('../lib/supersede.mjs');
  await supersedePoint({ client: mock.client, collection: 'c', id: 'p1', supersededBy: 'p2' });
  let pt = mock.client._get('p1');
  assert.equal(pt.payload.status, 'superseded');
  assert.equal(pt.payload.supersededBy, 'p2');
  assert.ok(pt.payload.supersededAt);
  await unsupersedePoint({ client: mock.client, collection: 'c', id: 'p1' });
  pt = mock.client._get('p1');
  assert.equal(pt.payload.status, 'current');
  assert.equal(pt.payload.supersededBy, null);
  assert.equal(pt.payload.supersededAt, null);
});

test('D3.1 supersede is idempotent (re-apply = same terminal state)', async () => {
  const mock = makeMockQdrant({ points: [{ id: 'p1', payload: { userId: 'u', status: 'superseded', supersededBy: 'p2' } }] });
  const { supersedePoint } = await import('../lib/supersede.mjs');
  await supersedePoint({ client: mock.client, collection: 'c', id: 'p1', supersededBy: 'p2' });
  assert.equal(mock.client._get('p1').payload.status, 'superseded');
});

// ── T1.3 regression: store-plane unification ─────────────────────────────
// Proves that setPayload mutations are visible to scroll() and search()
// filtered queries, not just to _get(). Without store-plane unification,
// a superseded point would still appear as 'current' in scroll/search results
// (the pre-fix bug), causing T1.4–T1.6 to false-pass or false-fail.
test('D3.1 superseded point is excluded from scroll/search with status:current filter', async () => {
  const { supersedePoint } = await import('../lib/supersede.mjs');
  // Seed two points: p-target (will be superseded) and p-sibling (stays current).
  const mock = makeMockQdrant({
    points: [
      { id: 'p-target',  payload: { userId: 'u', status: 'current', data: 'old' } },
      { id: 'p-sibling', payload: { userId: 'u', status: 'current', data: 'new' } },
    ],
  });

  // Supersede p-target.
  await supersedePoint({ client: mock.client, collection: 'c', id: 'p-target', supersededBy: 'p-sibling' });

  // Confirm _get sees the mutation (this was already tested, here as sanity anchor).
  assert.equal(mock.client._get('p-target').payload.status, 'superseded', '_get sees superseded');

  // scroll() with must:[{key:'status', match:{value:'current'}}] must exclude p-target.
  const scrollRes = await mock.client.scroll('c', {
    filter: { must: [{ key: 'status', match: { value: 'current' } }] },
    limit: 10,
    with_payload: true,
  });
  const scrollIds = scrollRes.points.map((p) => p.id);
  assert.ok(!scrollIds.includes('p-target'),  'scroll: superseded point must NOT appear');
  assert.ok(scrollIds.includes('p-sibling'), 'scroll: current sibling MUST appear');

  // search() with the same must filter must also exclude p-target.
  const searchRes = await mock.client.search('c', {
    vector: [0.1],
    filter: { must: [{ key: 'status', match: { value: 'current' } }] },
    limit: 10,
    with_payload: true,
  });
  const searchIds = searchRes.map((p) => p.id);
  assert.ok(!searchIds.includes('p-target'),  'search: superseded point must NOT appear');
  assert.ok(searchIds.includes('p-sibling'), 'search: current sibling MUST appear');
});
