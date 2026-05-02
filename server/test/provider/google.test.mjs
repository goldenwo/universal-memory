import test from 'node:test';
import assert from 'node:assert/strict';
import * as google from '../../lib/provider/google.mjs';

test('exports providerName and supports table', () => {
  assert.equal(google.providerName, 'google');
  assert.deepEqual(google.supports, { embeddings: true, summarizer: true, facts: true });
});

test('defaults exposes all four surfaces', () => {
  assert.equal(google.defaults.summarizerModel, 'gemini-2.0-flash');
  assert.equal(google.defaults.embeddingModel, 'text-embedding-004');
  assert.equal(google.defaults.embeddingDim, 768);
  assert.equal(google.defaults.factsModel, 'gemini-2.0-flash');
});

test('requires lists three keys in precedence order', () => {
  assert.deepEqual(google.requires, ['UM_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']);
});

test('Google three-key resolution precedence', () => {
  assert.equal(google.resolveApiKey({ GEMINI_API_KEY: 'AIza-3' }), 'AIza-3');
  assert.equal(google.resolveApiKey({ GOOGLE_API_KEY: 'AIza-2', GEMINI_API_KEY: 'AIza-3' }), 'AIza-2');
  assert.equal(google.resolveApiKey({ UM_GOOGLE_API_KEY: 'AIza-1', GOOGLE_API_KEY: 'AIza-2', GEMINI_API_KEY: 'AIza-3' }), 'AIza-1');
  assert.equal(google.resolveApiKey({}), null);
});

test('validateKeyFormat enforces AIza prefix', () => {
  assert.equal(google.validateKeyFormat('AIza-abc'), true);
  assert.equal(google.validateKeyFormat('sk-abc'), false);
  assert.equal(google.validateKeyFormat('not-a-key'), false);
});

test('embedderConfig emits mem0 block from env', () => {
  const env = { UM_EMBEDDING_MODEL: 'text-embedding-004-preview', GOOGLE_API_KEY: 'AIza-x' };
  const cfg = google.embedderConfig(env);
  assert.equal(cfg.provider, 'google');
  assert.equal(cfg.config.model, 'text-embedding-004-preview');
  assert.equal(cfg.config.apiKey, 'AIza-x');
});

test('factsLlmConfig emits mem0 llm block from env', () => {
  const cfg = google.factsLlmConfig({ UM_FACTS_MODEL: 'gemini-2.0-flash', GOOGLE_API_KEY: 'AIza-x' });
  assert.equal(cfg.provider, 'google');
  assert.equal(cfg.config.model, 'gemini-2.0-flash');
  assert.equal(cfg.config.apiKey, 'AIza-x');
});

test('summarizerInvoke without client and without key throws ProviderError PROVIDER_CONFIG', async () => {
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => google.summarizerInvoke('p', { env: {} }),
    (err) => {
      assert(err instanceof ProviderError, `expected ProviderError, got ${err?.constructor?.name}`);
      assert.equal(err.class, 'PROVIDER_CONFIG');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('extractUsage parses Google response shape', () => {
  const raw = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 } };
  assert.deepEqual(google.extractUsage(raw), { tokensIn: 10, tokensOut: 20 });
});

test('normalizeError strips Google query-param key from URL', () => {
  const err = {
    status: 400,
    message: 'bad request',
    config: { url: 'https://generativelanguage.googleapis.com/v1/embed?key=AIza-LEAK', params: { key: 'AIza-LEAK' } },
  };
  const out = google.normalizeError(err);
  assert.equal(out.config, undefined);
  assert.equal(out.params, undefined);
  assert.ok(!JSON.stringify(out).includes('AIza-LEAK'));
});

test('summarizerInvoke calls injected client and returns shaped result', async () => {
  const fakeClient = {
    models: {
      generateContent: async () => ({
        text: 'summary',
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      }),
    },
  };
  const result = await google.summarizerInvoke('prompt', { client: fakeClient, model: 'gemini-2.0-flash' });
  assert.equal(result.content, 'summary');
  assert.deepEqual(result.usage, { tokensIn: 5, tokensOut: 7 });
});

test('summarizerInvoke nests systemInstruction inside config (1.x SDK shape)', async () => {
  let captured;
  const fakeClient = {
    models: {
      generateContent: async (params) => {
        captured = params;
        return { text: 'ok', usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      },
    },
  };
  await google.summarizerInvoke('p', { client: fakeClient, model: 'gemini-2.0-flash', systemPrompt: 'be terse' });
  assert.equal(captured.systemInstruction, undefined, 'must NOT be at top level (silently dropped by 1.x SDK)');
  assert.equal(captured.config?.systemInstruction, 'be terse', 'must be inside config block');
});

test('embed calls injected client and returns { vector, usage }', async () => {
  const fakeClient = {
    models: {
      embedContent: async () => ({
        embeddings: [{ values: new Array(768).fill(0.2) }],
        // Google's response shape — usage may not be present on embed responses;
        // confirm against the SDK and adjust if needed.
      }),
    },
  };
  const result = await google.embed('hello', { client: fakeClient, model: 'text-embedding-004' });
  assert.equal(result.vector.length, 768);
  assert.equal(result.usage.tokensIn, 0);  // google embed API doesn't return tokenCount on every model
});

test('embed UM_TEST_MOCK_SDK=1 short-circuits to canned vector', async () => {
  const result = await google.embed('text', { env: { UM_TEST_MOCK_SDK: '1' } });
  assert.equal(result.vector.length, 768);  // google default dim
  assert.deepEqual(result.usage, { tokensIn: 5, tokensOut: 0 });
});

test('embed without client and without key throws ProviderError PROVIDER_CONFIG', async () => {
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => google.embed('p', { env: {} }),
    (err) => err instanceof ProviderError && err.class === 'PROVIDER_CONFIG',
  );
});
