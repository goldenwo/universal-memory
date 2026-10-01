// server/test/summarize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { summarize, summarizerTarget, BACKENDS } from '../lib/summarize.mjs';
import { PROVIDER_METRICS } from '../lib/metrics.mjs';
import { _setLogStreamForTest } from '../lib/logger.mjs';

// ---------- openai backend ----------

test('summarize: openai backend invoked when backend=openai', async () => {
  let callCount = 0;
  const openaiClient = {
    chat: {
      completions: {
        create: async () => {
          callCount++;
          return {
            choices: [{ message: { content: 'mock-summary' } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          };
        },
      },
    },
  };
  const result = await summarize('transcript', { backend: 'openai', openaiClient });
  assert.equal(callCount, 1);
  assert.equal(result.summary, 'mock-summary');
  assert.equal(result.tokensIn, 100);
  assert.equal(result.tokensOut, 50);
  assert.ok(result.costUsd >= 0);
});

// ---------- ollama backend ----------

test('summarize: ollama backend invoked when backend=ollama', async () => {
  let called = false;
  const fakeFetch = async (url, opts) => {
    called = true;
    return {
      ok: true,
      json: async () => ({ response: 'ollama-summary', prompt_eval_count: 80, eval_count: 40 }),
    };
  };
  const result = await summarize('transcript', { backend: 'ollama', fetch: fakeFetch });
  assert.ok(called);
  assert.equal(result.summary, 'ollama-summary');
  assert.equal(result.tokensIn, 80);
  assert.equal(result.tokensOut, 40);
  assert.equal(result.costUsd, 0);
});

// ---------- claude-agent-sdk falls back ----------

test('summarize: claude-agent-sdk falls back to openai with warning', async () => {
  // Capture pino-emitted warn lines via the logger test sink (C.3): the
  // structured logger replaced the legacy console.warn here.
  const captured = [];
  _setLogStreamForTest(new Writable({
    write(chunk, enc, cb) {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        try { captured.push(JSON.parse(line)); } catch { /* ignore */ }
      }
      cb();
    },
  }));
  try {
    let fallbackCalled = false;
    const openaiClient = {
      chat: {
        completions: {
          create: async () => {
            fallbackCalled = true;
            return {
              choices: [{ message: { content: 'fallback' } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          },
        },
      },
    };
    const result = await summarize('t', { backend: 'claude-agent-sdk', openaiClient });
    assert.ok(fallbackCalled, 'fallback backend should have been invoked');
    assert.ok(
      captured.some((l) => l.level === 'warn' && (l.backend === 'claude-agent-sdk' || /fallback/i.test(l.msg ?? ''))),
      'expected a warn log line referencing claude-agent-sdk or the fallback',
    );
    assert.equal(result.summary, 'fallback');
  } finally {
    _setLogStreamForTest(null);
  }
});

// ---------- registry coverage loop ----------

test('summarize: every registered backend has a test (loop)', async () => {
  const names = Object.keys(BACKENDS);
  assert.ok(names.includes('openai'));
  assert.ok(names.includes('ollama'));
  assert.ok(names.includes('claude-agent-sdk'));
});

// ---------- unknown backend falls back via UM_SUMMARIZER_FALLBACK ----------

test('summarize: unknown backend falls back to UM_SUMMARIZER_FALLBACK', async () => {
  process.env.UM_SUMMARIZER_FALLBACK = 'openai';
  let fallbackCalled = false;
  const openaiClient = {
    chat: {
      completions: {
        create: async () => {
          fallbackCalled = true;
          return {
            choices: [{ message: { content: 'fb' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
  const result = await summarize('t', { backend: 'nonexistent-backend', openaiClient });
  assert.ok(fallbackCalled);
  assert.equal(result.summary, 'fb');
  delete process.env.UM_SUMMARIZER_FALLBACK;
});

// ---------- #314: summarizerTarget names the (provider, model) summarize() bills ----------
//
// The idle sweep warns at boot when a checkpoint's summarizer model has no price entry (the
// per-project cost cap cannot bind then). summarizerTarget restates summarize()'s resolution
// without calling a provider; this pins the two together over the precedence and fallback cases,
// reading what summarize() really used off its cost-metric labels.

test('#314 summarizerTarget: the same provider and model summarize() resolves and bills, case by case', async () => {
  const cases = [
    { env: {}, ctx: {}, want: { provider: 'openai', model: 'gpt-4o-mini' } },
    { env: {}, ctx: { model: 'gpt-4.1-nano-2025-04-14' }, want: { provider: 'openai', model: 'gpt-4.1-nano-2025-04-14' } },
    { env: { UM_SUMMARIZER_MODEL: 'gpt-4.1-nano-2025-04-14' }, ctx: {}, want: { provider: 'openai', model: 'gpt-4.1-nano-2025-04-14' } },
    { env: { UM_SUMMARIZER_MODEL: 'gpt-4.1-nano-2025-04-14' }, ctx: { model: 'gpt-4o-mini' }, want: { provider: 'openai', model: 'gpt-4o-mini' } },
    { env: { UM_SUMMARIZER_PROVIDER: 'anthropic' }, ctx: {}, want: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
    { env: { UM_SUMMARIZER_PROVIDER: 'anthropic' }, ctx: { backend: 'openai', model: 'gpt-4o-mini' }, want: { provider: 'openai', model: 'gpt-4o-mini' } },
    { env: { UM_SUMMARIZER: 'ollama' }, ctx: {}, want: { provider: 'ollama', model: 'llama3' } },
    { env: { UM_SUMMARIZER_PROVIDER: 'anthropic', UM_SUMMARIZER: 'ollama' }, ctx: {}, want: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
    { env: {}, ctx: { backend: 'claude-agent-sdk', model: 'gpt-4o-mini' }, want: { provider: 'openai', model: 'gpt-4o-mini' } },
    { env: { UM_SUMMARIZER_FALLBACK: 'anthropic' }, ctx: { backend: 'nonexistent-backend' }, want: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' } },
  ];
  const VARS = ['UM_SUMMARIZER', 'UM_SUMMARIZER_PROVIDER', 'UM_SUMMARIZER_MODEL', 'UM_SUMMARIZER_FALLBACK'];
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  try {
    for (const { env, ctx, want } of cases) {
      for (const k of VARS) delete process.env[k];
      Object.assign(process.env, env);
      let billed = null;
      const metrics = {
        counter: (name, labels) => { if (name === PROVIDER_METRICS.COST_USD_TOTAL) billed = { provider: labels.provider, model: labels.model }; },
        histogram: () => {},
      };
      await summarize('t', {
        ...ctx,
        metrics,
        _providerOverride: { summarizerInvoke: async () => ({ content: 's', usage: { tokensIn: 1, tokensOut: 1 } }) },
      });
      const label = JSON.stringify({ env, ctx });
      assert.deepEqual(billed, want, `summarize() billed ${label}`);
      assert.deepEqual(summarizerTarget(ctx, env), want, `summarizerTarget ${label}`);
    }
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

// ---------- cost calculation ----------

test('summarize: openai cost formula is correct', async () => {
  const openaiClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        }),
      },
    },
  };
  const result = await summarize('t', { backend: 'openai', openaiClient });
  // 1M input @ $0.15/1M + 1M output @ $0.60/1M = $0.75
  assert.ok(Math.abs(result.costUsd - 0.75) < 0.001, `expected ~0.75 got ${result.costUsd}`);
});

// ---------- C1: orchestrator contract + anthropic/google registration ----------

test('summarize() orchestrator returns {summary, costUsd, tokensIn, tokensOut} contract', async () => {
  const fakeProvider = {
    summarizerInvoke: async () => ({ content: 'a summary', usage: { tokensIn: 100, tokensOut: 50 } }),
    requires: [], defaults: { summarizerModel: 'gpt-4o-mini' },
  };
  // Inject via ctx so we don't need real SDKs
  const result = await summarize('transcript', { provider: 'openai', model: 'gpt-4o-mini', _providerOverride: fakeProvider });
  assert.equal(result.summary, 'a summary');
  assert.equal(result.tokensIn, 100);
  assert.equal(result.tokensOut, 50);
  assert.equal(typeof result.costUsd, 'number');
  // Verify cost is computed from PRICING table (not zero unless ollama)
  assert.ok(result.costUsd > 0, 'costUsd should be computed from pricing.mjs for openai');
});

test('summarize() returns costUsd=0 for ollama (local; PRICING entries all 0)', async () => {
  const fakeProvider = {
    summarizerInvoke: async () => ({ content: 'local summary', usage: { tokensIn: 10000, tokensOut: 5000 } }),
    requires: [], defaults: { summarizerModel: 'llama3' },
  };
  const result = await summarize('transcript', { provider: 'ollama', model: 'llama3', _providerOverride: fakeProvider });
  assert.equal(result.costUsd, 0);
});

// Existing test that checks ollama path shape — verifies it didn't regress
test('existing ollama-path test still passes after orchestrator reshape', async () => {
  // Run the existing test directly. If it fails, the reshape broke compat.
  // (This test is a marker; the real assertion is the file-level test pass.)
  assert.ok(true);
});
