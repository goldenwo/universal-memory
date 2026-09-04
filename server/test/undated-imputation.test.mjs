// server/test/undated-imputation.test.mjs — #297 T2: the corpus-statistic cache module
// (lib/undated-imputation.mjs) — R3-cache, R6 (the state machine), R10 (saturation).
//
// Plain *.test.mjs, deliberately OUTSIDE the red-controls registry (spec §6.2): the runner
// mutates only lib/ranking.mjs through a `data:` URL, so a case that exercises this module can
// never be table-resident. Every seam is DI (`scan`, `now`, `log`, `retry`) — no qdrant, no
// clock, no network. The cache never sees H (spec D12): it holds the H-independent statistic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUndatedImputation, undatedImputation, UNDATED_IMPUTATION_TTL_MS, UNDATED_IMPUTATION_SCAN_TIMEOUT_MS } from '../lib/undated-imputation.mjs';
import { FULL_SCAN_LIMIT } from '../lib/mem0-read.mjs';

const DAY = 86400000;
const T0 = Date.parse('2026-09-04T00:00:00.000Z');

const dated = (id, ageDays, extra = {}) => ({
  id, score: 0.5, metadata: { id, valid_from: new Date(T0 - ageDays * DAY).toISOString(), ...extra },
});
const undated = (id) => ({ id, score: 0.5, metadata: { id } });
/** n dated points aged 1..n days (type-7 median = (n+1)/2). */
const cohort = (n) => Array.from({ length: n }, (_, i) => dated(`d${i + 1}`, i + 1));

/** A settable DI clock. */
function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  now.set = (ms) => { t = ms; };
  return now;
}

/** A DI log that records message strings per level. */
function fakeLog() {
  const calls = { info: [], warn: [] };
  return {
    calls,
    info: (obj, msg) => calls.info.push({ obj, msg: msg ?? obj }),
    warn: (obj, msg) => calls.warn.push({ obj, msg: msg ?? obj }),
  };
}

/** A pass-through retry (no backoff) that counts invocations of the wrapped fn. */
const passRetry = async (fn) => fn();

/** Scan double: returns `{results}` like umGetAll, counting calls; `impl` may throw. */
function scanDouble(impl) {
  let calls = 0;
  const scan = async () => { calls++; return impl(calls); };
  scan.calls = () => calls;
  return scan;
}

test('R3-cache: 19 dated points → mode fallback with cohortN 19; 20 → relative with the median', async () => {
  for (const [n, mode, ageDays] of [[19, 'fallback', null], [20, 'relative', 10.5]]) {
    const scan = scanDouble(() => ({ results: [...cohort(n), undated('u')] }));
    const cache = createUndatedImputation({ scan, now: clock(), log: fakeLog(), retry: passRetry });
    await cache.refreshIfDue();
    const v = cache.get();
    assert.equal(v.mode, mode, `n=${n}`);
    assert.equal(v.cohortN, n, `n=${n}`);
    assert.equal(v.ageDaysAtQuantile, ageDays, `n=${n}`);
    assert.equal(v.quantile, 0.5);
    assert.equal(v.lastRefreshFailed, false);
    assert.equal(v.lastError, null);
    assert.equal(typeof v.computedAt, 'number');
    assert.equal(typeof v.lastAttemptAt, 'number');
    assert.equal(typeof v.lastRefreshMs, 'number');
    assert.equal(v.lastScanItems, n + 1);
    assert.equal(v.futureExcluded, 0);
    assert.equal(v.saturated, false);
  }
});

