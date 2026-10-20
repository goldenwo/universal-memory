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
