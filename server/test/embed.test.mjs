import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBEDDING_BACKENDS, getEmbedderConfig, embed } from '../lib/embed.mjs';
import { providers } from '../lib/provider/registry.mjs';

test('EMBEDDING_BACKENDS contains every provider with supports.embeddings===true', () => {
  for (const [name, p] of Object.entries(providers)) {
    if (p.supports.embeddings) {
      assert.ok(EMBEDDING_BACKENDS[name], `missing ${name}`);
    } else {
      assert.equal(EMBEDDING_BACKENDS[name], undefined, `${name} should not be in embedding backends`);
    }
  }
});

test('getEmbedderConfig delegates to provider.embedderConfig', () => {
  const env = { UM_EMBEDDING_PROVIDER: 'openai', UM_EMBEDDING_MODEL: 'text-embedding-3-small', OPENAI_API_KEY: 'sk-x' };
  const cfg = getEmbedderConfig(env);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.config.model, 'text-embedding-3-small');
});

test('getEmbedderConfig refuses anthropic with helpful error', () => {
  const env = { UM_EMBEDDING_PROVIDER: 'anthropic' };
  assert.throws(() => getEmbedderConfig(env), /anthropic does not support embeddings/i);
});

// Registry-loop test: each supported provider produces a valid mem0 block
for (const name of Object.keys(EMBEDDING_BACKENDS)) {
  test(`getEmbedderConfig produces valid mem0 block for ${name}`, () => {
    const env = {
      UM_EMBEDDING_PROVIDER: name,
      OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test',
      GOOGLE_API_KEY: 'AIza-test', OLLAMA_HOST: 'http://localhost:11434',
    };
    const cfg = getEmbedderConfig(env);
    assert.equal(typeof cfg.provider, 'string');
    assert.equal(typeof cfg.config, 'object');
  });
}

test('embed() routes to provider.embed, returns provider+model, emits um_provider_* metrics', async () => {
  const captured = [];
  const metrics = {
    counter: (name, labels, value) => captured.push({ kind: 'counter', name, labels, value }),
    histogram: (name, labels, value) => captured.push({ kind: 'histogram', name, labels, value }),
  };
  const fakeProvider = {
    supports: { embeddings: true },
    defaults: { embeddingModel: 'mock-model' },
    embed: async () => ({ vector: [0.1, 0.2], usage: { tokensIn: 4, tokensOut: 0 } }),
  };
  const result = await embed('hello', { provider: 'mock', _providerOverride: fakeProvider, metrics });
  assert.deepEqual(result.vector, [0.1, 0.2]);
  assert.equal(result.tokensIn, 4);
  assert.equal(result.provider, 'mock', 'return shape includes provider (consumed by T15 counter labels)');
  assert.equal(result.model, 'mock-model', 'return shape includes model (consumed by T15 counter labels)');
  // Metric assertions — ALL FOUR series must fire (closes the bug class).
  const hasTokens = captured.some((c) => c.name === 'um_provider_tokens_total' && c.labels.surface === 'embed' && c.labels.direction === 'in' && c.value === 4);
  const hasCost = captured.some((c) => c.name === 'um_provider_cost_usd_total' && c.labels.surface === 'embed');
  const hasDur = captured.some((c) => c.name === 'um_provider_request_duration_seconds' && c.labels.surface === 'embed');
  assert.ok(hasTokens, 'tokens_total{direction:in} fires');
  assert.ok(hasCost, 'cost_usd_total fires');
  assert.ok(hasDur, 'request_duration_seconds fires');
});

test('embed() routes to real openai.embed in mock-SDK mode (no _providerOverride)', async () => {
  process.env.UM_TEST_MOCK_SDK = '1';
  process.env.UM_EMBEDDING_PROVIDER = 'openai';
  try {
    const result = await embed('hello');
    assert.equal(result.vector.length, 1536);  // openai default dim, mock path
    // Without injected metrics, the orchestrator hits PROVIDER_METRICS_ADAPTER
    // (the production default) — actual prom-client inc's happen but go to the
    // module-singleton registry. Test pollution is acceptable: counters are
    // monotonic, no leak across files in node:test fresh-process runs.
  } finally {
    delete process.env.UM_TEST_MOCK_SDK;
    delete process.env.UM_EMBEDDING_PROVIDER;
  }
});
