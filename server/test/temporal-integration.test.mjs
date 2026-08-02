/**
 * temporal-integration.test.mjs — Task 4 of the temporal query-resolution v1 arc.
 *
 * doSearch-level wiring: spec D-a (fetch width), D-a2 (truncation moves to the
 * handlers), D-b0 (temporalActive), D-c (substitution, not stacking), D-e (flag
 * gating), plus the registered checks E1, E1b, E1c, E1d, E1e, E2 and E2b.
 *
 * Stub-only — no keys, no qdrant, no container.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { doSearch, handleToolCall } from '../mem0-mcp-http.mjs';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);      // Wed 2026-08-05
const IN_WINDOW = Date.UTC(2026, 6, 29, 12, 0);  // inside "last week" (07-27..08-02)
const OUT_WINDOW = Date.UTC(2026, 5, 1, 12, 0);  // June — far outside

/**
 * Stub engine that HONORS opts.limit — the shared decay stub does not, which is
 * why E1's flag-off arm is unwritable against it (spec F17).
 */
function stubMemory(canned) {
	let lastCall = null;
	return {
		search: async (query, opts) => {
			lastCall = { query, opts };
			return { results: canned.slice(0, opts?.limit ?? canned.length) };
		},
		get lastCall() { return lastCall; },
	};
}

const point = (id, score, dateMs, extra = {}) => ({
	id,
	memory: `body of ${id}`,
	score,
	metadata: { id, title: id, ...(dateMs ? { valid_from: new Date(dateMs).toISOString() } : {}), ...extra },
});

/** 20 candidates; the in-window target sits at engine rank 9 (0-indexed 8). */
function corpus() {
	const rows = [];
	for (let i = 0; i < 20; i++) {
		rows.push(point(`doc-${i}`, 1 - i * 0.01, i === 8 ? IN_WINDOW : OUT_WINDOW));
	}
	return rows;
}

const withFlag = async (on, fn) => {
	const prev = process.env.UM_TEMPORAL_QUERY;
	if (on) process.env.UM_TEMPORAL_QUERY = 'true'; else delete process.env.UM_TEMPORAL_QUERY;
	try { return await fn(); } finally {
		if (prev === undefined) delete process.env.UM_TEMPORAL_QUERY; else process.env.UM_TEMPORAL_QUERY = prev;
	}
};

const TEMPORAL_Q = 'what did we decide last week about the sidecar';
const PLAIN_Q = 'what did we decide about the sidecar';
const ids = (r) => r.results.map((x) => x.id);

// ── E1 — mechanism ───────────────────────────────────────────────────────────

test('E1: the window surfaces an in-window doc the engine ranked below the cutoff', async () => {
	const off = await withFlag(false, () =>
		doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(corpus()), now: NOW }));
	assert.ok(!ids(off).includes('doc-8'), 'flag-off: the rank-9 target must be absent from the top 5');

	const on = await withFlag(true, () =>
		doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(corpus()), now: NOW }));
	assert.ok(ids(on).slice(0, 5).includes("doc-8"), "flag-on: the in-window target must be in the top 5 after re-rank");
});

test('E1(b): relevance still orders inside the window (not a date sort)', async () => {
	// The stronger-cosine in-window item is deliberately the OLDER one, so a pure
	// date-sort implementation fails this while still passing E1(a).
	const rows = [
		point('weak-newer', 0.30, IN_WINDOW + 2 * DAY),
		point('strong-older', 0.90, IN_WINDOW),
		point('filler', 0.50, OUT_WINDOW),
	];
	const r = await withFlag(true, () =>
		doSearch(TEMPORAL_Q, 3, false, false, { memory: stubMemory(rows), now: NOW }));
	const order = ids(r);
	assert.ok(order.indexOf('strong-older') < order.indexOf('weak-newer'),
		`cosine must still order within the window, got ${order.join(',')}`);
});

// ── E1b — zero in-window (D-b1 / D-b0) ───────────────────────────────────────

