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
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory } from 'mem0ai/oss';
import { EMBEDDING_BACKENDS, getEmbedderConfig } from '../lib/embed.mjs';
import { FACTS_BACKENDS, getFactsLlmConfig } from '../lib/facts.mjs';

// For each provider, asserting Memory constructor accepts the config block.
// Live calls are NOT made — this is a config-shape compatibility test.
for (const name of Object.keys(EMBEDDING_BACKENDS)) {
  test(`mem0 Memory accepts embedderConfig from ${name}`, () => {
    const env = {
      UM_EMBEDDING_PROVIDER: name,
      OPENAI_API_KEY: 'sk-test-1234567890abcdef',
      UM_ANTHROPIC_API_KEY: 'sk-ant-test-1234567890abcdef',
      ANTHROPIC_API_KEY: 'sk-ant-test-1234567890abcdef',
      GOOGLE_API_KEY: 'AIza-test-1234567890abcdef', OLLAMA_HOST: 'http://localhost:11434',
    };
    // Set environment variables for mem0's constructor validation
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.OPENAI_API_KEY = 'sk-test-1234567890abcdef';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-1234567890abcdef';
    try {
      const embedder = getEmbedderConfig(env);
      // Constructor should not throw — we don't actually run any operations.
      assert.doesNotThrow(() => new Memory({ embedder, llm: getFactsLlmConfig({ ...env, UM_FACTS_PROVIDER: 'openai' }) }));
    } finally {
      process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    }
  });
}

for (const name of Object.keys(FACTS_BACKENDS)) {
  test(`mem0 Memory accepts factsLlmConfig from ${name}`, () => {
    const env = {
      UM_FACTS_PROVIDER: name, UM_EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-1234567890abcdef',
      UM_ANTHROPIC_API_KEY: 'sk-ant-test-1234567890abcdef',
      ANTHROPIC_API_KEY: 'sk-ant-test-1234567890abcdef',
      GOOGLE_API_KEY: 'AIza-test-1234567890abcdef', OLLAMA_HOST: 'http://localhost:11434',
    };
    // Set environment variables for mem0's constructor validation
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
    process.env.OPENAI_API_KEY = 'sk-test-1234567890abcdef';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-1234567890abcdef';
    try {
      const llm = getFactsLlmConfig(env);
      assert.doesNotThrow(() => new Memory({ embedder: getEmbedderConfig({ ...env, UM_EMBEDDING_PROVIDER: 'openai' }), llm }));
    } finally {
      process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    }
  });
}
