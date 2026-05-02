import test from 'node:test';
import assert from 'node:assert/strict';
import { FACTS_BACKENDS, getFactsLlmConfig, facts } from '../lib/facts.mjs';
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

test('facts() routes to provider.factsInvoke and emits um_provider_* metrics', async () => {
  const captured = [];
  const metrics = {
    counter: (name, labels, value) => captured.push({ kind: 'counter', name, labels, value }),
    histogram: (name, labels, value) => captured.push({ kind: 'histogram', name, labels, value }),
  };
  const fakeProvider = {
    supports: { facts: true },
    defaults: { factsModel: 'mock-facts-model' },
    factsInvoke: async () => ({ facts: ['f1', 'f2'], usage: { tokensIn: 10, tokensOut: 3 } }),
  };
  const result = await facts('text', { provider: 'mock', _providerOverride: fakeProvider, metrics });
  assert.deepEqual(result.facts, ['f1', 'f2']);
  assert.equal(result.tokensIn, 10);
  assert.equal(result.tokensOut, 3);
  assert.equal(result.provider, 'mock', 'return shape includes provider for downstream label use (T15)');
  assert.equal(result.model, 'mock-facts-model', 'return shape includes model for downstream label use (T15)');
  // ALL FOUR metric series fire on success path.
  const hasTokens = captured.some((c) => c.name === 'um_provider_tokens_total' && c.labels.surface === 'facts' && c.labels.direction === 'in' && c.value === 10);
  const hasCost = captured.some((c) => c.name === 'um_provider_cost_usd_total' && c.labels.surface === 'facts');
  const hasDur = captured.some((c) => c.name === 'um_provider_request_duration_seconds' && c.labels.surface === 'facts');
  assert.ok(hasTokens && hasCost && hasDur);
});
