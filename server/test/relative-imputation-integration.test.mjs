// server/test/relative-imputation-integration.test.mjs — #297 T3: doSearch wiring.
//
//   R11 — the ctx seam: a DI instance passed as `ctx._undatedImputation` is the one consulted
//         (its `ageDaysAtQuantile` is used, its `refreshIfDue` is called), the factor is derived
//         from the REQUEST's H (two UM_DECAY_HALF_LIFE_DAYS values in one process — spec D12),
//         and the module-level singleton is untouched (spied).
//   R7  — jointness (#237 strengthened): both flags on, a window query with an in-window
//         candidate AND a no-window query; the window arm and the decay arm each scale their
//         undated item by the SAME number, read once per request; the DI scan ran once across
//         both requests within the TTL.
//   I2  — with decay off the cache is never consulted.
//
// Stub-only: no qdrant, no keys. Harness shape borrowed from temporal-integration.test.mjs
// (a stub engine that honours the fetch width) and decay-integration.test.mjs (env sandbox).

import test from 'node:test';
import assert from 'node:assert/strict';

import { doSearch } from '../mem0-mcp-http.mjs';
import { createUndatedImputation, undatedImputation } from '../lib/undated-imputation.mjs';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);      // Wed 2026-08-05 — "last week" = 07-27..08-02 (the PARSER's clock via ctx.now)
// Dated items that must DECAY are aged against the real clock: applyTemporalDecay anchors at Date.now(),
// the same convention decay-integration.test.mjs uses.
const IN_WINDOW = Date.UTC(2026, 6, 29, 12, 0);
const OUT_WINDOW = Date.UTC(2026, 5, 1, 12, 0);
const TEMPORAL_Q = 'what did we decide last week about the sidecar';
const PLAIN_Q = 'what did we decide about the sidecar';

function stubMemory(canned) {
	return {
		search: async (_query, opts) => ({ results: canned.slice(0, opts?.topK ?? canned.length) }),
	};
}

const point = (id, score, dateMs) => ({
	id, memory: `body of ${id}`, score,
	metadata: { id, title: id, ...(dateMs ? { valid_from: new Date(dateMs).toISOString() } : {}) },
});

async function withEnv(overrides, fn) {
	const saved = {};
	for (const k of Object.keys(overrides)) {
		saved[k] = process.env[k];
		if (overrides[k] === undefined) delete process.env[k];
		else process.env[k] = overrides[k];
	}
	try { return await fn(); } finally {
		for (const k of Object.keys(saved)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

const quiet = { info: () => {}, warn: () => {} };
const passRetry = async (fn) => fn();

/** A DI cache whose scan returns 21 dated points aged 1..21 d (type-7 median = 11 d). */
function cacheWithMedian11() {
	let calls = 0;
	const cohort = Array.from({ length: 21 }, (_, i) => point(`c${i + 1}`, 0.5, NOW - (i + 1) * DAY));
	const scan = async () => { calls++; return { results: cohort }; };
	const cache = createUndatedImputation({ scan, now: () => NOW, log: quiet, retry: passRetry });
	return { cache, scanCalls: () => calls };
}

/** A stub instance (the D19 shape the eval's fixed arm uses) with a fixed statistic and call counters. */
function stubInstance(ageDays) {
	const counts = { get: 0, refresh: 0 };
	return {
		counts,
		get: () => { counts.get++; return { mode: ageDays == null ? 'fallback' : 'relative', ageDaysAtQuantile: ageDays, cohortN: 400 }; },
		refreshIfDue: () => { counts.refresh++; return Promise.resolve(); },
	};
}

function spyOnSingleton() {
	const counts = { get: 0, refresh: 0 };
	const origGet = undatedImputation.get;
	const origRefresh = undatedImputation.refreshIfDue;
	undatedImputation.get = (...a) => { counts.get++; return origGet(...a); };
	undatedImputation.refreshIfDue = (...a) => { counts.refresh++; return origRefresh(...a); };
	return { counts, restore: () => { undatedImputation.get = origGet; undatedImputation.refreshIfDue = origRefresh; } };
}

const score = (r, id) => r.results.find((x) => x.id === id).score;

// ── R11 — the ctx seam + per-request H ─────────────────────────────────────────

test('R11: ctx._undatedImputation is the instance consulted; the factor uses the REQUEST\'s H; the singleton is untouched', async () => {
	const spy = spyOnSingleton();
	try {
		for (const h of ['10', '90']) {
			const inst = stubInstance(28.7);
			const canned = [point('undated', 0.6, null), point('dated', 0.5, Date.now() - 3 * DAY)];
			const r = await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: h, UM_TEMPORAL_QUERY: undefined }, () =>
				doSearch(PLAIN_Q, 5, false, false, { memory: stubMemory(canned), now: NOW, _undatedImputation: inst }));
			const expected = 0.6 * Math.exp(-28.7 / Number(h));
			assert.ok(Math.abs(score(r, 'undated') - expected) < 1e-12, `H=${h}: undated ${score(r, 'undated')} vs ${expected}`);
			assert.ok(Math.abs(score(r, 'undated') - 0.6 * Math.exp(-0.25)) > 1e-6, `H=${h}: must NOT be the fallback constant`);
			assert.ok(Math.abs(score(r, 'dated') - 0.5 * Math.exp(-3 / Number(h))) < 1e-6, `H=${h}: the dated branch decays at the same H (real clock; sub-ms drift tolerated)`);
			assert.equal(inst.counts.get, 1, `H=${h}: exactly one get() per request`);
			assert.equal(inst.counts.refresh, 1, `H=${h}: refreshIfDue() is kicked once per request`);
		}
		assert.equal(spy.counts.get + spy.counts.refresh, 0, 'the module-level singleton was never consulted');
	} finally {
		spy.restore();
	}
});

test('R11: a fallback-mode instance (ageDaysAtQuantile null) yields exactly the fallback constant — I2', async () => {
	const inst = stubInstance(null);
	const canned = [point('undated', 0.6, null), point('dated', 0.5, Date.now() - 3 * DAY)];
	const r = await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30', UM_TEMPORAL_QUERY: undefined }, () =>
		doSearch(PLAIN_Q, 5, false, false, { memory: stubMemory(canned), now: NOW, _undatedImputation: inst }));
	assert.equal(score(r, 'undated'), 0.6 * Math.exp(-0.25));
});

