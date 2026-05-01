/**
 * server/test/init-memory-dispatch.test.mjs
 *
 * Verifies that the dispatch functions wired into initMemory() correctly
 * translate env var combos into the expected mem0 embedder/llm config blocks.
 *
 * Tests the dispatch contract that initMemory relies on:
 *   getEmbedderConfig(process.env) → { provider, config }
 *   getFactsLlmConfig(process.env) → { provider, config }
 *
 * Testing via dispatch functions directly (not through the Memory constructor)
 * is cleaner and avoids module-mock complexity while still fully exercising
 * the contract that initMemory delegates to.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getEmbedderConfig } from '../lib/embed.mjs';
import { getFactsLlmConfig } from '../lib/facts.mjs';

test('initMemory dispatch: UM_EMBEDDING_PROVIDER=google produces embedder.provider=google', () => {
  const env = {
    UM_EMBEDDING_PROVIDER: 'google',
    UM_FACTS_PROVIDER: 'anthropic',
    GOOGLE_API_KEY: 'AIza-x',
    ANTHROPIC_API_KEY: 'sk-ant-x',
    OPENAI_API_KEY: 'sk-x',
  };
  const embedder = getEmbedderConfig(env);
  const llm = getFactsLlmConfig(env);
  assert.equal(embedder.provider, 'google');
  assert.equal(llm.provider, 'anthropic');
});

test('initMemory dispatch: defaults to openai when env unset', () => {
  const env = { OPENAI_API_KEY: 'sk-x' };
  const embedder = getEmbedderConfig(env);
  const llm = getFactsLlmConfig(env);
  assert.equal(embedder.provider, 'openai');
  assert.equal(llm.provider, 'openai');
});

test('initMemory dispatch: cross-provider — google embed + ollama facts', () => {
  const env = {
    UM_EMBEDDING_PROVIDER: 'google',
    UM_FACTS_PROVIDER: 'ollama',
    GOOGLE_API_KEY: 'AIza-x',
    OLLAMA_HOST: 'http://localhost:11434',
  };
  const embedder = getEmbedderConfig(env);
  const llm = getFactsLlmConfig(env);
  assert.equal(embedder.provider, 'google');
  assert.equal(llm.provider, 'ollama');
});
