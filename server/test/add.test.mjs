import test from 'node:test';
import assert from 'node:assert/strict';
import { umAdd } from '../lib/add.mjs';

// Test fixtures — mock qdrant client + memory shim
function makeMockQdrant() {
  const upserts = [];
  return {
    upserts,
    client: {
      upsert: async (collection, body) => { upserts.push({ collection, body }); return { status: 'ok' }; },
    },
  };
}

function makeMockMemory({ collection = 'memories' } = {}) {
  return { vectorStoreConfig: { collectionName: collection } };
}

test('umAdd infer:true calls facts() then embed() per fact, then qdrant.upsert per fact', async () => {
  const calls = [];
  const factsOverride = {
    supports: { facts: true },
    defaults: { factsModel: 'mock' },
    factsInvoke: async (text) => {
      calls.push({ kind: 'facts', text });
      return { facts: ['fact 1', 'fact 2'], usage: { tokensIn: 10, tokensOut: 5 } };
    },
  };
  const embedOverride = {
    supports: { embeddings: true },
    defaults: { embeddingModel: 'mock' },
    embed: async (text) => {
      calls.push({ kind: 'embed', text });
      return { vector: [0.1, 0.2], usage: { tokensIn: 3, tokensOut: 0 } };
    },
  };
  const qdrant = makeMockQdrant();
  const memory = makeMockMemory();

  const result = await umAdd({
    memory, text: 'I like blue.', userId: 'u-1', infer: true,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: embedOverride,
    _qdrantClient: qdrant.client,
  });

  assert.equal(calls.length, 3, 'facts() once + embed() twice');
  assert.equal(calls[0].kind, 'facts');
  assert.equal(calls[1].kind, 'embed');
  assert.equal(calls[1].text, 'fact 1');
  assert.equal(calls[2].text, 'fact 2');
  assert.equal(qdrant.upserts.length, 2);
  assert.equal(qdrant.upserts[0].collection, 'memories');

  // Return shape mirrors mem0's add()
  assert.ok(Array.isArray(result.results));
  assert.equal(result.results.length, 2);
  for (const r of result.results) {
    assert.ok(typeof r.id === 'string');
    assert.equal(r.event, 'ADD');
  }
});

test('umAdd infer:false skips facts(), embeds raw text once, single qdrant upsert', async () => {
  const calls = [];
  const factsOverride = {
    factsInvoke: async () => { calls.push('facts'); return { facts: [], usage: { tokensIn: 0, tokensOut: 0 } }; },
  };
  const embedOverride = {
    supports: { embeddings: true }, defaults: { embeddingModel: 'mock' },
    embed: async (text) => { calls.push('embed:' + text); return { vector: [0.5], usage: { tokensIn: 8, tokensOut: 0 } }; },
  };
  const qdrant = makeMockQdrant();
  const memory = makeMockMemory();

  await umAdd({
    memory, text: 'raw doc text', userId: 'u-2', metadata: { id: 'doc-7', kind: 'page' }, infer: false,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: embedOverride,
    _qdrantClient: qdrant.client,
  });

  assert.deepEqual(calls, ['embed:raw doc text']);  // facts() NOT called when infer:false
  assert.equal(qdrant.upserts.length, 1);
  // Payload schema (load-bearing — spec §4.3): camelCase userId/createdAt, metadata flattened.
  const payload = qdrant.upserts[0].body.points[0].payload;
  assert.equal(payload.userId, 'u-2');
  assert.equal(payload.id, 'doc-7');         // metadata flattened
  assert.equal(payload.kind, 'page');         // metadata flattened
  assert.equal(payload.data, 'raw doc text');
  assert.ok(typeof payload.hash === 'string' && payload.hash.length === 32, 'md5(text)');
  assert.ok(typeof payload.createdAt === 'string', 'ISO 8601 createdAt');
  assert.equal(payload.user_id, undefined, 'snake_case user_id MUST NOT appear');
  assert.equal(payload.created_at, undefined, 'snake_case created_at MUST NOT appear');
  assert.equal(payload.metadata, undefined, 'metadata MUST be flattened, not nested');
});

test('umAdd error from facts() propagates without writing to qdrant', async () => {
  const factsOverride = { factsInvoke: async () => { throw new Error('facts failed'); } };
  const embedOverride = { embed: async () => assert.fail('embed should not be called') };
  const qdrant = makeMockQdrant();
  await assert.rejects(
    () => umAdd({
      memory: makeMockMemory(), text: 't', userId: 'u', infer: true,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: qdrant.client,
    }),
    /facts failed/,
  );
  assert.equal(qdrant.upserts.length, 0);
});

test('umAdd empty facts (infer:true, 0 extracted) returns { results: [] }, no qdrant write', async () => {
  const factsOverride = { factsInvoke: async () => ({ facts: [], usage: { tokensIn: 5, tokensOut: 1 } }) };
  const embedOverride = { embed: async () => assert.fail('embed should not be called when facts empty') };
  const qdrant = makeMockQdrant();
  const result = await umAdd({
    memory: makeMockMemory(), text: 't', userId: 'u', infer: true,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: embedOverride,
    _qdrantClient: qdrant.client,
  });
  assert.deepEqual(result, { results: [] });
  assert.equal(qdrant.upserts.length, 0);
});
