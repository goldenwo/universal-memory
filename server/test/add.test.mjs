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
  return { config: { vectorStore: { config: { collectionName: collection, host: 'localhost', port: 6333 } } } };
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
  // D1 v1.1 schema additions (always seeded regardless of UM_DEDUP_ENABLED).
  // Visibility lock: if a future change drops these fields, this assertion
  // fails loudly rather than silently regressing the dedup contract.
  assert.equal(payload.dedupCount, 1, 'D1: dedupCount MUST be seeded to 1 on first write');
  assert.equal(payload.dedupVersion, 1, 'D1: dedupVersion MUST be seeded to 1 (schema-version pin)');
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

test('umAdd binds {userId, collection, infer} to pino ALS via withRequestContext', async () => {
  const { withRequestContext } = await import('../lib/request-context.mjs');
  let observed;
  const factsOverride = {
    factsInvoke: async () => {
      // Inside the orchestrator call, the ALS store should hold our binding.
      const { _alsForTest } = await import('../lib/request-context.mjs');
      observed = _alsForTest().getStore();
      return { facts: [], usage: { tokensIn: 0, tokensOut: 0 } };
    },
  };
  await withRequestContext({ id: 'req-1' }, async () => {
    await umAdd({
      memory: { config: { vectorStore: { config: { collectionName: 'cc', host: 'localhost', port: 6333 } } } },
      text: 't', userId: 'alice', infer: true,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: { embed: async () => ({ vector: [], usage: { tokensIn: 0, tokensOut: 0 } }) },
      _qdrantClient: { upsert: async () => ({}) },
    });
  });
  assert.equal(observed?.userId, 'alice');
  assert.equal(observed?.collection, 'cc');
  assert.equal(observed?.infer, true);
  assert.equal(observed?.id, 'req-1');  // outer request_id preserved
});

test('umAdd increments um_facts_extracted_total by facts.length per call', async () => {
  const incCalls = [];
  const fakeFactsCounter = { inc: (labels, value) => incCalls.push({ labels, value }) };
  // Provide `defaults.factsModel` so the facts orchestrator's fallback chain
  // (ctx.model ?? env ?? provider.defaults?.factsModel) resolves to a real
  // string. Without this, model falls through to undefined and the counter
  // emits {provider, model: undefined} — production has no such gap because
  // real providers always export defaults.
  const factsOverride = {
    defaults: { factsModel: 'mock-facts-model' },
    factsInvoke: async () => ({ facts: ['a', 'b', 'c'], usage: { tokensIn: 5, tokensOut: 2 } }),
  };
  await umAdd({
    memory: { config: { vectorStore: { config: { collectionName: 'c', host: 'localhost', port: 6333 } } } }, text: 't', userId: 'u', infer: true,
    _factsProviderOverride: factsOverride,
    _embedProviderOverride: { embed: async () => ({ vector: [0.1], usage: { tokensIn: 0, tokensOut: 0 } }) },
    _qdrantClient: { upsert: async () => ({}) },
    _factsCounter: fakeFactsCounter,
  });
  assert.equal(incCalls.length, 1);
  assert.equal(incCalls[0].value, 3);
  // Labels come from the orchestrator return shape (T11 extension). Assert
  // they're present AND non-undefined strings — a regression that fell through
  // env resolution and emitted {provider: undefined, model: undefined} would
  // have passed the weaker `'in' in labels` check.
  assert.equal(typeof incCalls[0].labels.provider, 'string');
  assert.equal(typeof incCalls[0].labels.model, 'string');
});

test('umAdd emits facts.empty INFO log when infer:true extracts zero facts', async () => {
  const logged = [];
  const fakeLogger = { info: (obj, msg) => logged.push({ obj, msg }) };
  await umAdd({
    memory: { config: { vectorStore: { config: { collectionName: 'c', host: 'localhost', port: 6333 } } } }, text: 't', userId: 'u', infer: true,
    _factsProviderOverride: { factsInvoke: async () => ({ facts: [], usage: { tokensIn: 5, tokensOut: 1 } }) },
    _embedProviderOverride: { embed: async () => assert.fail('should not call embed') },
    _qdrantClient: { upsert: async () => ({}) },
    _logger: fakeLogger,
  });
  const empty = logged.find((l) => l.obj?.event === 'facts.empty');
  assert.ok(empty, 'facts.empty INFO line emitted');
  assert.equal(empty.obj.userId, 'u');
  assert.equal(empty.obj.collection, 'c');
  assert.equal(typeof empty.obj.textLength, 'number');
});

test('umAdd surfaces qdrant errors raw — outer call sites wrap retry policy', async () => {
  // Spec §6 + add.mjs header: umAdd does NOT internally wrap qdrant.upsert
  // in withRetry. The mem0-mcp-http call sites (lines 688/778/2179/2338)
  // each wrap umAdd() in withRetry({op:'add'}) — that's the single source
  // of retry/UPSTREAM_FAILURE behavior. Wrapping again inside umAdd would
  // multiply attempts (4×4 = 16) and double-emit um_mem0_ops_total.
  let calls = 0;
  const flakyClient = {
    upsert: async () => { calls++; throw Object.assign(new Error('connection refused'), { retryable: true }); },
  };
  const factsOverride = { factsInvoke: async () => ({ facts: ['x'], usage: { tokensIn: 0, tokensOut: 0 } }) };
  const embedOverride = { embed: async () => ({ vector: [0.1], usage: { tokensIn: 0, tokensOut: 0 } }) };
  await assert.rejects(
    () => umAdd({
      memory: makeMockMemory(), text: 't', userId: 'u', infer: true,
      _factsProviderOverride: factsOverride,
      _embedProviderOverride: embedOverride,
      _qdrantClient: flakyClient,
    }),
    /connection refused/,
  );
  assert.equal(calls, 1, 'no inner retry — single attempt before throw');
});
