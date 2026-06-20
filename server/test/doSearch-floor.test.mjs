/**
 * doSearch relevance-floor integration (no-answer precision, v1.6).
 *
 * Exercises the floor inside the REAL doSearch (DI mock memory client), covering
 * the recall-safe edge cases the paired-Opus review flagged as data-loss traps:
 * missing-score = KEEP, raw pre-decay gating, includeSuperseded inert, and
 * byte-for-byte inert at minScore=0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { doSearch } from '../mem0-mcp-http.mjs';

const row = (id, score, extra = {}) => ({
  id,
  memory: `mem-${id}`,
  metadata: { id, title: id, status: 'current', ...extra },
  ...(score === undefined ? {} : { score }),
});
const mockMemory = (results, extras = {}) => ({ search: async () => ({ results, ...extras }) });
const ids = (env) => env.results.map((r) => r.id);

// Keep the process env clean for default-path tests.
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]; }
  return (async () => { try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } })();
}

test('doSearch floor: drops below-floor results, keeps at/above (ctx.minScore)', async () => {
  const env = await doSearch('q', 5, false, true, {
    memory: mockMemory([row('a', 0.50), row('b', 0.25), row('c', 0.30)]),
    minScore: 0.30,
  });
  assert.deepEqual(ids(env), ['a', 'c'], 'b (0.25) dropped; c (0.30) kept inclusive');
});

test('doSearch floor: missing / non-numeric score is KEPT (recall-safe)', async () => {
  const env = await doSearch('q', 5, false, true, {
    memory: mockMemory([row('a', 0.50), row('nostore', undefined), row('low', 0.10)]),
    minScore: 0.30,
  });
  assert.deepEqual(ids(env).sort(), ['a', 'nostore'], 'no-score row kept; low (0.10) dropped');
});

test('doSearch floor: all below floor → empty results (abstention), extras preserved', async () => {
  const env = await doSearch('q', 5, false, true, {
    memory: mockMemory([row('a', 0.20), row('b', 0.10)], { provider: 'openai' }),
    minScore: 0.30,
  });
  assert.equal(env.results.length, 0, 'abstain — nothing relevant');
  assert.equal(env.provider, 'openai', 'envelope extras still propagate on abstention');
});

test('doSearch floor: minScore=0 is inert — identical to pre-floor (incl missing-score row)', async () => {
  const results = [row('a', 0.50), row('nostore', undefined), row('b', 0.05)];
  const floored = await doSearch('q', 5, false, true, { memory: mockMemory(results), minScore: 0 });
  assert.deepEqual(ids(floored).sort(), ['a', 'b', 'nostore'], 'floor 0 keeps everything');
});

test('doSearch floor: env UM_RETRIEVAL_MIN_SCORE=0 is inert (env escape hatch)', async () => {
  await withEnv({ UM_RETRIEVAL_MIN_SCORE: '0' }, async () => {
    const env = await doSearch('q', 5, false, true, { memory: mockMemory([row('a', 0.5), row('b', 0.05)]) });
    assert.deepEqual(ids(env).sort(), ['a', 'b'], 'env 0 → no filtering');
  });
});

test('doSearch floor: default-on applies the provisional default when unset', async () => {
  await withEnv({ UM_RETRIEVAL_MIN_SCORE: undefined }, async () => {
    const env = await doSearch('q', 5, false, true, { memory: mockMemory([row('a', 0.5), row('b', 0.2)]) });
    assert.deepEqual(ids(env), ['a'], 'default 0.30 floor drops b (0.2) with no override');
  });
});

test('doSearch floor: gates the RAW pre-decay score (decay on == off for keep/drop)', async () => {
  // 'x' has a high raw score but is a year old → decays well below the floor.
  // Pre-decay flooring keeps it; post-decay flooring would wrongly drop it.
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
  const results = [row('x', 0.40, { valid_from: yearAgo }), row('lo', 0.20)];
  const off = await doSearch('q', 5, false, true, { memory: mockMemory(results), minScore: 0.30 });
  const on = await withEnv({ UM_TEMPORAL_DECAY: 'true' }, () =>
    doSearch('q', 5, false, true, { memory: mockMemory(results), minScore: 0.30 }));
  assert.deepEqual(ids(off).sort(), ['x'], 'decay off: x kept (0.40≥0.30), lo dropped');
  assert.deepEqual(ids(on).sort(), ['x'], 'decay on: x STILL kept — floor used raw score, not the decayed one');
});

test('doSearch floor: inert when includeSuperseded=true (no only_superseded data-loss)', async () => {
  // superseded points are demoted/low-relevance; only_superseded listing depends
  // on them surviving. includeSuperseded=true must skip the floor entirely.
  const env = await doSearch('q', 5, /*includeSuperseded*/ true, true, {
    memory: mockMemory([row('sup', 0.10, { status: 'superseded' })]),
    minScore: 0.30,
  });
  assert.deepEqual(ids(env), ['sup'], 'sub-floor superseded row returned (floor inert)');
});
