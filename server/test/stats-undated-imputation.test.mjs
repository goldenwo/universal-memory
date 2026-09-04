// server/test/stats-undated-imputation.test.mjs — #297 T4, R8: the `undated_imputation` block
// buildStats() renders on GET /api/stats (and, through the same DI default, on /control).
//
// Contract under pin (spec §4.2 step 5, D20/D24/D25):
//   - EXACTLY the wire keys, all snake_case — the cache's internal camelCase value is mapped ONCE
//     here, never spread onto the wire;
//   - `enabled` mirrors isDecayEnabled(); `half_life_days` = resolveHalfLifeDays() — the ONE owner
//     doSearch also reads, so `applied_factor === undatedFactorFor(A_q, resolveHalfLifeDays())`;
//   - honesty: `factor` is null until a statistic exists; `applied_factor` is what doSearch
//     multiplies an undated score by RIGHT NOW — 1 with decay off, else factor ?? exp(-0.25);
//   - `computed_age_ms` / `attempt_age_ms` derived per GET (null before the first success/attempt);
//   - stats NEVER triggers a refresh (D7);
//   - the `imputation` param defaults to the module singleton (D16), so /control needs no edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStats } from '../lib/stats-payload.mjs';
import { createUndatedImputation, undatedImputation, UNDATED_IMPUTATION_TTL_MS } from '../lib/undated-imputation.mjs';
import { undatedFactorFor, applyTemporalDecay } from '../lib/ranking.mjs';
import { resolveHalfLifeDays } from '../lib/decay-env.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-09-04T12:00:00.000Z');

const WIRE_KEYS = [
  'enabled', 'mode', 'quantile', 'cohort_n', 'age_days_at_quantile', 'future_excluded',
  'computed_at', 'last_attempt_at', 'last_refresh_ms', 'last_scan_items', 'last_refresh_failed',
  'last_error', 'saturated', 'ttl_ms', 'half_life_days', 'factor', 'applied_factor',
  'computed_age_ms', 'attempt_age_ms',
].sort();

const fakeMemory = { getAll: async () => ({ results: [] }) };
const listAll = async (memory, args) => memory.getAll(args);
const readCounters = () => ({ available: false, capture: null, growth_7d: null, growth_docs_7d: null, recall: null, anomalies: null });
const quiet = { info: () => {}, warn: () => {} };
const passRetry = async (fn) => fn();

const dated = (id, ageDays, base = NOW) => ({ id, score: 0.5, metadata: { id, valid_from: new Date(base - ageDays * DAY).toISOString() } });
/** n dated points aged 1..n d relative to `base` — the instant the cache scans at (type-7 median = (n+1)/2). */
const cohort = (n, base = NOW) => Array.from({ length: n }, (_, i) => dated(`d${i + 1}`, i + 1, base));

