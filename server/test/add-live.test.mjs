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
import { umAdd } from '../lib/add.mjs';
import { getEmbedderConfig } from '../lib/embed.mjs';
import { getFactsLlmConfig } from '../lib/facts.mjs';

const SKIP = !process.env.UM_LIVE_TESTS;

test('umAdd write → mem0.getAll round-trip (payload schema verifier)', { skip: SKIP }, async () => {
  const env = { ...process.env, UM_EMBEDDING_PROVIDER: 'openai', UM_FACTS_PROVIDER: 'openai' };
  const memory = new Memory({
    embedder: getEmbedderConfig(env),
    llm: getFactsLlmConfig(env),
  });
  const userId = `g2-roundtrip-${Date.now()}`;

  // 1. Write via umAdd (real qdrant via memory.vectorStoreConfig).
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
  const memory = new Memory({
    embedder: getEmbedderConfig(env),
    llm: getFactsLlmConfig(env),
  });
  const collection = memory.vectorStoreConfig.collectionName;
  const stamp = { provider: 'openai', model: 'text-embedding-3-small', dim: 1536, schema_version: 1 };
  await writeStamp({ memory, collection, stamp });
  const round = await readStamp({ memory, collection });
  assert.deepEqual(round, stamp, 'DE5 stamp must round-trip via umAdd write + mem0.getAll read');
});
