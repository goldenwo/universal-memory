import test from 'node:test';
import assert from 'node:assert/strict';
import * as openai from '../../lib/provider/openai.mjs';
import { FACTS_SYSTEM_PROMPT } from '../../lib/provider/facts-prompt.mjs';

test('exports providerName and supports table', () => {
  assert.equal(openai.providerName, 'openai');
  assert.deepEqual(openai.supports, { embeddings: true, summarizer: true, facts: true });
});

test('defaults exposes all three surfaces', () => {
  assert.equal(openai.defaults.summarizerModel, 'gpt-4o-mini');
  assert.equal(openai.defaults.embeddingModel, 'text-embedding-3-small');
  assert.equal(openai.defaults.embeddingDim, 1536);
  // gpt-4.1-nano was shut down 2026-10-23; gpt-6-luna won the pre-registered replacement
  // measurement (docs/plans/2026-10-23-model-migration/report.md).
  assert.equal(openai.defaults.factsModel, 'gpt-6-luna');
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

test('factsInvoke calls injected client and returns { facts: string[], usage }', async () => {
  const fakeClient = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: '{"facts": ["likes blue", "lives in Tokyo"]}' } }],
      usage: { prompt_tokens: 50, completion_tokens: 12 },
    }) } },
  };
  const result = await openai.factsInvoke('I like blue. I live in Tokyo.', { client: fakeClient, model: 'gpt-4.1-nano-2025-04-14' });
  assert.deepEqual(result.facts, ['likes blue', 'lives in Tokyo']);
  assert.deepEqual(result.usage, { tokensIn: 50, tokensOut: 12 });
});

test('factsInvoke returns the finish reason as stopReason (a length stop also parses to [])', async () => {
  const fakeClient = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: '{"facts": ["a"' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }) } },
  };
  const result = await openai.factsInvoke('t', { client: fakeClient });
  assert.deepEqual(result.facts, []);
  assert.equal(result.stopReason, 'length');
});

