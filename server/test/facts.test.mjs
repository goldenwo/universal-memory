import test from 'node:test';
import assert from 'node:assert/strict';
import { FACTS_BACKENDS, getFactsLlmConfig } from '../lib/facts.mjs';
import { providers, supportingProviders } from '../lib/provider/registry.mjs';

test('FACTS_BACKENDS contains every provider with supports.facts===true (all 4)', () => {
  const expected = supportingProviders('facts').sort();
  const actual = Object.keys(FACTS_BACKENDS).sort();
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 4, 'all 4 providers should support facts');
});

test('getFactsLlmConfig delegates to provider.factsLlmConfig', () => {
  const env = { UM_FACTS_PROVIDER: 'openai', UM_FACTS_MODEL: 'gpt-4.1-nano-2025-04-14', OPENAI_API_KEY: 'sk-x' };
  const cfg = getFactsLlmConfig(env);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.config.model, 'gpt-4.1-nano-2025-04-14');
});

// Registry-loop test: each supported provider produces a valid mem0 llm block
for (const name of Object.keys(FACTS_BACKENDS)) {
  test(`getFactsLlmConfig produces valid mem0 llm block for ${name}`, () => {
    const env = {
      UM_FACTS_PROVIDER: name,
      OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test',
      GOOGLE_API_KEY: 'AIza-test', OLLAMA_HOST: 'http://localhost:11434',
    };
    const cfg = getFactsLlmConfig(env);
    assert.equal(typeof cfg.provider, 'string');
    assert.equal(typeof cfg.config, 'object');
    assert.equal(cfg.provider, name);
  });
}

test('getFactsLlmConfig refuses unknown provider', () => {
  assert.throws(() => getFactsLlmConfig({ UM_FACTS_PROVIDER: 'bogus' }), /unknown provider/i);
});

test('anthropic IS supported for facts (unlike embeddings)', () => {
  const env = { UM_FACTS_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' };
  assert.doesNotThrow(() => getFactsLlmConfig(env));
});
