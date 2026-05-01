/**
 * R1 Mitigation: mem0 OSS config-key drift detective test.
 *
 * Asserts that config blocks produced by getEmbedderConfig() and getFactsLlmConfig()
 * can be passed into new Memory({...}) without throwing. Detects silent config-key
 * mismatches when mem0 OSS renames contract keys between minor versions.
 *
 * See design §10.5 R1: Round-trip test validates embedder/llm config blocks against
 * the mem0 Memory constructor. No live calls are made; instantiation with invalid
 * config shapes will throw immediately.
 *
 * Note: mem0 OSS requires both the config block AND the corresponding environment
 * variable (e.g., ANTHROPIC_API_KEY for anthropic provider). This test sets env vars
 * to satisfy mem0's constructor validation; no actual API calls are made.
 *
 * Live calls: 0. Config validation: 7 providers (3 embedder + 4 facts).
 *
 * Strengthened (R1 regression guard): after construction, asserts that
 * mem.config.embedder.config.apiKey reflects the test input value — detects the
 * class of bug where snake_case keys are silently dropped and apiKey stays empty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from 'mem0ai/oss';
import { EMBEDDING_BACKENDS, getEmbedderConfig } from '../lib/embed.mjs';
import { FACTS_BACKENDS, getFactsLlmConfig } from '../lib/facts.mjs';

const TEST_OPENAI_KEY = 'sk-test-1234567890abcdef';
const TEST_ANTHROPIC_KEY = 'sk-ant-test-1234567890abcdef';

// Helper: save, set, restore env vars using delete-when-undefined semantics.
// Setting process.env.X = undefined coerces to literal string "undefined" which
// pollutes the env for subsequent tests — use delete instead.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

// For each provider, asserting Memory constructor accepts the config block.
// Live calls are NOT made — this is a config-shape compatibility test.
for (const name of Object.keys(EMBEDDING_BACKENDS)) {
  test(`mem0 Memory accepts embedderConfig from ${name}`, () => {
    const env = {
      UM_EMBEDDING_PROVIDER: name,
      OPENAI_API_KEY: TEST_OPENAI_KEY,
      UM_ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY,
      ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY,
      GOOGLE_API_KEY: 'AIza-test-1234567890abcdef', OLLAMA_HOST: 'http://localhost:11434',
    };
    withEnv({ OPENAI_API_KEY: TEST_OPENAI_KEY, ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY }, () => {
      const embedder = getEmbedderConfig(env);
      let mem;
      // Constructor should not throw — we don't actually run any operations.
      assert.doesNotThrow(() => {
        mem = new Memory({ embedder, llm: getFactsLlmConfig({ ...env, UM_FACTS_PROVIDER: 'openai' }) });
      });
      // Regression guard: apiKey must be populated — not empty string (which happens when
      // snake_case keys like api_key are silently dropped by mem0 OSS camelCase validation).
      // Only assert for non-ollama providers that actually use an apiKey.
      if (name !== 'ollama') {
        const apiKey = mem?.config?.embedder?.config?.apiKey;
        assert.ok(
          typeof apiKey === 'string' && apiKey.length > 0,
          `embedderConfig from ${name}: expected mem.config.embedder.config.apiKey to be populated, got: ${JSON.stringify(apiKey)}`,
        );
      }
    });
  });
}

for (const name of Object.keys(FACTS_BACKENDS)) {
  test(`mem0 Memory accepts factsLlmConfig from ${name}`, () => {
    const env = {
      UM_FACTS_PROVIDER: name, UM_EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: TEST_OPENAI_KEY,
      UM_ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY,
      ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY,
      GOOGLE_API_KEY: 'AIza-test-1234567890abcdef', OLLAMA_HOST: 'http://localhost:11434',
    };
    withEnv({ OPENAI_API_KEY: TEST_OPENAI_KEY, ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY }, () => {
      const llm = getFactsLlmConfig(env);
      let mem;
      assert.doesNotThrow(() => {
        mem = new Memory({ embedder: getEmbedderConfig({ ...env, UM_EMBEDDING_PROVIDER: 'openai' }), llm });
      });
      // Regression guard: apiKey must be populated for non-ollama providers.
      // Mirrors the embedder guard above — detects snake_case-to-camelCase drift in mem0 OSS.
      if (name !== 'ollama') {
        const apiKey = mem?.config?.llm?.config?.apiKey;
        assert.ok(
          typeof apiKey === 'string' && apiKey.length > 0,
          `factsLlmConfig from ${name}: expected mem.config.llm.config.apiKey populated, got: ${JSON.stringify(apiKey)}`,
        );
      }
    });
  });
}
