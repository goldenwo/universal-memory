import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  readStamp,
  writeStamp,
  compareStamp,
  verifyDim,
  createStampClient,
} from '../lib/embedding-stamp.mjs';

// #231 mem0 3.x seam: readStamp no longer calls memory.getAll — it enumerates
// through lib/mem0-read's native qdrant scroll (overridable via readStamp's
// second-param DI seam), and its guard now requires memory.config.vectorStore.
// `stubMemory()` supplies exactly that guard input; `enumerating()` hands back
// the same items the old memory.getAll fakes returned, so both cases below pin
// the same null-vs-found behaviour against the same fixture data.
const stubMemory = () => ({ config: { vectorStore: { config: { collectionName: 'memories_test' } } } });
const enumerating = (items) => ({ getAll: async () => items });

test('readStamp returns null when no stamp doc exists', async () => {
  assert.equal(await readStamp({ memory: stubMemory() }, enumerating([])), null);
});
test('readStamp returns stamp when present', async () => {
  const items = [{ metadata: { id: '_um_embedding_stamp', stamp: { provider: 'openai', model: 'text-embedding-3-small', dim: 1536, schema_version: 1 } } }];
  const s = await readStamp({ memory: stubMemory() }, enumerating(items));
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
  // #231 mem0 3.x seam: createStampClient deliberately does NOT forward
  // readStamp's DI seam, so the bound read() runs the real native scroll off
  // memory.config. Substituting a stub enumerator here would test a re-passed
  // dependency — the exact opposite of what this test pins — so the fixture
  // instead speaks the one qdrant call the scroll makes over loopback, leaving
  // `doesNotReject` exercising the genuinely bound path.
  const qdrant = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // GET / is the qdrant client's version handshake (the version string only
    // silences its cosmetic compat warning — nothing here asserts on it);
    // POST /collections/<name>/points/scroll is the enumeration itself.
    res.end(JSON.stringify(req.method === 'GET'
      ? { title: 'qdrant - vector search engine', version: '1.19.0' }
      : { result: { points: [], next_page_offset: null }, status: 'ok', time: 0 }));
  });
  qdrant.listen(0, '127.0.0.1');
  await once(qdrant, 'listening');
  const { port } = qdrant.address();
  try {
    const memory = {
      config: { vectorStore: { config: { host: '127.0.0.1', port, collectionName: 'memories_test' } } },
      add: async () => {},
    };
    const client = createStampClient({ memory, collection: 'memories_test' });
    assert.equal(typeof client.read, 'function');
    assert.equal(typeof client.write, 'function');
    assert.equal(typeof client.verifyDim, 'function');
    assert.equal(typeof client.compare, 'function');
    // client.read() and .write() should not require memory re-pass
    await assert.doesNotReject(() => client.read());
  } finally {
    await new Promise((resolve) => qdrant.close(resolve));
  }
});