test('factsInvoke pins temperature 0 by default (deterministic extraction, matches the judges)', async () => {
  let seen = null;
  const fakeClient = {
    chat: { completions: { create: async (args) => {
      seen = args;
      return { choices: [{ message: { content: '{"facts": []}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } },
  };
  await openai.factsInvoke('any text', { client: fakeClient, model: 'gpt-4.1-nano-2025-04-14' });
  assert.equal(seen.temperature, 0); // prod passes no temperature → deterministic default
});

test('factsInvoke honors an explicit temperature override (knob preserved for diversity experiments)', async () => {
  let seen = null;
  const fakeClient = {
    chat: { completions: { create: async (args) => {
      seen = args;
      return { choices: [{ message: { content: '{"facts": []}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } },
  };
  await openai.factsInvoke('any text', { client: fakeClient, model: 'gpt-4o-mini', temperature: 0.7 });
  assert.equal(seen.temperature, 0.7); // a sampling-capable model; a luna default drops it (capability tests below)
});

test('factsInvoke UM_TEST_MOCK_SDK=1 short-circuits to canned facts', async () => {
  const result = await openai.factsInvoke('any text', { env: { UM_TEST_MOCK_SDK: '1' } });
  assert.ok(Array.isArray(result.facts));
  assert.ok(result.facts.length >= 1);
  assert.deepEqual(result.usage, { tokensIn: 10, tokensOut: 5 });
});

test('factsInvoke handles malformed JSON by returning empty facts (no throw)', async () => {
  const fakeClient = {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: 'not json at all' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }) } },
  };
  const result = await openai.factsInvoke('text', { client: fakeClient });
  assert.deepEqual(result.facts, []);  // graceful degrade — empty-facts counter (Task 15) makes this visible
});

test('factsInvoke without client and without key throws ProviderError PROVIDER_CONFIG', async () => {
  const { ProviderError } = await import('../../lib/provider/errors.mjs');
  await assert.rejects(
    () => openai.factsInvoke('p', { env: {} }),
    (err) => err instanceof ProviderError && err.class === 'PROVIDER_CONFIG',
  );
});

// --- #181 cross-provider prompt sync: call-site pin ----------------------------

test('factsInvoke sends the shared policy prompt as the system message (#181 sync)', async () => {
  const { FACTS_SYSTEM_PROMPT } = await import('../../lib/provider/facts-prompt.mjs');
  let seen = null;
  const fakeClient = {
    chat: { completions: { create: async (args) => {
      seen = args;
      return { choices: [{ message: { content: '{"facts": []}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    } } },
  };
  await openai.factsInvoke('any text', { client: fakeClient });
  assert.equal(seen.messages[0].role, 'system');
  assert.equal(seen.messages[0].content, FACTS_SYSTEM_PROMPT);
});

test('factsInvoke reports parseOk, and a populated refusal field as stopReason refusal', async () => {
  const reply = (message, finish_reason = 'stop') => ({
    chat: { completions: { create: async () => ({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) } },
  });
  const bad = await openai.factsInvoke('t', { client: reply({ content: 'not json' }) });
  assert.equal(bad.parseOk, false);
  const empty = await openai.factsInvoke('t', { client: reply({ content: '{"facts": []}' }) });
  assert.equal(empty.parseOk, true);
  assert.equal(empty.stopReason, 'stop');
  const refused = await openai.factsInvoke('t', { client: reply({ content: null, refusal: 'I cannot help with that.' }) });
  assert.deepEqual(refused.facts, []);
  assert.equal(refused.stopReason, 'refusal');
});

// ---------------------------------------------------------------------------
// Per-model request capabilities (2026-10-23 model migration, spec R1). The luna
// models reject any temperature but the default and take reasoning_effort and
// max_completion_tokens; every other model keeps today's request byte-for-byte.
// ---------------------------------------------------------------------------

const LUNA_MODELS = ['gpt-6-luna', 'gpt-5.6-luna'];
const LEGACY_MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'some-unlisted-model'];

function capturingClient(reply = '{"facts": []}') {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (args) => {
      calls.push(args);
      return {
        model: args.model,
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 3 } },
      };
    } } },
  };
}

// Each call site as production and the evals call it. The facts and grader rows pass
// the explicit knobs the eval harness passes (temperature 0, a 768-token budget).
const CALL_SITES = {
  summarizer: (client, model) => openai.summarizerInvoke('p', { client, model }),
  contradictionJudge: (client, model) => openai.contradictionJudgeInvoke('p', { client, model }),
  grader: (client, model) => openai.answerGradeInvoke('p', { client, model, maxTokens: 768 }),
  facts: (client, model) => openai.factsInvoke('p', { client, model, temperature: 0 }),
};

for (const model of LUNA_MODELS) {
  for (const [site, call] of Object.entries(CALL_SITES)) {
    test(`${site} on ${model}: drops temperature, sends reasoning_effort none and max_completion_tokens`, async () => {
      const client = capturingClient();
      await call(client, model);
      const args = client.calls[0];
      assert.equal('temperature' in args, false, 'luna rejects any temperature but the default');
      assert.equal(args.reasoning_effort, 'none');
      assert.equal('max_tokens' in args, false);
      if (site === 'grader') assert.equal(args.max_completion_tokens, 768);
    });
  }
}

test('factsInvoke on a luna model sends the caller\'s effort when one is given', async () => {
  const client = capturingClient();
  await openai.factsInvoke('p', { client, model: 'gpt-6-luna', effort: 'low' });
  assert.equal(client.calls[0].reasoning_effort, 'low');
});

for (const model of LEGACY_MODELS) {
  test(`${model}: every call site sends exactly today's request`, async () => {
    const client = capturingClient();
    await openai.summarizerInvoke('p', { client, model });
    await openai.contradictionJudgeInvoke('p', { client, model });
    await openai.answerGradeInvoke('p', { client, model, maxTokens: 768 });
    await openai.factsInvoke('p', { client, model, temperature: 0, effort: 'low' });
    const user = [{ role: 'user', content: 'p' }];
    assert.deepEqual(client.calls, [
      { model, messages: user },
      { model, temperature: 0, messages: user },
      { model, temperature: 0, max_tokens: 768, messages: user },
      { model, temperature: 0, messages: [{ role: 'system', content: FACTS_SYSTEM_PROMPT }, ...user] },
    ]);
  });
}

test('capabilitiesFor: luna entries, and the legacy shape for anything unlisted', () => {
  for (const model of LUNA_MODELS) {
    assert.deepEqual(openai.capabilitiesFor(model),
      { samplingParams: false, reasoningEffort: true, defaultEffort: 'none', completionTokens: true });
  }
  assert.deepEqual(openai.capabilitiesFor('gpt-4o-mini'),
    { samplingParams: true, reasoningEffort: false, defaultEffort: null, completionTokens: false });
});

test('factsInvoke reports the params it sent, the served model and the reasoning tokens', async () => {
  const client = capturingClient('{"facts": ["a"]}');
  const result = await openai.factsInvoke('p', { client, model: 'gpt-6-luna', temperature: 0 });
  assert.deepEqual(result.requestParams, { model: 'gpt-6-luna', reasoning_effort: 'none' });
  assert.equal(result.servedModel, 'gpt-6-luna');
  assert.equal(result.reasoningTokens, 3);
});

test('capabilitiesFor: a dated snapshot of a listed alias gets the alias\'s capabilities (model migration review)', () => {
  assert.deepEqual(openai.capabilitiesFor('gpt-6-luna-2026-11-02'), openai.capabilitiesFor('gpt-6-luna'));
  assert.deepEqual(openai.capabilitiesFor('gpt-5.6-luna-2026-09-01'), openai.capabilitiesFor('gpt-5.6-luna'));
  assert.equal(openai.capabilitiesFor('gpt-6-luna-pro').samplingParams, true, 'only a -YYYY-MM-DD suffix maps to the alias');
  assert.equal(openai.capabilitiesFor('gpt-4o-mini-2024-07-18').samplingParams, true, 'legacy stays legacy');
});

// ---------------------------------------------------------------------------
// R1 call records (model migration Phase B, spec R1): the summarizer, judge and grader
// invokes report what they sent and how the call ended, as factsInvoke does. The eval
// harnesses record them per call; production callers ignore them.
// ---------------------------------------------------------------------------

const R1_SITES = {
  summarizer: (opts) => openai.summarizerInvoke('p', opts),
  contradictionJudge: (opts) => openai.contradictionJudgeInvoke('p', opts),
  grader: (opts) => openai.answerGradeInvoke('p', { maxTokens: 768, ...opts }),
};

function recordingClient(response) {
  const calls = [];
  return { calls, chat: { completions: { create: async (args) => { calls.push(args); return response(args); } } } };
}

for (const [site, call] of Object.entries(R1_SITES)) {
  for (const model of ['gpt-6-luna', 'gpt-4o-mini']) {
    test(`${site} on ${model}: returns requestParams equal to what the client received, plus servedModel, fingerprint, reasoning tokens and stop reason`, async () => {
      const client = recordingClient((args) => ({
        model: `${args.model}-served`,
        system_fingerprint: 'fp_abc123',
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } },
      }));
      const r = await call({ client, model });
      const { messages, ...sent } = client.calls[0];
      assert.deepEqual(r.requestParams, sent);
      assert.equal(r.servedModel, `${model}-served`);
      assert.equal(r.systemFingerprint, 'fp_abc123');
      assert.equal(r.reasoningTokens, 0);
      assert.equal(r.stopReason, 'stop');
    });
  }

  test(`${site}: a populated refusal field is stopReason refusal, whatever the finish reason`, async () => {
    const client = recordingClient(() => ({
      model: 'gpt-6-luna', choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }], usage: {},
    }));
    const r = await call({ client, model: 'gpt-6-luna' });
    assert.equal(r.stopReason, 'refusal');
  });

  test(`${site}: a length stop is reported, and absent fields are null, never a default (the scorer fails closed on them)`, async () => {
    const client = recordingClient(() => ({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }], usage: {} }));
    const r = await call({ client, model: 'gpt-6-luna' });
    assert.equal(r.stopReason, 'length');
    assert.equal(r.servedModel, null);
    assert.equal(r.systemFingerprint, null);
    assert.equal(r.reasoningTokens, null, 'a missing reasoning-token count must not read as 0');
  });

  // The mock branch carries the same R1 fields as a live call, with requestParams from the
  // real request builder (plan T1), so the pre-freeze dry run exercises the scorer's checks.
  for (const model of ['gpt-6-luna', 'gpt-4o-mini']) {
    test(`${site} UM_TEST_MOCK_SDK=1 on ${model}: returns the built request params and the R1 fields`, async () => {
      const live = recordingClient(() => ({ model, choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: {} }));
      await call({ client: live, model });
      const { messages, ...built } = live.calls[0];
      const r = await call({ env: { UM_TEST_MOCK_SDK: '1' }, model });
      assert.deepEqual(r.requestParams, built);
      assert.equal(r.servedModel, model);
      assert.equal(r.systemFingerprint, null);
      assert.equal(r.reasoningTokens, 0);
      assert.equal(r.stopReason, 'stop');
      assert.deepEqual(r.usage, { tokensIn: 10, tokensOut: 5 });
    });
  }
}

test('UM_TEST_MOCK_SDK=1 still short-circuits before any key check (smoke boot needs no key)', async () => {
  for (const call of Object.values(R1_SITES)) {
    const r = await call({ env: { UM_TEST_MOCK_SDK: '1' } });
    assert.equal(typeof r.content, 'string');
  }
});
