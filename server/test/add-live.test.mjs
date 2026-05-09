/**
 * server/test/add-live.test.mjs — DE1-pattern live spike for v0.8 G2.
 *
 * Verifies umAdd's payload schema is mem0-read-path-compatible.
 * Without this test, snake_case/sub-object metadata silently breaks
 * mem0.search and mem0.getAll. See spec §9 risk row 1.
 *
 * Skip-guarded by UM_LIVE_TESTS=1. Requires:
 *   - Running Qdrant at QDRANT_HOST:QDRANT_PORT (default localhost:6333)
 *   - OPENAI_API_KEY (used as embedder + facts provider)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from 'mem0ai/oss';
import { QdrantClient } from '@qdrant/js-client-rest';
import { umAdd } from '../lib/add.mjs';
import { getEmbedderConfig } from '../lib/embed.mjs';
import { getFactsLlmConfig } from '../lib/facts.mjs';

const SKIP = !process.env.UM_LIVE_TESTS;

// Pre-create the qdrant collection so the live tests don't depend on the
// production boot guard's read-first init flow. mem0's Memory does NOT
// lazy-create on getAll (returns 404), and umAdd bypasses mem0's write
// path (which is what would trigger create). In production, the boot
// guard calls readStamp → ensures collection BEFORE any umAdd.
async function ensureCollection({ host, port, name, dim }) {
  const client = new QdrantClient({ host, port, checkCompatibility: false });
  try {
    await client.getCollection(name);
  } catch (e) {
    if (e?.status === 404) {
      await client.createCollection(name, { vectors: { size: dim, distance: 'Cosine' } });
    } else {
      throw e;
    }
  }
}

test('umAdd write → mem0.getAll round-trip (payload schema verifier)', { skip: SKIP }, async () => {
  const env = { ...process.env, UM_EMBEDDING_PROVIDER: 'openai', UM_FACTS_PROVIDER: 'openai' };
  // Without an explicit vectorStore config, mem0 falls back to an in-memory
  // vector store — read paths (mem0.getAll/search) would never see umAdd's
  // qdrant writes. Mirror production's wiring at server/mem0-mcp-http.mjs:362.
  const memory = new Memory({
    embedder: getEmbedderConfig(env),
    llm: getFactsLlmConfig(env),
    vectorStore: {
      provider: 'qdrant',
      config: {
        host: process.env.QDRANT_HOST ?? 'localhost',
        port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
        collectionName: process.env.QDRANT_COLLECTION ?? 'memories',
      },
    },
  });
  const userId = `g2-roundtrip-${Date.now()}`;

  // 0. Pre-create the qdrant collection. Production boots through a guard
  //    that calls readStamp before any umAdd; here we replicate that
  //    invariant via direct qdrant client (umAdd bypasses mem0 for writes
  //    so it can't trigger mem0's lazy collection-create on its own).
  await ensureCollection({
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
    name: memory.config.vectorStore.config.collectionName,
    dim: 1536,
  });

  // 1. Write via umAdd (real qdrant via memory.config.vectorStore.config).
  const writeResult = await umAdd({
    memory,
    text: 'My favorite city is Tokyo.',
    userId,
    infer: true,
  });
  assert.ok(Array.isArray(writeResult.results));
  console.log(`  [g2-roundtrip] umAdd wrote ${writeResult.results.length} fact(s)`);

  // 2. Read via mem0.getAll — MUST find what umAdd wrote.
  // If payload field names diverge (snake_case userId), this returns empty.
  const all = await memory.getAll({ userId });
  const items = Array.isArray(all) ? all : (all?.results ?? []);
  assert.ok(items.length >= 1, `mem0.getAll returned 0 items — payload schema likely diverged from mem0 (spec §4.3 camelCase userId)`);

  // 3. Read via mem0.search — MUST find them by query.
  const search = await memory.search('Tokyo', { userId });
  const found = Array.isArray(search) ? search : (search?.results ?? []);
  assert.ok(found.length >= 1, 'mem0.search returned 0 — payload "data" field name may have drifted');

  // 4. Spot-check payload field names directly via qdrant client (read-side proof).
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const qdrant = new QdrantClient({
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
  });
  const scroll = await qdrant.scroll(memory.config.vectorStore.config.collectionName, {
    filter: { must: [{ key: 'userId', match: { value: userId } }] },
    limit: 5,
    with_payload: true,
  });
  assert.ok(scroll.points.length >= 1, 'qdrant scroll by userId returned empty — userId field name (camelCase) is wrong');
  const payload = scroll.points[0].payload;
  assert.ok('userId' in payload, 'payload.userId (camelCase) missing');
  assert.ok('createdAt' in payload, 'payload.createdAt (camelCase) missing');
  assert.equal(payload.user_id, undefined, 'payload.user_id (snake_case) MUST NOT exist');
  assert.equal(payload.created_at, undefined, 'payload.created_at (snake_case) MUST NOT exist');
  assert.equal(payload.metadata, undefined, 'payload.metadata (sub-object) MUST NOT exist; flatten to top level');

  // 5. Cleanup so reruns don't accumulate.
  for (const item of items) {
    if (item?.id) await memory.delete(item.id);
  }
});

test('umAdd writeStamp → mem0.getAll DE5 roundtrip', { skip: SKIP }, async () => {
  const { writeStamp, readStamp } = await import('../lib/embedding-stamp.mjs');
  const env = { ...process.env, UM_EMBEDDING_PROVIDER: 'openai', UM_FACTS_PROVIDER: 'openai' };
  // Without an explicit vectorStore config, mem0 falls back to an in-memory
  // vector store — read paths (mem0.getAll/search) would never see umAdd's
  // qdrant writes. Mirror production's wiring at server/mem0-mcp-http.mjs:362.
  const memory = new Memory({
    embedder: getEmbedderConfig(env),
    llm: getFactsLlmConfig(env),
    vectorStore: {
      provider: 'qdrant',
      config: {
        host: process.env.QDRANT_HOST ?? 'localhost',
        port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
        collectionName: process.env.QDRANT_COLLECTION ?? 'memories',
      },
    },
  });
  const collection = memory.config.vectorStore.config.collectionName;
  // Same pre-create as the first test (production: boot guard ensures it
  // via readStamp before writeStamp).
  await ensureCollection({
    host: process.env.QDRANT_HOST ?? 'localhost',
    port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
    name: collection,
    dim: 1536,
  });
  const stamp = { provider: 'openai', model: 'text-embedding-3-small', dim: 1536, schema_version: 1 };
  await writeStamp({ memory, collection, stamp });
  const round = await readStamp({ memory, collection });
  assert.deepEqual(round, stamp, 'DE5 stamp must round-trip via umAdd write + mem0.getAll read');
});

// ---------------------------------------------------------------------------
// D1 cross-surface dedup live tests (L1 + L2). Plan E.4 / spec §8.2.
// Both gated by UM_LIVE_TESTS=1 + UM_DEDUP_ENABLED=true (the second flag is
// set inside each test for hygiene; restored on finally).
// ---------------------------------------------------------------------------

test('L1: D1 end-to-end identical-write — write A twice → ONE qdrant point with dedupCount=2 + extended surfaces', { skip: SKIP }, async () => {
  const prevDedup = process.env.UM_DEDUP_ENABLED;
  process.env.UM_DEDUP_ENABLED = 'true';
  try {
    const env = { ...process.env, UM_EMBEDDING_PROVIDER: 'openai', UM_FACTS_PROVIDER: 'openai' };
    const memory = new Memory({
      embedder: getEmbedderConfig(env),
      llm: getFactsLlmConfig(env),
      vectorStore: {
        provider: 'qdrant',
        config: {
          host: process.env.QDRANT_HOST ?? 'localhost',
          port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
          collectionName: process.env.QDRANT_COLLECTION ?? 'memories',
        },
      },
    });
    const userId = `d1-l1-${Date.now()}`;
    const collection = memory.config.vectorStore.config.collectionName;
    await ensureCollection({
      host: process.env.QDRANT_HOST ?? 'localhost',
      port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
      name: collection,
      dim: 1536,
    });

    // 1. First write — surface=cli, project=p1.
    const r1 = await umAdd({
      memory,
      text: 'Tokyo is my favorite city for ramen.',
      userId,
      surface: 'cli',
      metadata: { project: 'p1' },
      infer: false,
    });
    assert.equal(r1.results[0].event, 'ADD');
    const r1Id = r1.results[0].id;

    // 2. Second write — IDENTICAL text, different surface=mcp, different project=p2.
    //    Should hit Layer 1 (hash) and merge into r1's point.
    const r2 = await umAdd({
      memory,
      text: 'Tokyo is my favorite city for ramen.',
      userId,
      surface: 'mcp',
      metadata: { project: 'p2' },
      infer: false,
    });
    assert.equal(r2.results[0].event, 'DEDUP_MERGED', 'second identical write should merge');
    assert.equal(r2.results[0].id, r1Id, 'merge target must be the first-write point');

    // 3. Read back via qdrant scroll — ONE point with surfaces+projects extended.
    const qdrant = new QdrantClient({
      host: process.env.QDRANT_HOST ?? 'localhost',
      port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
    });
    const scroll = await qdrant.scroll(collection, {
      filter: { must: [{ key: 'userId', match: { value: userId } }] },
      limit: 10,
      with_payload: true,
    });
    assert.equal(scroll.points.length, 1, `exactly one point per identical-text + same-userId; got ${scroll.points.length}`);
    const payload = scroll.points[0].payload;
    assert.equal(payload.dedupCount, 2);
    assert.deepEqual(payload.surfaces.sort(), ['cli', 'mcp']);
    assert.deepEqual(payload.projects.sort(), ['p1', 'p2']);
    assert.ok(typeof payload.dedupLastSeenAt === 'string');

    // 4. Cleanup.
    await qdrant.delete(collection, { points: [r1Id] });
  } finally {
    if (prevDedup === undefined) delete process.env.UM_DEDUP_ENABLED;
    else process.env.UM_DEDUP_ENABLED = prevDedup;
  }
});

test('L2: D1 end-to-end embedding-near-miss — high-similarity but not exact text dedups via Layer 2', { skip: SKIP }, async () => {
  const prevDedup = process.env.UM_DEDUP_ENABLED;
  const prevThresh = process.env.UM_DEDUP_EMBEDDING_THRESHOLD;
  process.env.UM_DEDUP_ENABLED = 'true';
  // Use a relaxed threshold so paraphrases reliably merge in CI.
  // Real-world tuning will dial this in via §10.2 eval.
  process.env.UM_DEDUP_EMBEDDING_THRESHOLD = '0.85';
  try {
    const env = { ...process.env, UM_EMBEDDING_PROVIDER: 'openai', UM_FACTS_PROVIDER: 'openai' };
    const memory = new Memory({
      embedder: getEmbedderConfig(env),
      llm: getFactsLlmConfig(env),
      vectorStore: {
        provider: 'qdrant',
        config: {
          host: process.env.QDRANT_HOST ?? 'localhost',
          port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
          collectionName: process.env.QDRANT_COLLECTION ?? 'memories',
        },
      },
    });
    const userId = `d1-l2-${Date.now()}`;
    const collection = memory.config.vectorStore.config.collectionName;
    await ensureCollection({
      host: process.env.QDRANT_HOST ?? 'localhost',
      port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
      name: collection,
      dim: 1536,
    });

    // First write — canonical statement.
    const r1 = await umAdd({
      memory,
      text: 'I prefer the Rust programming language.',
      userId,
      surface: 'cli',
      infer: false,
    });
    assert.equal(r1.results[0].event, 'ADD');
    const r1Id = r1.results[0].id;

    // Second write — paraphrase (high cosine sim, different hash).
    const r2 = await umAdd({
      memory,
      text: 'My preferred programming language is Rust.',
      userId,
      surface: 'mcp',
      infer: false,
    });
    // At threshold=0.85 with text-embedding-3-small, two paraphrases of the
    // same fact typically score 0.88–0.95. If this test ever flakes, lower
    // the threshold OR pin a deterministic embedding via _embedProviderOverride.
    assert.equal(r2.results[0].event, 'DEDUP_MERGED', 'paraphrase should merge via Layer 2');
    assert.equal(r2.results[0].id, r1Id);

    // Cleanup.
    const qdrant = new QdrantClient({
      host: process.env.QDRANT_HOST ?? 'localhost',
      port: parseInt(process.env.QDRANT_PORT ?? '6333', 10),
    });
    await qdrant.delete(collection, { points: [r1Id] });
  } finally {
    if (prevDedup === undefined) delete process.env.UM_DEDUP_ENABLED;
    else process.env.UM_DEDUP_ENABLED = prevDedup;
    if (prevThresh === undefined) delete process.env.UM_DEDUP_EMBEDDING_THRESHOLD;
    else process.env.UM_DEDUP_EMBEDDING_THRESHOLD = prevThresh;
  }
});