test('I2: with decay OFF the cache is never consulted and undated scores are untouched', async () => {
	const spy = spyOnSingleton();
	try {
		const inst = stubInstance(28.7);
		const canned = [point('undated', 0.6, null), point('dated', 0.5, Date.now() - 3 * DAY)];
		const r = await withEnv({ UM_TEMPORAL_DECAY: undefined, UM_TEMPORAL_QUERY: undefined }, () =>
			doSearch(PLAIN_Q, 5, false, false, { memory: stubMemory(canned), now: NOW, _undatedImputation: inst }));
		assert.equal(score(r, 'undated'), 0.6);
		assert.equal(inst.counts.get + inst.counts.refresh, 0, 'decay off ⇒ no cache read, no refresh kick');
		assert.equal(spy.counts.get + spy.counts.refresh, 0);
	} finally {
		spy.restore();
	}
});

// ── R7 — jointness across both arms, one read per request ──────────────────────

test('R7: both flags on — the window arm and the decay arm scale their undated item by the SAME corpus-derived number; the scan ran once', async () => {
	const { cache, scanCalls } = cacheWithMedian11();
	await cache.refreshIfDue();               // the boot kick's job — first query is not on fallback
	assert.equal(cache.get().mode, 'relative');
	assert.equal(cache.get().ageDaysAtQuantile, 11);
	const uf = Math.exp(-11 / 30);

	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_TEMPORAL_QUERY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
		// Window arm: a window resolves AND an in-window candidate exists → applyTemporalWindow.
		const windowPool = [point('d-in', 0.9, IN_WINDOW), point('d-out', 0.7, OUT_WINDOW), point('u', 0.6, null)];
		const w = await doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(windowPool), now: NOW, _undatedImputation: cache });
		assert.ok(Math.abs(score(w, 'u') - 0.6 * uf) < 1e-12, `window arm undated ${score(w, 'u')} vs ${0.6 * uf}`);
		assert.equal(score(w, 'd-in'), 0.9, 'in-window dated item keeps factor 1.0 under the window re-rank');

		// Decay arm: no window in the query → applyTemporalDecay with the same factor.
		const decayPool = [point('d-new', 0.5, Date.now() - 3 * DAY), point('u', 0.6, null)];
		const d = await doSearch(PLAIN_Q, 5, false, false, { memory: stubMemory(decayPool), now: NOW, _undatedImputation: cache });
		assert.ok(Math.abs(score(d, 'u') - 0.6 * uf) < 1e-12, `decay arm undated ${score(d, 'u')} vs ${0.6 * uf}`);
		assert.ok(Math.abs(score(d, 'd-new') - 0.5 * Math.exp(-3 / 30)) < 1e-6);

		assert.equal(score(w, 'u'), score(d, 'u'), 'jointness: both arms hand the undated item the same number');
		assert.ok(Math.abs(score(w, 'u') - 0.6 * Math.exp(-0.25)) > 1e-6, 'and it is the corpus value, not the constant');
	});
	assert.equal(scanCalls(), 1, 'one scan across the boot kick and both requests (within the TTL)');
});

test('R7: with decay ON but the window arm active and the cache in fallback, both arms use the fallback constant', async () => {
	const cache = createUndatedImputation({ now: () => NOW, log: quiet, retry: passRetry }); // unconfigured → fallback
	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_TEMPORAL_QUERY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
		const w = await doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory([point('d-in', 0.9, IN_WINDOW), point('u', 0.6, null)]), now: NOW, _undatedImputation: cache });
		const d = await doSearch(PLAIN_Q, 5, false, false, { memory: stubMemory([point('d-new', 0.5, Date.now() - 3 * DAY), point('u', 0.6, null)]), now: NOW, _undatedImputation: cache });
		assert.equal(score(w, 'u'), 0.6 * Math.exp(-0.25));
		assert.equal(score(d, 'u'), 0.6 * Math.exp(-0.25));
	});
});
