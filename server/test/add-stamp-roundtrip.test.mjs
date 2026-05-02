/**
 * server/test/add-stamp-roundtrip.test.mjs — mock-SDK DE5 stamp roundtrip.
 *
 * Closes spec §8 "DE5 stamp roundtrip in boot-smoke" by exercising the
 * full writeStamp(via umAdd) → readStamp(via mem0.getAll) chain WITHOUT
 * real API keys. This complements:
 *   - add-live.test.mjs (full pipeline, real openai + qdrant; UM_LIVE_TESTS=1)
 *   - embedding-stamp.test.mjs (unit-level, mocked qdrant + mocked embed)
 *
 * What this test uniquely covers: real qdrant payload roundtrip through
 * the ACTUAL @qdrant/js-client-rest write path AND mem0.getAll's filter
 * via real qdrant scroll. Catches mem0-vs-qdrant payload schema drift
 * the unit tests can't see.
 *
 * Gating: UM_QDRANT_INTEGRATION=1 (set by smoke.yml after qdrant is up).
 * Defaults to QDRANT_HOST=localhost, QDRANT_PORT=6333, and
 * QDRANT_COLLECTION=stamp_roundtrip_test (separate collection from the
 * main 'memories' so stamp test data doesn't pollute production data).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from 'mem0ai/oss';
import { QdrantClient } from '@qdrant/js-client-rest';
import { writeStamp, readStamp } from '../lib/embedding-stamp.mjs';
import { getEmbedderConfig } from '../lib/embed.mjs';
import { getFactsLlmConfig } from '../lib/facts.mjs';

const SKIP = !process.env.UM_QDRANT_INTEGRATION;

const QDRANT_HOST = process.env.QDRANT_HOST ?? 'localhost';
const QDRANT_PORT = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
const COLLECTION = process.env.QDRANT_COLLECTION ?? 'stamp_roundtrip_test';

async function ensureCleanCollection() {
  const client = new QdrantClient({ host: QDRANT_HOST, port: QDRANT_PORT });
  // Idempotent reset: delete-if-exists then create. Each test run starts clean
  // so prior runs' stamps don't shadow the current write.
  try { await client.deleteCollection(COLLECTION); } catch { /* 404 ok */ }
  await client.createCollection(COLLECTION, { vectors: { size: 1536, distance: 'Cosine' } });
}

test('DE5 stamp roundtrip via umAdd → mem0.getAll (mock-SDK + real qdrant)', { skip: SKIP }, async () => {
  // UM_TEST_MOCK_SDK=1 short-circuits provider.embed to return a canned vector
  // (Array(1536).fill(0) for openai). No API key needed — only qdrant.
  process.env.UM_TEST_MOCK_SDK = '1';
  // OpenAI embed config requires an apiKey field even though the mock path
  // never uses it. Provide a stub to satisfy the config validator.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'sk-mock-stub';

  try {
    await ensureCleanCollection();

    const env = { ...process.env, UM_EMBEDDING_PROVIDER: 'openai', UM_FACTS_PROVIDER: 'openai' };
    const memory = new Memory({
      embedder: getEmbedderConfig(env),
      llm: getFactsLlmConfig(env),
      vectorStore: {
        provider: 'qdrant',
        config: { host: QDRANT_HOST, port: QDRANT_PORT, collectionName: COLLECTION },
      },
    });

    const stamp = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dim: 1536,
      schema_version: 1,
    };

    // Write via umAdd (the production path post-T20).
    await writeStamp({ memory, collection: COLLECTION, stamp });

    // Read via mem0.getAll (the production read path the boot guard uses).
    const round = await readStamp({ memory, collection: COLLECTION });

    assert.deepEqual(
      round,
      stamp,
      'DE5 stamp must round-trip — payload field names (camelCase userId/createdAt; ' +
      'metadata flattened) must match mem0.getAll filter and excludedKeys logic',
    );
  } finally {
    delete process.env.UM_TEST_MOCK_SDK;
    if (process.env.OPENAI_API_KEY === 'sk-mock-stub') delete process.env.OPENAI_API_KEY;
  }
});
