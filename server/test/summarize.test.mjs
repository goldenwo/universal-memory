// server/test/summarize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, BACKENDS } from '../lib/summarize.mjs';

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
  const ollamaFetch = async (url, opts) => {
    called = true;
    return {
      ok: true,
      json: async () => ({ response: 'ollama-summary', prompt_eval_count: 80, eval_count: 40 }),
    };
  };
  const result = await summarize('transcript', { backend: 'ollama', ollamaFetch });
  assert.ok(called);
  assert.equal(result.summary, 'ollama-summary');
  assert.equal(result.tokensIn, 80);
  assert.equal(result.tokensOut, 40);
  assert.equal(result.costUsd, 0);
});

// ---------- claude-agent-sdk falls back ----------

test('summarize: claude-agent-sdk falls back to openai with warning', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
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
    assert.ok(warnings.some(w => /claude-agent-sdk|fallback/i.test(w)));
    assert.equal(result.summary, 'fallback');
  } finally {
    console.warn = origWarn;
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