async function withEnv(overrides, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const stats = (extra = {}) => buildStats({ now: NOW, memory: fakeMemory, userId: 'u', endpoint: '/api/stats', readCounters, listAll, ...extra });

/** A relative-mode instance: 30 dated points aged 1..30 d → A_q = 15.5 d; refreshed at `refreshedAt`. */
async function relativeInstance(refreshedAt = NOW - 10 * 60 * 1000) {
  let scans = 0;
  const scan = async () => { scans++; return { results: cohort(30, refreshedAt) }; };
  const clock = { t: refreshedAt };
  const inst = createUndatedImputation({ scan, now: () => clock.t, log: quiet, retry: passRetry });
  await inst.refreshIfDue();
  clock.t = NOW;
  return { inst, scans: () => scans };
}

test('R8: EXACTLY the wire keys, all snake_case; decay off ⇒ enabled false, factor null, applied_factor 1', async () => {
  const inst = createUndatedImputation({ now: () => NOW, log: quiet, retry: passRetry }); // unconfigured → fallback
  await withEnv({ UM_TEMPORAL_DECAY: undefined, UM_DECAY_HALF_LIFE_DAYS: undefined }, async () => {
    const body = await stats({ imputation: inst });
    const b = body.undated_imputation;
    assert.ok(b && typeof b === 'object');
    assert.deepEqual(Object.keys(b).sort(), WIRE_KEYS);
    for (const k of Object.keys(b)) assert.ok(!/[A-Z]/.test(k), `camelCase key on the wire: ${k}`);
    assert.equal(b.enabled, false);
    assert.equal(b.mode, 'fallback');
    assert.equal(b.quantile, 0.5);
    assert.equal(b.cohort_n, null);
    assert.equal(b.age_days_at_quantile, null);
    assert.equal(b.future_excluded, null);
    assert.equal(b.computed_at, null);
    assert.equal(b.last_attempt_at, null);
    assert.equal(b.last_refresh_ms, null);
    assert.equal(b.last_scan_items, null);
    assert.equal(b.last_refresh_failed, false);
    assert.equal(b.last_error, null);
    assert.equal(b.saturated, false);
    assert.equal(b.ttl_ms, UNDATED_IMPUTATION_TTL_MS);
    assert.equal(b.half_life_days, 30);
    assert.equal(b.factor, null, 'no statistic ⇒ factor null (D20)');
    assert.equal(b.applied_factor, 1, 'decay off ⇒ nothing is applied — never a reassuring 0.779');
    assert.equal(b.computed_age_ms, null);
    assert.equal(b.attempt_age_ms, null);
  });
});

test('R8: decay on + relative statistic ⇒ factor === applied_factor === undatedFactorFor(A_q, resolveHalfLifeDays()) (D25), ages derived per GET', async () => {
  const refreshedAt = NOW - 25 * 60 * 1000;
  const { inst } = await relativeInstance(refreshedAt);
  await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '45' }, async () => {
    const b = (await stats({ imputation: inst })).undated_imputation;
    assert.equal(b.enabled, true);
    assert.equal(b.mode, 'relative');
    assert.equal(b.cohort_n, 30);
    assert.equal(b.age_days_at_quantile, 15.5);
    assert.equal(b.half_life_days, 45);
    const expected = undatedFactorFor(inst.get().ageDaysAtQuantile, resolveHalfLifeDays());
    assert.equal(b.factor, expected);
    assert.equal(b.applied_factor, expected);
    assert.equal(b.applied_factor, Math.exp(-15.5 / 45));
    // Composed with what a search ACTUALLY applies (code review 2026-09-04): the number on the
    // wire is the number applyTemporalDecay multiplies an undated score by.
    const out = applyTemporalDecay([{ id: 'u', score: 0.5, metadata: {} }, { id: 'd', score: 0.5, metadata: { valid_from: new Date(NOW - DAY).toISOString() } }], b.half_life_days, { undatedFactor: b.applied_factor });
    assert.equal(out.find((r) => r.id === 'u').score, 0.5 * b.applied_factor);
    assert.equal(b.computed_at, refreshedAt);
    assert.equal(b.last_attempt_at, refreshedAt);
    assert.equal(b.computed_age_ms, 25 * 60 * 1000);
    assert.equal(b.attempt_age_ms, 25 * 60 * 1000);
    assert.equal(typeof b.last_refresh_ms, 'number');
    assert.equal(b.last_scan_items, 30);
    assert.equal(b.future_excluded, 0);
    assert.equal(b.saturated, false);
  });
});

test('R8: decay on + a statistic + decay OFF again ⇒ factor still reported, applied_factor 1 (honesty is about what is APPLIED)', async () => {
  const { inst } = await relativeInstance();
  await withEnv({ UM_TEMPORAL_DECAY: undefined, UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
    const b = (await stats({ imputation: inst })).undated_imputation;
    assert.equal(b.enabled, false);
    assert.equal(b.factor, Math.exp(-15.5 / 30));
    assert.equal(b.applied_factor, 1);
  });
});

test('R8: decay on but the cache in fallback ⇒ factor null, applied_factor = exp(-0.25)', async () => {
  const inst = createUndatedImputation({ now: () => NOW, log: quiet, retry: passRetry });
  await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
    const b = (await stats({ imputation: inst })).undated_imputation;
    assert.equal(b.enabled, true);
    assert.equal(b.mode, 'fallback');
    assert.equal(b.factor, null);
    assert.equal(b.applied_factor, Math.exp(-0.25));
  });
});

