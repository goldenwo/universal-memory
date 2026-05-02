import test from 'node:test';
import assert from 'node:assert/strict';
import * as anthropic from '../../lib/provider/anthropic.mjs';

test('exports providerName and supports table', () => {
  assert.equal(anthropic.providerName, 'anthropic');
  assert.deepEqual(anthropic.supports, { embeddings: false, summarizer: true, facts: true });
});

test('embedderConfig is literal null (not a function) — spec §3.2 unsupported-surface contract', () => {
  assert.equal(anthropic.embedderConfig, null);
  assert.equal(typeof anthropic.embedderConfig, 'object');
});

test('defaults exposes summarizer + facts models (no embedding fields)', () => {
  assert.equal(anthropic.defaults.summarizerModel, 'claude-haiku-4-5-20251001');
  assert.equal(anthropic.defaults.factsModel, 'claude-haiku-4-5-20251001');
  assert.equal(anthropic.defaults.embeddingModel, undefined);
  assert.equal(anthropic.defaults.embeddingDim, undefined);
});

test('requires lists UM_-prefixed first, then standard', () => {
  assert.deepEqual(anthropic.requires, ['UM_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY']);
});

test('resolveApiKey walks requires in order', () => {
  assert.equal(anthropic.resolveApiKey({ ANTHROPIC_API_KEY: 'sk-ant-1' }), 'sk-ant-1');
  assert.equal(anthropic.resolveApiKey({ UM_ANTHROPIC_API_KEY: 'sk-ant-2', ANTHROPIC_API_KEY: 'sk-ant-1' }), 'sk-ant-2');
  assert.equal(anthropic.resolveApiKey({}), null);
});

test('validateKeyFormat enforces sk-ant- prefix', () => {
  assert.equal(anthropic.validateKeyFormat('sk-ant-abc'), true);
  assert.equal(anthropic.validateKeyFormat('sk-abc'), false);
  assert.equal(anthropic.validateKeyFormat('not-a-key'), false);
});

test('factsLlmConfig emits mem0 llm block from env', () => {
  const cfg = anthropic.factsLlmConfig({ UM_FACTS_MODEL: 'claude-haiku-4-5-20251001', ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.equal(cfg.provider, 'anthropic');
  assert.equal(cfg.config.model, 'claude-haiku-4-5-20251001');
});

test('extractUsage parses Anthropic response shape (input_tokens/output_tokens)', () => {
  const raw = { usage: { input_tokens: 10, output_tokens: 20 } };
  assert.deepEqual(anthropic.extractUsage(raw), { tokensIn: 10, tokensOut: 20 });
});

test('normalizeError strips x-api-key from headers', () => {
  const err = {
    status: 401,
    message: 'unauthorized',
    config: { url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': 'sk-ant-LEAK' } },
    request: { headers: { 'x-api-key': 'sk-ant-LEAK' } },
    response: { headers: { 'x-foo': 'bar' }, data: { error: 'bad key' } },
  };
  const out = anthropic.normalizeError(err);
  assert.equal(out.status, 401);
  assert.equal(out.message, 'unauthorized');
  assert.equal(out.config, undefined);
  assert.equal(out.request, undefined);
  assert.equal(out.response, undefined);
  assert.equal(JSON.stringify(out).includes('sk-ant-LEAK'), false);
});

test('factsLlmConfig apiKey is populated from env', () => {
  const cfg = anthropic.factsLlmConfig({ UM_FACTS_MODEL: 'claude-haiku-4-5-20251001', ANTHROPIC_API_KEY: 'sk-ant-x' });
  assert.equal(cfg.config.apiKey, 'sk-ant-x');
});

test('summarizerInvoke without client and without key throws ProviderError PROVIDER_CONFIG', async () => {
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => anthropic.summarizerInvoke('p', { env: {} }),
    (err) => {
      assert(err instanceof ProviderError, `expected ProviderError, got ${err?.constructor?.name}`);
      assert.equal(err.class, 'PROVIDER_CONFIG');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('summarizerInvoke wraps Anthropic SDK shape; throws ProviderError on 429', async () => {
  const fakeClient = {
    messages: {
      create: async () => ({
        content: [{ text: 'summary' }],
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    },
  };
  const result = await anthropic.summarizerInvoke('prompt', { client: fakeClient, model: 'claude-haiku-4-5-20251001' });
  assert.equal(result.content, 'summary');
  assert.deepEqual(result.usage, { tokensIn: 5, tokensOut: 7 });

  // Test rate limit error
  const fakeClientRateLimit = {
    messages: {
      create: async () => {
        const err = new Error('Rate limit');
        err.status = 429;
        err.response = { status: 429 };
        throw err;
      },
    },
  };
  const ProviderError = (await import('../../lib/provider/errors.mjs')).ProviderError;
  try {
    await anthropic.summarizerInvoke('prompt', { client: fakeClientRateLimit, model: 'claude-haiku-4-5-20251001' });
    assert.fail('should have thrown');
  } catch (err) {
    assert(err instanceof ProviderError);
    assert.equal(err.class, 'PROVIDER_RATELIMIT');
    assert.equal(err.retryable, true);
  }
});

test('factsInvoke calls injected client and returns { facts: string[], usage }', async () => {
  const fakeClient = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: '{"facts": ["fact A", "fact B"]}' }],
        usage: { input_tokens: 30, output_tokens: 10 },
      }),
    },
  };
  const result = await anthropic.factsInvoke('input', { client: fakeClient, model: 'claude-haiku-4-5-20251001' });
  assert.deepEqual(result.facts, ['fact A', 'fact B']);
  assert.deepEqual(result.usage, { tokensIn: 30, tokensOut: 10 });
});

test('factsInvoke UM_TEST_MOCK_SDK=1 short-circuits', async () => {
  const result = await anthropic.factsInvoke('text', { env: { UM_TEST_MOCK_SDK: '1' } });
  assert.ok(Array.isArray(result.facts) && result.facts.length >= 1);
  assert.deepEqual(result.usage, { tokensIn: 10, tokensOut: 5 });
});

test('factsInvoke handles malformed JSON by returning empty facts', async () => {
  const fakeClient = {
    messages: { create: async () => ({
      content: [{ type: 'text', text: 'not json' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    }) },
  };
  const result = await anthropic.factsInvoke('text', { client: fakeClient });
  assert.deepEqual(result.facts, []);
});

test('anthropic does NOT export embed (per spec §4.2)', () => {
  assert.equal(anthropic.embed, undefined, 'anthropic must not export embed — it has no embeddings API');
});
