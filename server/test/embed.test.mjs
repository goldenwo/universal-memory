import test from 'node:test';
import assert from 'node:assert/strict';
import { EMBEDDING_BACKENDS, getEmbedderConfig } from '../lib/embed.mjs';
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