test('R3-cache: the statistic never carries a factor or an H (spec D12)', async () => {
  const scan = scanDouble(() => ({ results: cohort(25) }));
  const cache = createUndatedImputation({ scan, now: clock(), log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  const v = cache.get();
  assert.ok(!('factor' in v), 'the cache exposes no factor');
  assert.ok(!('halfLifeDays' in v) && !('halfLife' in v), 'the cache holds no H');
  assert.deepEqual(Object.keys(v).sort(), [
    'ageDaysAtQuantile', 'cohortN', 'computedAt', 'futureExcluded', 'lastAttemptAt', 'lastError',
    'lastRefreshFailed', 'lastRefreshMs', 'lastScanItems', 'mode', 'quantile', 'saturated',
  ]);
});

test('R6: init → fallback with no attempt; first success → relative', async () => {
  const scan = scanDouble(() => ({ results: cohort(30) }));
  const cache = createUndatedImputation({ scan, now: clock(), log: fakeLog(), retry: passRetry });
  const v0 = cache.get();
  assert.equal(v0.mode, 'fallback');
  assert.equal(v0.ageDaysAtQuantile, null);
  assert.equal(v0.cohortN, null);
  assert.equal(v0.computedAt, null);
  assert.equal(v0.lastAttemptAt, null);
  assert.equal(scan.calls(), 0, 'get() never scans');
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 1);
  assert.equal(cache.get().mode, 'relative');
  assert.equal(cache.get().ageDaysAtQuantile, 15.5); // ages 1..30 → (15 + 16) / 2
});

test('R6: get() is synchronous and returns the same frozen epoch until a refresh lands', async () => {
  const scan = scanDouble(() => ({ results: cohort(30) }));
  const cache = createUndatedImputation({ scan, now: clock(), log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  const a = cache.get();
  const b = cache.get();
  assert.equal(a, b, 'the same value object is served between refreshes (one read per request sees one epoch)');
  assert.ok(Object.isFrozen(a), 'the served value is frozen');
});

test('R6: TTL gate — no scan before the TTL, exactly one at the TTL, single-flight under 10 concurrent calls', async () => {
  const now = clock();
  let release;
  const gate = new Promise((r) => { release = r; });
  const scan = scanDouble(async () => { await gate; return { results: cohort(30) }; });
  const cache = createUndatedImputation({ scan, now, log: fakeLog(), retry: passRetry });
  const first = Promise.all(Array.from({ length: 10 }, () => cache.refreshIfDue()));
  assert.equal(scan.calls(), 1, 'ten concurrent calls → one in-flight scan');
  release();
  await first;
  assert.equal(cache.get().mode, 'relative');
  now.advance(UNDATED_IMPUTATION_TTL_MS - 1);
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 1, 'before the TTL: no scan');
  now.advance(1);
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 2, 'at the TTL: one scan');
});

test('R6: a throwing scan → last-good value kept, lastRefreshFailed, lastError, ONE warn; and the promise never rejects', async () => {
  const now = clock();
  const log = fakeLog();
  const scan = scanDouble((n) => { if (n === 2) throw new Error('qdrant down'); return { results: cohort(30) }; });
  const cache = createUndatedImputation({ scan, now, log, retry: passRetry });
  await cache.refreshIfDue();
  const good = cache.get();
  now.advance(UNDATED_IMPUTATION_TTL_MS);
  await assert.doesNotReject(cache.refreshIfDue());
  const after = cache.get();
  assert.equal(after.mode, 'relative', 'last good value is served');
  assert.equal(after.ageDaysAtQuantile, good.ageDaysAtQuantile);
  assert.equal(after.computedAt, good.computedAt, 'computedAt is freshness — untouched by a failed attempt');
  assert.equal(after.lastAttemptAt, now(), 'lastAttemptAt is stamped for the failed attempt');
  assert.equal(after.lastRefreshFailed, true);
  assert.match(after.lastError, /qdrant down/);
  assert.equal(log.calls.warn.length, 1, 'one warn per failed attempt');
  assert.match(log.calls.warn[0].msg, /^undated-imputation: refresh failed — serving relative/);
});

test('R6: a cache that never succeeded stays in fallback (with lastRefreshFailed) — no factor is ever minted', async () => {
  const now = clock();
  const log = fakeLog();
  const scan = scanDouble(() => { throw new Error('never'); });
  const cache = createUndatedImputation({ scan, now, log, retry: passRetry });
  await assert.doesNotReject(cache.refreshIfDue());
  const v = cache.get();
  assert.equal(v.mode, 'fallback');
  assert.equal(v.ageDaysAtQuantile, null);
  assert.equal(v.lastRefreshFailed, true);
  assert.equal(v.computedAt, null);
  assert.match(log.calls.warn[0].msg, /^undated-imputation: refresh failed — serving fallback/);
});

test('R6 (D13): two refreshIfDue calls inside one TTL with a scan that throws both times → the DI scan invoked EXACTLY once', async () => {
  const now = clock();
  const scan = scanDouble(() => { throw new Error('down'); });
  const cache = createUndatedImputation({ scan, now, log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  now.advance(UNDATED_IMPUTATION_TTL_MS - 1);
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 1, 'the TTL is keyed on the ATTEMPT, not on success');
  now.advance(1);
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 2);
});

test('R6: doesNotReject for a non-array scan, a {results: non-array} scan, and hostile valid_from values (excluded from n)', async () => {
  for (const bad of [42, 'nope', null, undefined, { results: null }, { results: 'x' }, { results: 7 }]) {
    const log = fakeLog();
    const cache = createUndatedImputation({ scan: async () => bad, now: clock(), log, retry: passRetry });
    await assert.doesNotReject(cache.refreshIfDue());
    assert.equal(cache.get().mode, 'fallback', `scan → ${JSON.stringify(bad)}`);
    assert.equal(cache.get().lastRefreshFailed, true, `scan → ${JSON.stringify(bad)} is a failed attempt`);
    assert.equal(log.calls.warn.length, 1);
  }
  // Hostile valid_from: an array, `true`, `1`, and a 1-char NON-NUMERIC string ('5' would parse
  // as a real date through isUsableDate and legitimately count — FCP pass 2).
  const hostile = [
    { id: 'h1', score: 0.5, metadata: { id: 'h1', valid_from: ['2026-01-01'] } },
    { id: 'h2', score: 0.5, metadata: { id: 'h2', valid_from: true } },
    { id: 'h3', score: 0.5, metadata: { id: 'h3', valid_from: 1 } },
    { id: 'h4', score: 0.5, metadata: { id: 'h4', valid_from: 'x' } },
  ];
  const cache = createUndatedImputation({ scan: async () => ({ results: [...cohort(20), ...hostile] }), now: clock(), log: fakeLog(), retry: passRetry });
  await assert.doesNotReject(cache.refreshIfDue());
  assert.equal(cache.get().cohortN, 20, 'the four hostile values are excluded from n');
  assert.equal(cache.get().mode, 'relative');
});

test('R6 (D17): a DI retry that sees the scan throw twice then succeed within ONE refreshIfDue → relative, one attempt', async () => {
  const now = clock();
  const scan = scanDouble((n) => { if (n < 3) throw new Error('blip'); return { results: cohort(30) }; });
  let retryCalls = 0;
  const retry = async (fn) => {
    retryCalls++;
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) { if (i >= 2) throw e; }
    }
  };
  const cache = createUndatedImputation({ scan, now, log: fakeLog(), retry });
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 3, 'the scan ran three times inside the one attempt');
  assert.equal(retryCalls, 1, 'one retry envelope = one attempt');
  const v = cache.get();
  assert.equal(v.mode, 'relative');
  assert.equal(v.lastRefreshFailed, false);
  assert.equal(v.lastAttemptAt, now(), 'lastAttemptAt set once for the attempt');
  assert.equal(v.computedAt, v.lastAttemptAt, 'computedAt is stamped with the attempt START instant (lastAttemptAt ≥ computedAt holds exactly)');
});

