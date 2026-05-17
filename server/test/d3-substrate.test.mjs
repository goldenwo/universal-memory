import test from 'node:test';
import assert from 'node:assert/strict';
import { RESERVED_METADATA_FIELDS, assertNoReservedFields } from '../lib/dedup-constants.mjs';
import { umAdd } from '../lib/add.mjs';

// ── Shared mock helpers (mirrors add.test.mjs idiom) ─────────────────────
function makeMockQdrant() {
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
  const qdrant = makeMockQdrant();
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
