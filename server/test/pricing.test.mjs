import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICING, priceFor, computeCost } from '../lib/pricing.mjs';

test('PRICING has all four providers', () => {
  for (const p of ['openai', 'anthropic', 'google', 'ollama']) {
    assert.ok(PRICING[p], `missing ${p}`);
    assert.ok(PRICING[p].last_verified, `${p} missing last_verified`);
    assert.ok(PRICING[p].models, `${p} missing models`);
  }
});

test('priceFor returns shaped entry or zero defaults', () => {
  const p = priceFor('openai', 'gpt-4o-mini');
  assert.equal(typeof p.in, 'number');
  assert.equal(typeof p.out, 'number');
  assert.equal(p.type, 'chat');
});

test('priceFor returns zero defaults for unknown provider/model', () => {
  const p = priceFor('bogus', 'bogus');
  assert.deepEqual(p, { in: 0, out: 0, type: 'unknown' });
});

test('computeCost: 1k tokens × $0.001/1k = $0.001', () => {
  // mock-stable: pick a model with known rate, or assert proportional
  const cost = computeCost('openai', 'gpt-4o-mini', 1000, 0);
  assert.equal(cost, PRICING.openai.models['gpt-4o-mini'].in);
});

test('computeCost is zero for ollama', () => {
  assert.equal(computeCost('ollama', 'llama3', 1_000_000, 1_000_000), 0);
});

test('staleness advisory: each last_verified parses', () => {
  for (const [provider, entry] of Object.entries(PRICING)) {
    if (entry.last_verified === 'n/a') continue;
    const d = new Date(entry.last_verified);
    assert.ok(!isNaN(d.getTime()), `${provider}.last_verified is not a parseable date`);
  }
});

test('staleness advisory: warn (not fail) if any last_verified > 90 days', () => {
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const stale = [];
  for (const [provider, entry] of Object.entries(PRICING)) {
    if (entry.last_verified === 'n/a') continue;
    const age = now - new Date(entry.last_verified).getTime();
    if (age > ninetyDays) stale.push(`${provider} (${Math.floor(age / (24*60*60*1000))} days)`);
  }
  if (stale.length) {
    console.warn(`[pricing-staleness] ${stale.join(', ')} — refresh PRICING.last_verified after rate verification`);
  }
  // ADVISORY: this test never fails; it only emits a warning.
  assert.ok(true);
});

test('anthropic prices Haiku 5.5 at the published $0.10 / $0.50 per MTok', () => {
  assert.deepEqual(priceFor('anthropic', 'claude-haiku-5-5').in, 0.0001);
  assert.deepEqual(priceFor('anthropic', 'claude-haiku-5-5').out, 0.0005);
});

test('computeCost bills a Haiku 5.5 prompt over 100K input tokens at the long-prompt rate ($0.50 / $2.50)', () => {
  const short = computeCost('anthropic', 'claude-haiku-5-5', 100_000, 1000);
  assert.ok(Math.abs(short - (100 * 0.0001 + 1 * 0.0005)) < 1e-12, `short=${short}`);
  const long = computeCost('anthropic', 'claude-haiku-5-5', 100_001, 1000);
  assert.ok(Math.abs(long - (100.001 * 0.0005 + 1 * 0.0025)) < 1e-12, `long=${long}`);
});

// ---------------------------------------------------------------------------
// 2026-10-23 model migration (spec R2). Every model a provider can pick by default
// is priced — an unpriced default costs $0 silently and the idle sweep's cost cap
// cannot bind — and the replacement models carry their published rates.
// ---------------------------------------------------------------------------

const PROVIDER_MODULES = {
  openai: await import('../lib/provider/openai.mjs'),
  anthropic: await import('../lib/provider/anthropic.mjs'),
  google: await import('../lib/provider/google.mjs'),
  ollama: await import('../lib/provider/ollama.mjs'),
};
const SURFACE_DEFAULT = { summarizer: 'summarizerModel', facts: 'factsModel', embeddings: 'embeddingModel' };

test('every provider default model is in PRICING (unsupported surfaces and skipModelValidation providers excepted)', () => {
  for (const [provider, mod] of Object.entries(PROVIDER_MODULES)) {
    if (mod.defaults.skipModelValidation) continue; // ollama: user-pulled models, no vendor table
    for (const [surface, key] of Object.entries(SURFACE_DEFAULT)) {
      if (!mod.supports[surface]) continue;
      const model = mod.defaults[key];
      assert.ok(PRICING[provider].models[model], `${provider}.${key} '${model}' is not priced`);
    }
  }
});

test('the luna models and gpt-4.1-mini carry OpenAI\'s published rates (read 2026-10-23)', () => {
  assert.deepEqual(PRICING.openai.models['gpt-6-luna'], { in: 0.00010, out: 0.00050, type: 'chat' });
  assert.deepEqual(PRICING.openai.models['gpt-5.6-luna'], { in: 0.00020, out: 0.00120, type: 'chat' });
  assert.deepEqual(PRICING.openai.models['gpt-4.1-mini'], { in: 0.00040, out: 0.00160, type: 'chat' });
  assert.equal(PRICING.openai.last_verified, '2026-10-23');
});

// gemini-3.6-flash at its 2027-01-01 rates (model migration Phase B, spec R7): the page
// (re-read 2026-10-27) doubles them that day, to $1.50 / $7.50 per 1M. Pricing the later rate
// now is the conservative side: before 01-01 the cost cap binds early, never late.
test('the Gemini replacements carry Google\'s published rates (gemini-3.6-flash at its 2027-01-01 rates) and the embedding model its default dimension', () => {
  assert.deepEqual(PRICING.google.models['gemini-3.6-flash'], { in: 0.00150, out: 0.00750, type: 'chat' });
  assert.deepEqual(PRICING.google.models['gemini-embedding-2'], { in: 0.00020, out: 0, type: 'embed', dim: 3072 });
  assert.equal(PRICING.google.last_verified, '2026-10-27');
});

test('retired model ids stay priced, so a .env that still pins one keeps booting', () => {
  for (const [provider, model] of [['openai', 'gpt-4.1-nano-2025-04-14'], ['google', 'gemini-2.0-flash'], ['google', 'text-embedding-004']]) {
    assert.ok(PRICING[provider].models[model], `${provider} '${model}' must stay in PRICING`);
  }
});