test('R6: the retry seam receives an op label and the scan thunk', async () => {
  let seen;
  const retry = async (fn, opts) => { seen = opts; return fn(); };
  const cache = createUndatedImputation({ scan: async () => ({ results: cohort(30) }), now: clock(), log: fakeLog(), retry });
  await cache.refreshIfDue();
  assert.equal(seen?.op, 'undated-imputation-scan');
});

test('R6: system docs and non-recallable points are excluded BEFORE the statistic (spec P4)', async () => {
  const items = [
    ...cohort(20), // ages 1..20 → median 10.5
    dated('sys', 400, { id: '_um_embedding_stamp' }), // a system doc, very old
    dated('sup', 400, { status: 'superseded' }),
    dated('dep', 400, { status: 'deprecated' }),
    dated('rej', 400, { status: 'rejected' }),
    dated('inv', 400, { invalidated_at: '2026-01-01T00:00:00.000Z' }),
  ];
  const cache = createUndatedImputation({ scan: async () => ({ results: items }), now: clock(), log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  const v = cache.get();
  assert.equal(v.cohortN, 20);
  assert.equal(v.ageDaysAtQuantile, 10.5, 'the five excluded 400-day points did not move the median');
  assert.equal(v.lastScanItems, 25, 'lastScanItems is the raw scan size');
});

test('R6: future-dated points beyond the skew are excluded and counted in futureExcluded', async () => {
  const items = [...cohort(20), dated('f1', -10), dated('f2', -365)];
  const cache = createUndatedImputation({ scan: async () => ({ results: items }), now: clock(), log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  assert.equal(cache.get().cohortN, 20);
  assert.equal(cache.get().futureExcluded, 2);
  assert.equal(cache.get().ageDaysAtQuantile, 10.5);
});

test('R6: the DI log receives message STRINGS that START WITH the pinned prefix on both paths (a machine-read contract)', async () => {
  const now = clock();
  const log = fakeLog();
  const scan = scanDouble((n) => { if (n === 2) throw new Error('down'); return { results: cohort(30) }; });
  const cache = createUndatedImputation({ scan, now, log, retry: passRetry });
  await cache.refreshIfDue();
  assert.equal(log.calls.info.length, 1);
  assert.equal(log.calls.info[0].msg, 'undated-imputation: refreshed');
  const fields = log.calls.info[0].obj;
  assert.deepEqual(Object.keys(fields).sort(), ['ageDaysAtQuantile', 'cohortN', 'futureExcluded', 'mode', 'saturated', 'scanDurationMs', 'scanItems']);
  assert.ok(!('factor' in fields) && !('halfLifeDays' in fields), 'H-independent fields only');
  now.advance(UNDATED_IMPUTATION_TTL_MS);
  await cache.refreshIfDue();
  assert.equal(log.calls.warn.length, 1);
  assert.equal(log.calls.warn[0].msg, 'undated-imputation: refresh failed — serving relative');
});

test('R6 (D16): the unconfigured module-level singleton → get() is the fallback and refreshIfDue() records no attempt', async () => {
  const v = undatedImputation.get();
  assert.equal(v.mode, 'fallback');
  assert.equal(v.ageDaysAtQuantile, null);
  await assert.doesNotReject(undatedImputation.refreshIfDue());
  assert.equal(undatedImputation.get().lastAttemptAt, null, 'no attempt is recorded while unconfigured');
  assert.equal(undatedImputation.get().lastRefreshFailed, false);
});

test('R6 (D16): configure({scan}) makes the instance live; the scan is a thunk over the live binding', async () => {
  const cache = createUndatedImputation({ now: clock(), log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  assert.equal(cache.get().lastAttemptAt, null, 'unconfigured: no attempt');
  let memoryBinding = null; // assigned AFTER configure, like initMemory's module-level `memory`
  cache.configure({ scan: () => ({ results: cohort(memoryBinding.size) }) });
  memoryBinding = { size: 30 };
  await cache.refreshIfDue();
  assert.equal(cache.get().mode, 'relative');
  assert.equal(cache.get().cohortN, 30);
});

test('R10: a scan returning exactly FULL_SCAN_LIMIT items → saturated:true, quantile still computed; LIMIT − 1 → not saturated', async () => {
  for (const [count, saturated] of [[FULL_SCAN_LIMIT, true], [FULL_SCAN_LIMIT - 1, false]]) {
    const items = Array.from({ length: count }, (_, i) => dated(`p${i}`, (i % 100) + 1));
    const cache = createUndatedImputation({ scan: async () => ({ results: items }), now: clock(), log: fakeLog(), retry: passRetry });
    await cache.refreshIfDue();
    const v = cache.get();
    assert.equal(v.saturated, saturated, `count=${count}`);
    assert.equal(v.mode, 'relative', `count=${count}`);
    assert.equal(v.cohortN, count);
    assert.equal(typeof v.ageDaysAtQuantile, 'number');
    assert.equal(v.lastScanItems, count);
  }
});

// ── code-review hardening (2026-09-04) ─────────────────────────────────────────

test('review: a scan that never settles times out into a FAILED attempt (the module\'s own race, short DI timer) — no frozen cache, alert (a) fires, the next TTL attempt runs', async () => {
  assert.equal(UNDATED_IMPUTATION_SCAN_TIMEOUT_MS, 60_000, 'the default bound is generous against the §4.5 budget');
  const now = clock();
  const log = fakeLog();
  let calls = 0;
  const scan = () => { calls++; return new Promise(() => {}); }; // never settles
  const cache = createUndatedImputation({ scan, now, log, retry: passRetry, scanTimeoutMs: 20 });
  const p = cache.refreshIfDue();
  assert.equal(calls, 1);
  assert.equal(cache.refreshIfDue(), p, 'single-flight while the hung scan is in flight');
  await assert.doesNotReject(p);
  assert.equal(cache.get().lastRefreshFailed, true, 'a timed-out attempt is a FAILED attempt — alert (a)');
  assert.match(cache.get().lastError, /scan timed out after 20 ms/);
  assert.equal(log.calls.warn.length, 1);
  now.advance(UNDATED_IMPUTATION_TTL_MS);
  await cache.refreshIfDue();
  assert.equal(calls, 2, 'the next TTL attempt is NOT blocked by the earlier hang');
});

test('review: configure({}) and configure() are no-ops on a live instance; an explicit non-function scan un-configures', async () => {
  const scan = scanDouble(() => ({ results: cohort(30) }));
  const cache = createUndatedImputation({ scan, now: clock(), log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  assert.equal(cache.get().mode, 'relative');
  cache.configure({});
  cache.configure();
  const now2 = clock(T0 + UNDATED_IMPUTATION_TTL_MS);
  const live = createUndatedImputation({ scan, now: now2, log: fakeLog(), retry: passRetry });
  live.configure({});
  await live.refreshIfDue();
  assert.equal(scan.calls(), 2, 'an absent key changed nothing — the scan still runs');
  live.configure({ scan: null });
  now2.advance(UNDATED_IMPUTATION_TTL_MS);
  await live.refreshIfDue();
  assert.equal(scan.calls(), 2, 'an explicit null un-configures');
});

test('review: a configure() landing mid-attempt is NOT adopted by that attempt\'s retries', async () => {
  const now = clock();
  const seen = [];
  const oldScan = async () => { seen.push('OLD'); throw new Error('old down'); };
  const newScan = async () => { seen.push('NEW'); return { results: cohort(30) }; };
  const cache = createUndatedImputation({ scan: oldScan, now, log: fakeLog(), retry: async (fn) => { try { return await fn(); } catch { cache.configure({ scan: newScan }); return fn(); } } });
  await cache.refreshIfDue();
  assert.deepEqual(seen, ['OLD', 'OLD'], 'the retry re-ran the scan captured at attempt start, not the swapped one');
  assert.equal(cache.get().lastRefreshFailed, true);
  now.advance(UNDATED_IMPUTATION_TTL_MS);
  await cache.refreshIfDue();
  assert.equal(seen.at(-1), 'NEW', 'the NEXT attempt uses the new scan');
  assert.equal(cache.get().mode, 'relative');
});

test('review: a backwards clock step is treated as due — refreshes never freeze for the length of the step', async () => {
  const now = clock(T0 + 10 * UNDATED_IMPUTATION_TTL_MS);
  const scan = scanDouble(() => ({ results: cohort(30) }));
  const cache = createUndatedImputation({ scan, now, log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 1);
  now.set(T0 + 5 * UNDATED_IMPUTATION_TTL_MS); // NTP step back 5 h
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 2, 'a negative elapsed time is due, not "not yet"');
  now.advance(UNDATED_IMPUTATION_TTL_MS - 1);
  await cache.refreshIfDue();
  assert.equal(scan.calls(), 2, 'and the TTL runs normally from the new stamp');
});

test('review: a throw value with no string form, and a throwing now() seam, never reject or throw out of refreshIfDue()', async () => {
  const hostile = Object.create(null); // String(hostile) throws
  const cache = createUndatedImputation({ scan: async () => { throw hostile; }, now: clock(), log: fakeLog(), retry: passRetry });
  await assert.doesNotReject(cache.refreshIfDue());
  assert.equal(cache.get().lastRefreshFailed, true);
  assert.equal(cache.get().lastError, 'unknown error');
  const broken = createUndatedImputation({ scan: async () => ({ results: [] }), now: () => { throw new Error('clock down'); }, log: fakeLog(), retry: passRetry });
  let p;
  assert.doesNotThrow(() => { p = broken.refreshIfDue(); });
  await assert.doesNotReject(p);
});

test('review: computedAt is the attempt START instant — lastAttemptAt ≥ computedAt holds exactly even when the scan consumes clock time', async () => {
  const now = clock();
  const scan = async () => { now.advance(5_000); return { results: cohort(30) }; }; // the scan takes 5 s of clock
  const cache = createUndatedImputation({ scan, now, log: fakeLog(), retry: passRetry });
  await cache.refreshIfDue();
  const v = cache.get();
  assert.equal(v.computedAt, T0, 'stamped with the attempt START, not its end');
  assert.equal(v.lastAttemptAt, T0);
  assert.ok(v.lastAttemptAt >= v.computedAt);
  assert.equal(v.lastRefreshMs, 5_000);
});

test('the TTL is one hour, a code constant (spec §4.6 / R-f)', () => {
  assert.equal(UNDATED_IMPUTATION_TTL_MS, 3_600_000);
});