test('R8: a failed attempt after a success maps last_refresh_failed / last_error and a fresh attempt_age_ms beside an old computed_age_ms', async () => {
  const clock = { t: NOW - 3 * UNDATED_IMPUTATION_TTL_MS };
  let n = 0;
  const scan = async () => { n++; if (n > 1) throw new Error('qdrant down'); return { results: cohort(30, clock.t) }; };
  const inst = createUndatedImputation({ scan, now: () => clock.t, log: quiet, retry: passRetry });
  await inst.refreshIfDue();                       // success at NOW − 3 TTL
  clock.t = NOW - 5 * 60 * 1000;
  await inst.refreshIfDue();                       // failed attempt at NOW − 5 min
  clock.t = NOW;
  const b = (await stats({ imputation: inst })).undated_imputation;
  assert.equal(b.mode, 'relative', 'last good value served');
  assert.equal(b.last_refresh_failed, true);
  assert.match(b.last_error, /qdrant down/);
  assert.equal(b.attempt_age_ms, 5 * 60 * 1000);
  assert.equal(b.computed_age_ms, 3 * UNDATED_IMPUTATION_TTL_MS);
  // The §4.5 stuck-cache gap, in wire arithmetic: the attempt-minus-success gap exceeds 2×TTL.
  assert.ok(b.computed_age_ms - b.attempt_age_ms > 2 * b.ttl_ms);
});

test('R8: stats never triggers a refresh (D7) — no scan, no refreshIfDue, on repeated GETs', async () => {
  let scans = 0;
  let refreshes = 0;
  const inst = createUndatedImputation({ scan: async () => { scans++; return { results: cohort(30) }; }, now: () => NOW, log: quiet, retry: passRetry });
  const orig = inst.refreshIfDue;
  inst.refreshIfDue = (...a) => { refreshes++; return orig(...a); };
  await withEnv({ UM_TEMPORAL_DECAY: 'true' }, async () => {
    await stats({ imputation: inst });
    await stats({ imputation: inst });
  });
  assert.equal(scans, 0);
  assert.equal(refreshes, 0);
});

test('R8 (D16): the `imputation` param defaults to the module singleton — both stats callers render the block with no edit', async () => {
  const origGet = undatedImputation.get;
  let gets = 0;
  undatedImputation.get = (...a) => { gets++; return origGet(...a); };
  try {
    const body = await stats();
    assert.equal(gets, 1, 'the singleton was consulted exactly once');
    assert.ok(body.undated_imputation);
    assert.equal(body.undated_imputation.mode, 'fallback');
  } finally {
    undatedImputation.get = origGet;
  }
});

test('review: an explicit `imputation: null` resolves to the singleton exactly like doSearch\'s `??` (no 500 on /api/stats)', async () => {
  const body = await stats({ imputation: null });
  assert.equal(body.undated_imputation.mode, 'fallback');
});

test('review: a throwing or malformed instance nulls its OWN block and appends a degraded marker — never a 500', async () => {
  for (const bad of [{ get: () => { throw new Error('seam boom'); } }, { get: () => null }, {}]) {
    const body = await stats({ imputation: bad });
    assert.ok(body.degraded.includes('undated-imputation-unavailable'));
    const b = body.undated_imputation;
    assert.equal(b.mode, null);
    assert.equal(b.cohort_n, null);
    assert.equal(b.factor, null);
    assert.equal(typeof b.enabled, 'boolean', 'the env-sourced keys still render');
    assert.equal(b.ttl_ms, UNDATED_IMPUTATION_TTL_MS);
  }
});

test('review: last_error is capped at 300 chars', async () => {
  const inst = createUndatedImputation({ scan: async () => { throw new Error('x'.repeat(5000)); }, now: () => NOW, log: quiet, retry: passRetry });
  await inst.refreshIfDue();
  const b = (await stats({ imputation: inst })).undated_imputation;
  assert.equal(b.last_refresh_failed, true);
  assert.equal(b.last_error.length, 300);
});

test('R8: the block is always present and additive — the rest of the payload is unchanged in shape', async () => {
  const body = await stats();
  for (const k of ['schema_version', 'generated_at', 'server', 'corpus', 'capture', 'layers', 'signals', 'recall', 'undated_imputation']) {
    assert.ok(k in body, `top-level key ${k}`);
  }
  assert.equal(body.schema_version, 1);
});
