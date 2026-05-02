import test from 'node:test';
import assert from 'node:assert/strict';
import * as openai from '../../lib/provider/openai.mjs';

test('exports providerName and supports table', () => {
  assert.equal(openai.providerName, 'openai');
  assert.deepEqual(openai.supports, { embeddings: true, summarizer: true, facts: true });
});

test('defaults exposes all three surfaces', () => {
  assert.equal(openai.defaults.summarizerModel, 'gpt-4o-mini');
  assert.equal(openai.defaults.embeddingModel, 'text-embedding-3-small');
  assert.equal(openai.defaults.embeddingDim, 1536);
  assert.equal(openai.defaults.factsModel, 'gpt-4.1-nano-2025-04-14');
});

test('requires lists UM_-prefixed first, then standard', () => {
  assert.deepEqual(openai.requires, ['UM_OPENAI_API_KEY', 'OPENAI_API_KEY']);
});

test('resolveApiKey walks requires in order', () => {
  assert.equal(openai.resolveApiKey({ OPENAI_API_KEY: 'sk-1' }), 'sk-1');
  assert.equal(openai.resolveApiKey({ UM_OPENAI_API_KEY: 'sk-2', OPENAI_API_KEY: 'sk-1' }), 'sk-2');
  assert.equal(openai.resolveApiKey({}), null);
});

test('validateKeyFormat enforces sk-* prefix', () => {
  assert.equal(openai.validateKeyFormat('sk-abc'), true);
  assert.equal(openai.validateKeyFormat('not-a-key'), false);
});

test('embedderConfig emits mem0 block from env', () => {
  const env = { UM_EMBEDDING_MODEL: 'text-embedding-3-large', OPENAI_API_KEY: 'sk-x' };
  const cfg = openai.embedderConfig(env);
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.config.model, 'text-embedding-3-large');
  assert.equal(cfg.config.apiKey, 'sk-x');
});

test('factsLlmConfig emits mem0 llm block from env', () => {
  const cfg = openai.factsLlmConfig({ UM_FACTS_MODEL: 'gpt-4.1-nano-2025-04-14', OPENAI_API_KEY: 'sk-x' });
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.config.model, 'gpt-4.1-nano-2025-04-14');
});

test('extractUsage parses OpenAI response shape', () => {
  const raw = { usage: { prompt_tokens: 10, completion_tokens: 20 } };
  assert.deepEqual(openai.extractUsage(raw), { tokensIn: 10, tokensOut: 20 });
});

test('normalizeError strips headers and URL', () => {
  const err = {
    status: 401,
    message: 'unauthorized',
    config: { url: 'https://api.openai.com/v1/embeddings', headers: { authorization: 'Bearer sk-leak' } },
    response: { headers: { 'x-foo': 'bar' }, data: { error: 'bad key' } },
  };
  const out = openai.normalizeError(err);
  assert.equal(out.status, 401);
  assert.equal(out.message, 'unauthorized');
  assert.equal(out.config, undefined);
  assert.equal(out.response, undefined);
});

test('summarizerInvoke calls injected client and returns shaped result', async () => {
  const fakeClient = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: 'summary' } }], usage: { prompt_tokens: 5, completion_tokens: 7 } }) } },
  };
  const result = await openai.summarizerInvoke('prompt', { client: fakeClient, model: 'gpt-4o-mini' });
  assert.equal(result.content, 'summary');
  assert.deepEqual(result.usage, { tokensIn: 5, tokensOut: 7 });
});

test('factsLlmConfig apiKey is populated from env', () => {
  const cfg = openai.factsLlmConfig({ UM_FACTS_MODEL: 'gpt-4.1-nano-2025-04-14', OPENAI_API_KEY: 'sk-x' });
  assert.equal(cfg.config.apiKey, 'sk-x');
});

test('summarizerInvoke without client and without key throws ProviderError PROVIDER_CONFIG', async () => {
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => openai.summarizerInvoke('p', { env: {} }),
    (err) => {
      assert(err instanceof ProviderError, `expected ProviderError, got ${err?.constructor?.name}`);
      assert.equal(err.class, 'PROVIDER_CONFIG');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('embed calls injected client and returns { vector, usage }', async () => {
  const fakeClient = {
    embeddings: {
      create: async () => ({
        data: [{ embedding: new Array(1536).fill(0.1) }],
        usage: { prompt_tokens: 7 },
      }),
    },
  };
  const result = await openai.embed('hello world', { client: fakeClient, model: 'text-embedding-3-small' });
  assert.equal(result.vector.length, 1536);
  assert.equal(result.usage.tokensIn, 7);
  assert.equal(result.usage.tokensOut, 0);  // embeddings have no completion tokens
});

test('embed UM_TEST_MOCK_SDK=1 short-circuits to canned vector', async () => {
  const result = await openai.embed('any text', { env: { UM_TEST_MOCK_SDK: '1' }, model: 'text-embedding-3-small' });
  assert.equal(result.vector.length, 1536);  // openai default dim
  assert.deepEqual(result.usage, { tokensIn: 5, tokensOut: 0 });
});

test('embed without client and without key throws ProviderError PROVIDER_CONFIG', async () => {
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => openai.embed('p', { env: {} }),
    (err) => {
      assert(err instanceof ProviderError);
      assert.equal(err.class, 'PROVIDER_CONFIG');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('embed wraps SDK 429 as PROVIDER_RATELIMIT, retryable:true', async () => {
  const fakeClient = {
    embeddings: {
      create: async () => { throw Object.assign(new Error('rate limit'), { status: 429 }); },
    },
  };
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => openai.embed('p', { client: fakeClient }),
    (err) => {
      assert(err instanceof ProviderError);
      assert.equal(err.class, 'PROVIDER_RATELIMIT');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});
