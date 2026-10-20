import test from 'node:test';
import assert from 'node:assert/strict';
import { callStats, controlProvider, fixtureDigests } from '../eval/extraction-fidelity-eval.mjs';
import { facts } from '../lib/facts.mjs';

const NOOP = { counter: () => {}, histogram: () => {} };

test('callStats: per-call mean cost and tokens, nearest-rank latency percentiles, stop-reason counts', () => {
  const calls = Array.from({ length: 20 }, (_, i) => ({
    costUsd: 0.001, tokensIn: 100, tokensOut: 10 + i, latencyMs: i + 1,
    stopReason: i === 19 ? 'max_tokens' : 'end_turn',
  }));
  const s = callStats(calls);
  assert.equal(s.n, 20);
  assert.ok(Math.abs(s.costUsd.total - 0.02) < 1e-12);
  assert.ok(Math.abs(s.costUsd.mean - 0.001) < 1e-12);
  assert.equal(s.tokensIn.mean, 100);
  assert.equal(s.tokensOut.mean, 19.5);
  assert.equal(s.latencyMs.p50, 10); // ceil(0.5*20) = 10th smallest
  assert.equal(s.latencyMs.p95, 19); // ceil(0.95*20) = 19th smallest
  assert.equal(s.latencyMs.max, 20);
  assert.deepEqual(s.stopReasons, { end_turn: 19, max_tokens: 1 });
});

test('callStats on no calls is all-null, not NaN', () => {
  const s = callStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.costUsd.mean, null);
  assert.equal(s.latencyMs.p95, null);
});

test('controlProvider: gold-echo returns the gold, always-abstain nothing, input-echo the input', async () => {
  const row = { id: 'x', input_text: 'The build is green again.', expected_facts: ['A', 'B'] };
  const run = async (kind) => (await facts(row.input_text, {
    provider: `control:${kind}`, _providerOverride: controlProvider(kind, row), metrics: NOOP,
  })).facts;
  assert.deepEqual(await run('gold-echo'), ['A', 'B']);
  assert.deepEqual(await run('always-abstain'), []);
  assert.deepEqual(await run('input-echo'), ['The build is green again.']);
  assert.throws(() => controlProvider('bogus', row), /unknown control/);
});

test('facts() passes the provider stop reason through (null when the provider gives none)', async () => {
  const withStop = { supports: { facts: true }, defaults: { factsModel: 'm' },
    factsInvoke: async () => ({ facts: [], usage: { tokensIn: 1, tokensOut: 1 }, stopReason: 'max_tokens' }) };
  const without = { supports: { facts: true }, defaults: { factsModel: 'm' },
    factsInvoke: async () => ({ facts: [], usage: { tokensIn: 1, tokensOut: 1 } }) };
  assert.equal((await facts('t', { provider: 'mock', _providerOverride: withStop, metrics: NOOP })).stopReason, 'max_tokens');
  assert.equal((await facts('t', { provider: 'mock', _providerOverride: without, metrics: NOOP })).stopReason, null);
});

test('facts() passes parseOk through (null when the provider gives none)', async () => {
  const p = (extra) => ({ supports: { facts: true }, defaults: { factsModel: 'm' },
    factsInvoke: async () => ({ facts: [], usage: { tokensIn: 1, tokensOut: 1 }, ...extra }) });
  assert.equal((await facts('t', { provider: 'mock', _providerOverride: p({ parseOk: false }), metrics: NOOP })).parseOk, false);
  assert.equal((await facts('t', { provider: 'mock', _providerOverride: p({}), metrics: NOOP })).parseOk, null);
});

test('callStats counts calls whose reply did not parse', () => {
  const s = callStats([{ latencyMs: 1, parseOk: true }, { latencyMs: 1, parseOk: false }, { latencyMs: 1, parseOk: null }]);
  assert.equal(s.parseFailures, 1);
});

test('fixtureDigests hashes each fixture file by its bytes', async () => {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const path = 'eval/collision-slice.jsonl';
  const expected = createHash('sha256').update(await readFile(path)).digest('hex');
  assert.deepEqual(await fixtureDigests([path]), { [path]: expected });
});