test('E1b: zero in-window is a no-op under BOTH UM_TEMPORAL_DECAY settings', async () => {
	// The registered form. The earlier 3-row/limit-3 fixture could not fail:
	// the widened fetch returned the same 3 rows either way, and the decay-on
	// arm — the one that actually pins D-b0/D-b1 — was never exercised.
	//
	// 30 rows at limit 5 puts the widened fetch (25) strictly between the two,
	// and cosine order is deliberately the REVERSE of recency order, so decay
	// over 25 candidates and decay over 5 produce provably different top-5s.
	const rows = [];
	for (let i = 0; i < 30; i++) {
		// Walk BACKWARD from OUT_WINDOW so every row is strictly outside the
		// window — walking forward would cross into it around i=19 and make
		// temporalActive true, which is not what this check is about.
		// Descending cosine, ascending recency: the strongest match is the oldest,
		// so decay-over-25 and decay-over-5 pick different top-5s if the pool is
		// not narrowed.
		rows.push(point(`d${i}`, 1 - i * 0.01, OUT_WINDOW - (29 - i) * 3 * DAY));
	}
	for (const decay of ['true', undefined]) {
		const prev = process.env.UM_TEMPORAL_DECAY;
		if (decay) process.env.UM_TEMPORAL_DECAY = decay; else delete process.env.UM_TEMPORAL_DECAY;
		try {
			const off = await withFlag(false, () =>
				doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(rows), now: NOW }));
			const on = await withFlag(true, () =>
				doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(rows), now: NOW }));
			assert.deepEqual(ids(on).slice(0, 5), ids(off).slice(0, 5),
				`UM_TEMPORAL_DECAY=${decay ?? 'unset'}: zero in-window must equal flag-off`);
		} finally {
			if (prev === undefined) delete process.env.UM_TEMPORAL_DECAY; else process.env.UM_TEMPORAL_DECAY = prev;
		}
	}
});

// ── E1c — exact fetch width (D-a) ────────────────────────────────────────────

test('E1c: fetch width is EXACT per caller limit, not merely >= base', async () => {
	// `>= base` would be satisfied by a commit deleting the widening entirely.
	for (const [limit, expected] of [[5, 25], [10, 50], [50, 50], [51, 51], [100, 100]]) {
		const mem = stubMemory(corpus());
		await withFlag(true, () => doSearch(TEMPORAL_Q, limit, false, false, { memory: mem, now: NOW }));
		assert.equal(mem.lastCall.opts.limit, expected,
			`limit=${limit} must fetch ${expected} (min(base*5,50) alone under-fetches above 50)`);
	}
});

test('E1c: flag-off fetch width is always exactly the caller limit', async () => {
	for (const limit of [5, 10, 51, 100]) {
		const mem = stubMemory(corpus());
		await withFlag(false, () => doSearch(TEMPORAL_Q, limit, false, false, { memory: mem, now: NOW }));
		assert.equal(mem.lastCall.opts.limit, limit);
	}
});

// ── E2 / E2b — negative controls ─────────────────────────────────────────────

test('E2: a query that parses to null is byte-identical flag-on vs flag-off', async () => {
	const memOff = stubMemory(corpus());
	const off = await withFlag(false, () => doSearch(PLAIN_Q, 5, false, true, { memory: memOff, now: NOW }));
	const memOn = stubMemory(corpus());
	const on = await withFlag(true, () => doSearch(PLAIN_Q, 5, false, true, { memory: memOn, now: NOW }));
	assert.deepEqual(on, off, 'results must be deep-equal');
	assert.equal(memOn.lastCall.opts.limit, memOff.lastCall.opts.limit, 'engine limit must be identical');
});

test('E2b: flag-off behavior on degenerate limits matches pre-change expectations', async () => {
	// E2 compares the two arms WITHIN the new code, so it is blind to a
	// regression landing on both arms. These are captured pre-change values.
	const cases = [[0, 5], [undefined, 5], [null, 5], [3, 3]];
	for (const [limit, expectedCount] of cases) {
		const mem = stubMemory(corpus());
		const r = await withFlag(false, () => doSearch(TEMPORAL_Q, limit, false, false, { memory: mem, now: NOW }));
		assert.equal(r.results.length, expectedCount, `limit=${String(limit)} must still return ${expectedCount}`);
	}
});

// ── D-c — substitution, not stacking ─────────────────────────────────────────

test('D-c: with a live window, decay is NOT also applied', async () => {
	const prev = process.env.UM_TEMPORAL_DECAY;
	process.env.UM_TEMPORAL_DECAY = 'true';
	try {
		const rows = [point('in', 0.5, IN_WINDOW), point('out', 0.9, OUT_WINDOW)];
		const r = await withFlag(true, () =>
			doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(rows), now: NOW }));
		const inScore = r.results.find((x) => x.id === 'in').score;
		// Under the window alone an in-window item is untouched (0.5). Under
		// stacking, decay would additionally shrink it by exp(-age/halfLife).
		assert.equal(inScore, 0.5, 'in-window score must be untouched — decay must not stack');
	} finally {
		if (prev === undefined) delete process.env.UM_TEMPORAL_DECAY; else process.env.UM_TEMPORAL_DECAY = prev;
	}
});

