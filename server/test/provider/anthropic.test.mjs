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

// --- #181 cross-provider prompt sync: call-site + temperature contract ---------

test('factsInvoke sends the shared policy prompt as system and pins temperature 0 by default (#181 sync)', async () => {
  const { FACTS_SYSTEM_PROMPT } = await import('../../lib/provider/facts-prompt.mjs');
  let seen = null;
  const fakeClient = {
    messages: { create: async (args) => {
      seen = args;
      return { content: [{ type: 'text', text: '{"facts": []}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } },
  };
  await anthropic.factsInvoke('any text', { client: fakeClient });
  assert.equal(seen.system, FACTS_SYSTEM_PROMPT);
  assert.equal(seen.temperature, 0); // prod passes no temperature → deterministic default
});

test('factsInvoke honors an explicit temperature override (overridable default, not a hardcoded literal)', async () => {
  let seen = null;
  const fakeClient = {
    messages: { create: async (args) => {
      seen = args;
      return { content: [{ type: 'text', text: '{"facts": []}' }], usage: { input_tokens: 1, output_tokens: 1 } };
    } },
  };
  await anthropic.factsInvoke('any text', { client: fakeClient, temperature: 0.7 });
  assert.equal(seen.temperature, 0.7);
});

// --- Haiku 5.5: model-capability table (sampling params, thinking, effort) ---------

function capturingClient(content = [{ type: 'text', text: '{"facts": []}' }], extra = {}) {
  const calls = [];
  return {
    calls,
    messages: { create: async (args) => {
      calls.push(args);
      return { content, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', ...extra };
    } },
  };
}

test('capabilitiesFor: Haiku 5.5 rejects sampling params and thinks adaptively; unlisted models keep the legacy shape', () => {
  assert.deepEqual(anthropic.capabilitiesFor('claude-haiku-5-5'), { samplingParams: false, adaptiveThinking: true, effort: true });
  const legacy = { samplingParams: true, adaptiveThinking: false, effort: false };
  assert.deepEqual(anthropic.capabilitiesFor('claude-haiku-4-5-20251001'), legacy);
  assert.deepEqual(anthropic.capabilitiesFor('claude-sonnet-4-6'), legacy);
  assert.deepEqual(anthropic.capabilitiesFor('some-future-model'), legacy);
});

test('factsInvoke on Haiku 5.5 drops temperature even when the caller passes 0 explicitly (a non-default value is a 400)', async () => {
  const client = capturingClient();
  await anthropic.factsInvoke('t', { client, model: 'claude-haiku-5-5', temperature: 0 });
  assert.equal('temperature' in client.calls[0], false);
});

test('factsInvoke on Haiku 5.5 runs adaptive thinking at effort low, with max_tokens headroom above the 1024-token answer', async () => {
  const client = capturingClient();
  await anthropic.factsInvoke('t', { client, model: 'claude-haiku-5-5' });
  const req = client.calls[0];
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.equal('thinking' in req, false, 'adaptive is the model default; nothing to send');
  assert.ok(req.max_tokens >= 1024 + 4096, `max_tokens ${req.max_tokens} leaves no room for thinking`);
});

test('factsInvoke on Haiku 5.5 honors effort and thinking overrides (eval arms); disabled thinking needs no headroom', async () => {
  const client = capturingClient();
  await anthropic.factsInvoke('t', { client, model: 'claude-haiku-5-5', effort: 'medium', thinking: 'disabled' });
  const req = client.calls[0];
  assert.deepEqual(req.output_config, { effort: 'medium' });
  assert.deepEqual(req.thinking, { type: 'disabled' });
  assert.equal(req.max_tokens, 1024);
});

test('factsInvoke on Haiku 4.5 sends exactly the pre-5.5 request; effort/thinking overrides are ignored there', async () => {
  const { FACTS_SYSTEM_PROMPT } = await import('../../lib/provider/facts-prompt.mjs');
  const client = capturingClient();
  await anthropic.factsInvoke('t', { client, model: 'claude-haiku-4-5-20251001', effort: 'low', thinking: 'disabled' });
  assert.deepEqual(client.calls[0], {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    temperature: 0,
    system: FACTS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: 't' }],
  });
});

test('factsInvoke reads the text block after a leading thinking block, and returns the stop reason', async () => {
  const client = capturingClient([
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"facts": ["fact A"]}' },
  ]);
  const result = await anthropic.factsInvoke('t', { client, model: 'claude-haiku-5-5' });
  assert.deepEqual(result.facts, ['fact A']);
  assert.equal(result.stopReason, 'end_turn');
});

test('factsInvoke surfaces a thinking-only max_tokens stop as stopReason, not as a silent clean abstention', async () => {
  const client = capturingClient([{ type: 'thinking', thinking: '', signature: 'sig' }], { stop_reason: 'max_tokens' });
  const result = await anthropic.factsInvoke('t', { client, model: 'claude-haiku-5-5' });
  assert.deepEqual(result.facts, []);
  assert.equal(result.stopReason, 'max_tokens');
});

test('summarizerInvoke on Haiku 5.5 reads past a thinking block and leaves room for thinking', async () => {
  const client = capturingClient([
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: 'summary' },
  ]);
  const result = await anthropic.summarizerInvoke('p', { client, model: 'claude-haiku-5-5' });
  assert.equal(result.content, 'summary');
  assert.ok(client.calls[0].max_tokens >= 1024 + 4096);
  assert.equal('temperature' in client.calls[0], false);
});

test('contradictionJudgeInvoke drops temperature 0 on Haiku 5.5 and keeps it on Haiku 4.5', async () => {
  const content = [{ type: 'text', text: '{"contradicts": false, "confidence": 0.1, "reasoning": "r"}' }];
  const c55 = capturingClient([{ type: 'thinking', thinking: '', signature: 'sig' }, ...content]);
  const r55 = await anthropic.contradictionJudgeInvoke('p', { client: c55, model: 'claude-haiku-5-5' });
  assert.equal('temperature' in c55.calls[0], false);
  assert.equal(r55.content, content[0].text);
  const c45 = capturingClient(content);
  await anthropic.contradictionJudgeInvoke('p', { client: c45, model: 'claude-haiku-4-5-20251001' });
  assert.equal(c45.calls[0].temperature, 0);
  assert.equal(c45.calls[0].max_tokens, 1024);
});

test('factsInvoke reports parseOk: false for a malformed reply and true for a clean empty one', async () => {
  const bad = await anthropic.factsInvoke('t', { client: capturingClient([{ type: 'text', text: 'not json' }]), model: 'claude-haiku-5-5' });
  assert.deepEqual(bad.facts, []);
  assert.equal(bad.parseOk, false);
  const empty = await anthropic.factsInvoke('t', { client: capturingClient([{ type: 'text', text: '{"facts": []}' }]), model: 'claude-haiku-5-5' });
  assert.deepEqual(empty.facts, []);
  assert.equal(empty.parseOk, true);
});
