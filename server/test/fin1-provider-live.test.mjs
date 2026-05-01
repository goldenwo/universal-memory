/**
 * server/test/fin1-provider-live.test.mjs — FIN1 minimal live integration test.
 *
 * Cost-conservative validation of anthropic + google integration.
 * Each test: 1 LLM call (anthropic OR google) + 1 openai embed call.
 *
 * Skip-guarded by UM_LIVE_TESTS=1. Requires:
 *   - Running Qdrant reachable at QDRANT_HOST:QDRANT_PORT (default localhost:6333)
 *   - OPENAI_API_KEY (used as embedder for stamp-stable v0.7-alpha test)
 *   - ANTHROPIC_API_KEY (for anthropic-facts test)
 *   - GOOGLE_API_KEY (for google-facts test)
 *
 * Notes:
 *   - We keep UM_EMBEDDING_PROVIDER=openai across all tests so we don't
 *     trigger DE5 stamp-mismatch fatal (provider switch on embedder).
 *   - Each test uses a unique userId so qdrant data doesn't conflict.
 *   - Real API calls. Each anthropic test = ~50-100 input tokens, google
 *     same. Well under free-tier or low pay-per-token thresholds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from 'mem0ai/oss';
import { getEmbedderConfig } from '../lib/embed.mjs';
import { getFactsLlmConfig } from '../lib/facts.mjs';

const SKIP = !process.env.UM_LIVE_TESTS;

test('anthropic facts integration: mem0 add with infer extracts via Claude', { skip: SKIP }, async () => {
  const env = {
    ...process.env,
    UM_EMBEDDING_PROVIDER: 'openai',
    UM_FACTS_PROVIDER: 'anthropic',
  };
  const memory = new Memory({
    embedder: getEmbedderConfig(env),
    llm: getFactsLlmConfig(env),
  });
  const userId = `fin1_anthropic_${Date.now()}`;

  // Simple fact extraction test. mem0 calls anthropic to extract facts,
  // then openai to embed each fact. Result: 1 anthropic + 1+ openai calls.
  const result = await memory.add(
    'My favorite color is blue.',
    { userId, infer: true },
  );

  // mem0 returns either {results: [...]} or array of items.
  const items = Array.isArray(result) ? result : (result?.results ?? []);
  assert.ok(Array.isArray(items), 'expected results array shape');
  // We don't assert specific extraction content — that depends on the
  // model's output. Just verify the integration succeeded without throw.
  console.log(`  [fin1-anthropic] facts extracted: ${items.length}`);
});

test('google facts integration: mem0 add with infer extracts via Gemini', { skip: SKIP }, async () => {
  const env = {
    ...process.env,
    UM_EMBEDDING_PROVIDER: 'openai',
    UM_FACTS_PROVIDER: 'google',
  };
  const memory = new Memory({
    embedder: getEmbedderConfig(env),
    llm: getFactsLlmConfig(env),
  });
  const userId = `fin1_google_${Date.now()}`;

  const result = await memory.add(
    'My favorite city is Tokyo.',
    { userId, infer: true },
  );

  const items = Array.isArray(result) ? result : (result?.results ?? []);
  assert.ok(Array.isArray(items), 'expected results array shape');
  console.log(`  [fin1-google] facts extracted: ${items.length}`);
});
