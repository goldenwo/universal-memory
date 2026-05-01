// server/test/provider-metrics.test.mjs
// G2 (spec §8.3) — um_provider_* metrics emission across the three surface
// orchestrators (summarize / embed / facts).
//
// Naming-bridge contract (plan G2 lines 3008–3015):
//   Registry / supports table: 'embeddings' (plural)
//   Metric label:              'embed'      (singular)
// embed.mjs MUST emit metrics with surface='embed', NOT 'embeddings'.
// Tests below pin the singular form so a typo regresses immediately.

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../lib/summarize.mjs';
import { embed } from '../lib/embed.mjs';
import { facts } from '../lib/facts.mjs';

// --------- summarize ----------

test('summarize emits um_provider_tokens_total{provider,model,surface,direction}', async () => {
  const emitted = [];
  const stubRegistry = {
    counter: (name, labels, value) => emitted.push({ name, labels, value }),
    histogram: (name, labels, value) => emitted.push({ name, labels, value, kind: 'h' }),
  };
  const fakeProvider = {
    summarizerInvoke: async () => ({ content: 'sum', usage: { tokensIn: 100, tokensOut: 50 } }),
    requires: [], defaults: { summarizerModel: 'gpt-4o-mini' },
  };
  await summarize('text', { provider: 'openai', model: 'gpt-4o-mini', _providerOverride: fakeProvider, metrics: stubRegistry });

  // Expect 2 token counter increments (in + out), 1 cost counter, and 1 duration histogram.
  const tokensIn = emitted.find((e) => e.name === 'um_provider_tokens_total' && e.labels.direction === 'in');
  assert.ok(tokensIn, 'tokens_total{direction=in} not emitted');
  assert.equal(tokensIn.labels.provider, 'openai');
  assert.equal(tokensIn.labels.model, 'gpt-4o-mini');
  assert.equal(tokensIn.labels.surface, 'summarizer');
  assert.equal(tokensIn.value, 100);

  const tokensOut = emitted.find((e) => e.name === 'um_provider_tokens_total' && e.labels.direction === 'out');
  assert.equal(tokensOut.value, 50);

  const cost = emitted.find((e) => e.name === 'um_provider_cost_usd_total');
  assert.ok(cost, 'cost_usd_total not emitted');
  assert.ok(cost.value > 0, 'cost should be > 0 for openai gpt-4o-mini');

  const duration = emitted.find((e) => e.name === 'um_provider_request_duration_seconds');
  assert.ok(duration, 'request_duration_seconds histogram not emitted');
  assert.equal(duration.kind, 'h');
});

test('summarize emits um_provider_errors_total on ProviderError', async () => {
  const emitted = [];
  const stubRegistry = {
    counter: (name, labels, value) => emitted.push({ name, labels, value }),
    histogram: () => {},
  };
  const fakeProvider = {
    summarizerInvoke: async () => {
      const e = new Error('429');
      e.class = 'PROVIDER_RATELIMIT';
      e.provider = 'openai';
      throw e;
    },
    requires: [], defaults: { summarizerModel: 'gpt-4o-mini' },
  };
  await assert.rejects(() => summarize('text', { provider: 'openai', model: 'gpt-4o-mini', _providerOverride: fakeProvider, metrics: stubRegistry }));
  const errMetric = emitted.find((e) => e.name === 'um_provider_errors_total');
  assert.ok(errMetric, 'errors_total not emitted on error path');
  assert.equal(errMetric.labels.error_class, 'PROVIDER_RATELIMIT');
  assert.equal(errMetric.labels.provider, 'openai');
  assert.equal(errMetric.labels.surface, 'summarizer');
  assert.equal(errMetric.value, 1);
});

// --------- embed (singular surface label is the critical contract) ----------

test('embed surface emits metric with singular label "embed" (NOT "embeddings")', async () => {
  const emitted = [];
  const stubRegistry = {
    counter: (n, l, v) => emitted.push({ name: n, labels: l, value: v }),
    histogram: (n, l, v) => emitted.push({ name: n, labels: l, value: v, kind: 'h' }),
  };
  const fakeProvider = {
    embed: async () => ({ vector: new Array(1536).fill(0.1), usage: { tokensIn: 10, tokensOut: 0 } }),
    supports: { embeddings: true },
    requires: [],
    defaults: { embeddingModel: 'text-embedding-3-small' },
  };
  await embed('text', {
    provider: 'openai',
    model: 'text-embedding-3-small',
    _providerOverride: fakeProvider,
    metrics: stubRegistry,
  });

  const tokensMetric = emitted.find((e) => e.name === 'um_provider_tokens_total');
  assert.ok(tokensMetric, 'tokens metric emitted');
  assert.equal(tokensMetric.labels.surface, 'embed', 'metric label must be SINGULAR per spec §8.3');
  assert.notEqual(tokensMetric.labels.surface, 'embeddings', 'must NOT use plural registry-key form');

  // Sanity: cost + duration also emitted with singular surface.
  const cost = emitted.find((e) => e.name === 'um_provider_cost_usd_total');
  assert.ok(cost, 'cost emitted for embed');
  assert.equal(cost.labels.surface, 'embed');

  const duration = emitted.find((e) => e.name === 'um_provider_request_duration_seconds');
  assert.ok(duration, 'duration emitted for embed');
  assert.equal(duration.labels.surface, 'embed');
});

