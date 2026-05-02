import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readStamp,
  writeStamp,
  compareStamp,
  verifyDim,
  createStampClient,
} from '../lib/embedding-stamp.mjs';

test('readStamp returns null when no stamp doc exists', async () => {
  const memory = { getAll: async () => [] };
  assert.equal(await readStamp({ memory }), null);
});
test('readStamp returns stamp when present', async () => {
  const memory = { getAll: async () => [{ metadata: { id: '_um_embedding_stamp', stamp: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536, schema_version: 1 } } }] };
  const s = await readStamp({ memory });
  assert.equal(s.provider, 'openai');
  assert.equal(s.dim, 1536);
});
test('writeStamp persists shaped stamp via named-arg signature', async () => {
  let upsertCall;
  // T20: writeStamp now routes through umAdd, which requires the full memory
  // config shape (not just memory.add) and a Qdrant upsert. Inject _qdrantClient
  // to capture the upsert without connecting to a real Qdrant instance, and
  // _embedProviderOverride so no real embedding API call is made.
  const memory = {
    config: { vectorStore: { config: { collectionName: 'test', host: 'localhost', port: 6333 } } },
  };
  const _qdrantClient = { upsert: async (col, { points }) => { upsertCall = { col, point: points[0] }; } };
  const _embedProviderOverride = { embed: async () => ({ vector: [0, 0, 0], usage: { tokensIn: 0, tokensOut: 0 } }), supports: { embeddings: true } };
  // Unified contract: writeStamp({ memory, collection, stamp })
  // - `memory` injected for testability
  // - `collection` optional (defaults to active alias); explicit during reindex
  // - `stamp` carries provider/model/dim/etc. shape fields
  await writeStamp({
    memory,
    stamp: { provider: 'google', model: 'text-embedding-004', dim: 768 },
    _qdrantClient,
    _embedProviderOverride,
  });
  assert.ok(upsertCall, 'upsert must have been called');
  assert.equal(upsertCall.point.payload.id, '_um_embedding_stamp');
  assert.equal(upsertCall.point.payload.infer, undefined, 'infer is not stored in payload (umAdd contract)');
});

test('writeStamp accepts explicit collection (used by reindex Phase 4)', async () => {
  // Contract: writeStamp({ memory, collection, stamp }) routes the add through
  // a Memory instance scoped to the named collection. The DI seam is the
  // `memory` argument the caller passes; `collection` is propagated to the
  // stamp metadata (so a downstream reader can also identify origin).
  let collectionRoutedTo;
  let stampWritten;
  const memory = {
    config: { vectorStore: { config: { collectionName: 'memories_a1b2c3d4', host: 'localhost', port: 6333 } } },
  };
  const _qdrantClient = {
    upsert: async (col, { points }) => {
      collectionRoutedTo = points[0].payload?.collection;
      stampWritten = points[0].payload?.stamp;
    },
  };
  const _embedProviderOverride = { embed: async () => ({ vector: [0, 0, 0], usage: { tokensIn: 0, tokensOut: 0 } }), supports: { embeddings: true } };
  await writeStamp({
    memory,
    collection: 'memories_a1b2c3d4',
    stamp: { provider: 'google', model: 'text-embedding-004', dim: 768 },
    _qdrantClient,
    _embedProviderOverride,
  });
  // Real assertions, not tautology
  assert.equal(collectionRoutedTo, 'memories_a1b2c3d4', 'collection name reaches metadata');
  assert.equal(stampWritten?.provider, 'google');
  assert.equal(stampWritten?.dim, 768);
});
test('compareStamp matches when fields equal', () => {
  const stamp = { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 };
  assert.equal(compareStamp(stamp, { provider: 'openai', model: 'text-embedding-3-small', dim: 1536 }), 'match');
  assert.equal(compareStamp(stamp, { provider: 'google', model: 'text-embedding-004', dim: 768 }), 'mismatch');
});
test('verifyDim probes embedder, refuses on dim mismatch (R3)', async () => {
  const fakeEmbed = { embedQuery: async () => new Array(512) };  // wrong dim
  await assert.rejects(() => verifyDim({ embedder: fakeEmbed, dim: 1536 }), /dim.*mismatch|substituted/i);
});

test('verifyDim resolves silently when probe returns correct dim (happy path)', async () => {
  const fakeEmbed = { embedQuery: async () => new Array(1536) };
  await assert.doesNotReject(() => verifyDim({ embedder: fakeEmbed, dim: 1536 }));
});

test('verifyDim tags probe failure distinctly from dim mismatch', async () => {
  // Probe rejection must surface as 'embedding probe failed', NOT 'embedding dim mismatch'.
  // Operators need to distinguish a transient embedder/network failure from a genuine
  // model swap (R3 fence) — same error string would conflate the two failure modes.
  const fakeEmbed = { embedQuery: async () => { throw new Error('network unreachable'); } };
  await assert.rejects(
    () => verifyDim({ embedder: fakeEmbed, dim: 1536 }),
    (err) => {
      assert.match(err.message, /embedding probe failed/);
      assert.doesNotMatch(err.message, /embedding dim mismatch/);
      return true;
    },
  );
});

test('createStampClient binds memory + collection, returns DI-friendly object', async () => {
  const memory = { getAll: async () => [], add: async () => {} };
  const client = createStampClient({ memory, collection: 'memories_test' });
  assert.equal(typeof client.read, 'function');
  assert.equal(typeof client.write, 'function');
  assert.equal(typeof client.verifyDim, 'function');
  assert.equal(typeof client.compare, 'function');
  // client.read() and .write() should not require memory re-pass
  await assert.doesNotReject(() => client.read());
});
