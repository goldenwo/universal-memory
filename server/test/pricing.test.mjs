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