test('embed emits um_provider_errors_total{surface=embed} on error path', async () => {
  const emitted = [];
  const stubRegistry = {
    counter: (n, l, v) => emitted.push({ name: n, labels: l, value: v }),
    histogram: () => {},
  };
  const failingProvider = {
    embed: async () => {
      const e = new Error('upstream 500');
      e.class = 'PROVIDER_UPSTREAM';
      throw e;
    },
    supports: { embeddings: true },
    requires: [],
    defaults: { embeddingModel: 'text-embedding-3-small' },
  };
  await assert.rejects(() => embed('text', {
    provider: 'openai',
    model: 'text-embedding-3-small',
    _providerOverride: failingProvider,
    metrics: stubRegistry,
  }));
  const errMetric = emitted.find((e) => e.name === 'um_provider_errors_total');
  assert.ok(errMetric, 'errors_total not emitted on error path');
  assert.equal(errMetric.labels.surface, 'embed');
  assert.equal(errMetric.labels.error_class, 'PROVIDER_UPSTREAM');
});

// --------- facts ----------

test('facts emits um_provider_* metrics with surface="facts"', async () => {
  const emitted = [];
  const stubRegistry = {
    counter: (n, l, v) => emitted.push({ name: n, labels: l, value: v }),
    histogram: (n, l, v) => emitted.push({ name: n, labels: l, value: v, kind: 'h' }),
  };
  const fakeProvider = {
    factsInvoke: async () => ({
      facts: [{ subject: 'user', predicate: 'likes', object: 'tea' }],
      usage: { tokensIn: 200, tokensOut: 60 },
    }),
    supports: { facts: true },
    requires: [],
    defaults: { factsModel: 'gpt-4.1-nano-2025-04-14' },
  };
  await facts('user prefers tea over coffee', {
    provider: 'openai',
    model: 'gpt-4.1-nano-2025-04-14',
    _providerOverride: fakeProvider,
    metrics: stubRegistry,
  });

  const tokensIn = emitted.find((e) => e.name === 'um_provider_tokens_total' && e.labels.direction === 'in');
  assert.ok(tokensIn, 'facts tokens_total{direction=in} not emitted');
  assert.equal(tokensIn.labels.surface, 'facts');
  assert.equal(tokensIn.labels.provider, 'openai');
  assert.equal(tokensIn.value, 200);

  const tokensOut = emitted.find((e) => e.name === 'um_provider_tokens_total' && e.labels.direction === 'out');
  assert.ok(tokensOut);
  assert.equal(tokensOut.labels.surface, 'facts');
  assert.equal(tokensOut.value, 60);

  const cost = emitted.find((e) => e.name === 'um_provider_cost_usd_total');
  assert.ok(cost, 'facts cost_usd_total not emitted');
  assert.equal(cost.labels.surface, 'facts');
  assert.ok(cost.value > 0, 'facts cost should be > 0 for openai');

  const duration = emitted.find((e) => e.name === 'um_provider_request_duration_seconds');
  assert.ok(duration, 'facts duration histogram not emitted');
  assert.equal(duration.labels.surface, 'facts');
  assert.equal(duration.kind, 'h');
});

test('facts emits um_provider_errors_total{surface=facts} on ProviderError', async () => {
  const emitted = [];
  const stubRegistry = {
    counter: (n, l, v) => emitted.push({ name: n, labels: l, value: v }),
    histogram: () => {},
  };
  const failingProvider = {
    factsInvoke: async () => {
      const e = new Error('config bad');
      e.class = 'PROVIDER_CONFIG';
      e.provider = 'openai';
      throw e;
    },
    supports: { facts: true },
    requires: [],
    defaults: { factsModel: 'gpt-4.1-nano-2025-04-14' },
  };
  await assert.rejects(() => facts('text', {
    provider: 'openai',
    model: 'gpt-4.1-nano-2025-04-14',
    _providerOverride: failingProvider,
    metrics: stubRegistry,
  }));
  const errMetric = emitted.find((e) => e.name === 'um_provider_errors_total');
  assert.ok(errMetric, 'facts errors_total not emitted');
  assert.equal(errMetric.labels.surface, 'facts');
  assert.equal(errMetric.labels.error_class, 'PROVIDER_CONFIG');
  assert.equal(errMetric.labels.provider, 'openai');
  assert.equal(errMetric.value, 1);
});

// --------- no-op fallback (production paths without injected metrics) ----------

test('summarize works without injected metrics (no-op default sink)', async () => {
  const fakeProvider = {
    summarizerInvoke: async () => ({ content: 'ok', usage: { tokensIn: 1, tokensOut: 1 } }),
    requires: [], defaults: { summarizerModel: 'gpt-4o-mini' },
  };
  // No `metrics` in ctx — must not throw.
  const r = await summarize('t', { provider: 'openai', model: 'gpt-4o-mini', _providerOverride: fakeProvider });
  assert.equal(r.summary, 'ok');
});