test('D-b0: zero in-window falls THROUGH to decay rather than skipping it', async () => {
	const prev = process.env.UM_TEMPORAL_DECAY;
	process.env.UM_TEMPORAL_DECAY = 'true';
	try {
		const rows = [point('a', 0.9, OUT_WINDOW), point('b', 0.9, OUT_WINDOW - 200 * DAY)];
		const on = await withFlag(true, () =>
			doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(rows), now: NOW }));
		// Decay must have run: the much older item is demoted below the newer one.
		assert.deepEqual(on.results.map((x) => x.id), ['a', 'b']);
		assert.ok(on.results[0].score < 0.9, 'decay must still apply when the window is empty');
	} finally {
		if (prev === undefined) delete process.env.UM_TEMPORAL_DECAY; else process.env.UM_TEMPORAL_DECAY = prev;
	}
});

// ── E1d / E1e — handler-level truncation + marker containment ────────────────

test('E1d: post-filters see the widened pool, so a filtered temporal query keeps its matches', async () => {
	// 20 candidates; 8 carry project 'alpha', 6 of those in-window at engine
	// ranks 6..20 — i.e. beyond a limit-5 fetch.
	const rows = [];
	for (let i = 0; i < 20; i++) {
		const alpha = i >= 5 && i < 13;
		rows.push(point(`d${i}`, 1 - i * 0.01, alpha && i >= 5 && i < 11 ? IN_WINDOW : OUT_WINDOW,
			alpha ? { project: 'alpha' } : { project: 'beta' }));
	}
	const call = (on) => withFlag(on, () => handleToolCall('memory_search', {
		query: TEMPORAL_Q, limit: 5, filters: { project: 'alpha' },
	}, { memory: stubMemory(rows), now: NOW }));

	const off = JSON.parse(await call(false));
	const on = JSON.parse(await call(true));
	assert.equal(off.results.length, 0, 'flag-off: the limit-5 cosine window contains no alpha docs');
	assert.equal(on.results.length, 5, 'flag-on: the widened pool must fill the caller limit');
	assert.ok(on.results.every((r) => r.id.startsWith('d')), 'sanity');
});

test('E1d: the handler still honors the caller limit exactly', async () => {
	const out = JSON.parse(await withFlag(true, () => handleToolCall('memory_search', {
		query: TEMPORAL_Q, limit: 5,
	}, { memory: stubMemory(corpus()), now: NOW })));
	assert.equal(out.results.length, 5, 'over-fetch must never leak past the caller limit');
});

test('E1e: the internal temporal marker never reaches the wire', async () => {
	const raw = await withFlag(true, () => handleToolCall('memory_search', {
		query: TEMPORAL_Q, limit: 5,
	}, { memory: stubMemory(corpus()), now: NOW }));
	assert.ok(!raw.includes('_temporal'), 'no internal marker may serialize');
	const env = await withFlag(true, () =>
		doSearch(TEMPORAL_Q, 5, false, false, { memory: stubMemory(corpus()), now: NOW }));
	assert.ok(!Object.keys(env).some((k) => k.startsWith('_')), 'marker must be non-enumerable');
	assert.ok(!JSON.stringify(env).includes('_temporal'));
});

// ── fail-open ────────────────────────────────────────────────────────────────

test('a throwing parser degrades to today\'s path (DI seam) and emits no counter', async () => {
	const emitted = [];
	const r = await withFlag(true, () => doSearch(TEMPORAL_Q, 5, false, false, {
		memory: stubMemory(corpus()),
		now: NOW,
		surface: 'claude-code',
		_parseTemporalWindow: () => { throw new Error('boom'); },
		_noteTemporalQuery: (e) => emitted.push(e),
	}));
	assert.equal(r.results.length, 5, 'search must still succeed');
	assert.equal(emitted.length, 0, 'a failed parse must not emit a counter row');
});

test('the prevalence counter fires with a surface and records the kind', async () => {
	const emitted = [];
	await withFlag(false, () => doSearch(TEMPORAL_Q, 5, false, false, {
		memory: stubMemory(corpus()), now: NOW, surface: 'claude-code',
		_noteTemporalQuery: (e) => emitted.push(e),
	}));
	assert.equal(emitted.length, 1, 'the parser runs (and counts) even with the flag OFF');
	assert.equal(emitted[0].kind, 'last_week');
});

test("a null parse records outcome 'none' so prevalence is self-contained", async () => {
	const emitted = [];
	await withFlag(false, () => doSearch(PLAIN_Q, 5, false, false, {
		memory: stubMemory(corpus()), now: NOW, surface: 'claude-code',
		_noteTemporalQuery: (e) => emitted.push(e),
	}));
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].kind, null);
});
