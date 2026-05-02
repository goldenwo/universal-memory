import test from 'node:test';
import assert from 'node:assert/strict';
import * as ollama from '../../lib/provider/ollama.mjs';

test('exports providerName and supports table', () => {
  assert.equal(ollama.providerName, 'ollama');
  assert.deepEqual(ollama.supports, { embeddings: true, summarizer: true, facts: true });
});

test('defaults exposes all four fields (summarizerModel, embeddingModel, embeddingDim, factsModel)', () => {
  assert.equal(ollama.defaults.summarizerModel, 'llama3');
  assert.equal(ollama.defaults.embeddingModel, 'nomic-embed-text');
  assert.equal(ollama.defaults.embeddingDim, 768);
  assert.equal(ollama.defaults.factsModel, 'llama3');
});

test('requires is empty array (no API keys needed)', () => {
  assert.deepEqual(ollama.requires, []);
});

test('validateKeyFormat returns true unconditionally (no key validation for local ollama)', () => {
  assert.equal(ollama.validateKeyFormat('anything'), true);
  assert.equal(ollama.validateKeyFormat(''), true);
  assert.equal(ollama.validateKeyFormat(null), true);
  assert.equal(ollama.validateKeyFormat(undefined), true);
});

test('embedderConfig emits mem0 block with baseURL from env or default', () => {
  const env1 = { UM_EMBEDDING_MODEL: 'nomic-embed-text' };
  const cfg1 = ollama.embedderConfig(env1);
  assert.equal(cfg1.provider, 'ollama');
  assert.equal(cfg1.config.model, 'nomic-embed-text');
  assert.equal(cfg1.config.baseURL, 'http://localhost:11434');

  const env2 = { OLLAMA_HOST: 'http://192.168.1.100:11434', UM_EMBEDDING_MODEL: 'custom-embed' };
  const cfg2 = ollama.embedderConfig(env2);
  assert.equal(cfg2.config.model, 'custom-embed');
  assert.equal(cfg2.config.baseURL, 'http://192.168.1.100:11434');
});

test('factsLlmConfig emits mem0 llm block with baseURL', () => {
  const env = { UM_FACTS_MODEL: 'llama3', OLLAMA_HOST: 'http://localhost:11434' };
  const cfg = ollama.factsLlmConfig(env);
  assert.equal(cfg.provider, 'ollama');
  assert.equal(cfg.config.model, 'llama3');
  assert.equal(cfg.config.baseURL, 'http://localhost:11434');
});

test('extractUsage parses Ollama response shape (prompt_eval_count → tokensIn, eval_count → tokensOut)', () => {
  const raw = { prompt_eval_count: 10, eval_count: 20 };
  assert.deepEqual(ollama.extractUsage(raw), { tokensIn: 10, tokensOut: 20 });

  const emptyRaw = {};
  assert.deepEqual(ollama.extractUsage(emptyRaw), { tokensIn: 0, tokensOut: 0 });
});

test('summarizerInvoke uses fetch to POST to /api/generate and returns shaped result', async () => {
  const fakeFetch = async (url, opts) => {
    assert(url.includes('/api/generate'));
    assert.equal(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'llama3');
    assert.equal(body.prompt, 'test prompt');
    return {
      ok: true,
      json: async () => ({ response: 'summary', prompt_eval_count: 5, eval_count: 7 }),
    };
  };
  const result = await ollama.summarizerInvoke('test prompt', { fetch: fakeFetch, host: 'http://localhost:11434', model: 'llama3' });
  assert.equal(result.content, 'summary');
  assert.deepEqual(result.usage, { tokensIn: 5, tokensOut: 7 });
});

test('probeModel returns true if model in tags response', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: 'llama3' }, { name: 'mistral' }] }),
  });
  assert.equal(await ollama.probeModel('http://localhost:11434', 'llama3', { fetch: fakeFetch }), true);
});

test('probeModel returns false if model absent', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ models: [{ name: 'mistral' }] }),
  });
  assert.equal(await ollama.probeModel('http://localhost:11434', 'llama3', { fetch: fakeFetch }), false);
});

test('probeModel throws ProviderError on host unreachable', async () => {
  const fakeFetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const ProviderError = (await import('../../lib/provider/errors.mjs')).ProviderError;
  try {
    await ollama.probeModel('http://localhost:11434', 'llama3', { fetch: fakeFetch });
    assert.fail('should have thrown');
  } catch (err) {
    assert(err instanceof ProviderError);
    assert.equal(err.class, 'PROVIDER_UPSTREAM');
    assert(err.message.includes('ECONNREFUSED') || err.message.includes('ollama'));
  }
});

test('embed calls fetch and returns { vector, usage }', async () => {
  const fakeFetch = async (url, init) => {
    assert.match(url, /\/api\/embeddings$/);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'nomic-embed-text');
    assert.equal(body.prompt, 'hello world');
    return {
      ok: true,
      json: async () => ({ embedding: new Array(768).fill(0.3) }),
    };
  };
  const result = await ollama.embed('hello world', { fetch: fakeFetch, host: 'http://localhost:11434', model: 'nomic-embed-text' });
  assert.equal(result.vector.length, 768);
  assert.deepEqual(result.usage, { tokensIn: 0, tokensOut: 0 });  // ollama embeddings don't expose tokens
});

test('embed UM_TEST_MOCK_SDK=1 short-circuits to canned vector', async () => {
  process.env.UM_TEST_MOCK_SDK = '1';
  try {
    const result = await ollama.embed('text', { fetch: () => assert.fail('should not call fetch'), model: 'nomic-embed-text' });
    assert.equal(result.vector.length, 768);
  } finally {
    delete process.env.UM_TEST_MOCK_SDK;
  }
});

test('embed wraps non-2xx response as PROVIDER_UPSTREAM', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => ollama.embed('text', { fetch: fakeFetch }),
    (err) => err instanceof ProviderError && err.class === 'PROVIDER_UPSTREAM',
  );
});

test('factsInvoke calls fetch and returns { facts: string[], usage }', async () => {
  const fakeFetch = async (url, init) => {
    assert.match(url, /\/api\/generate$/);
    const body = JSON.parse(init.body);
    assert.equal(body.system, undefined);  // we send system inline in prompt for ollama
    return {
      ok: true,
      json: async () => ({ response: '{"facts": ["o1"]}', prompt_eval_count: 20, eval_count: 6 }),
    };
  };
  const result = await ollama.factsInvoke('input', { fetch: fakeFetch });
  assert.deepEqual(result.facts, ['o1']);
  assert.deepEqual(result.usage, { tokensIn: 20, tokensOut: 6 });
});

test('factsInvoke UM_TEST_MOCK_SDK=1 short-circuits', async () => {
  process.env.UM_TEST_MOCK_SDK = '1';
  try {
    const result = await ollama.factsInvoke('text', { fetch: () => assert.fail('should not call fetch') });
    assert.ok(result.facts.length >= 1);
  } finally {
    delete process.env.UM_TEST_MOCK_SDK;
  }
});

test('factsInvoke handles malformed JSON by returning empty facts', async () => {
  const fakeFetch = async () => ({
    ok: true, json: async () => ({ response: 'not json', prompt_eval_count: 5, eval_count: 2 }),
  });
  const result = await ollama.factsInvoke('text', { fetch: fakeFetch });
  assert.deepEqual(result.facts, []);
});
