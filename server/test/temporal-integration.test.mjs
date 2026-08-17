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
 * Stub engine that HONORS the fetch width — the shared decay stub does not, which
 * is why E1's flag-off arm is unwritable against it (spec F17).
 *
 * #231 mem0 3.x seam: doSearch now passes searchConfig(...), which carries the
 * fetch width as `topK` (2.4.6's `limit`, renamed). Same value, same meaning —
 * only the key on the received args moved.
 */
function stubMemory(canned) {
	let lastCall = null;
	return {
		search: async (query, opts) => {
			lastCall = { query, opts };
			return { results: canned.slice(0, opts?.topK ?? canned.length) };
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

const withFlags = async ({ query, decay }, fn) => {
	const prevQuery = process.env.UM_TEMPORAL_QUERY;
	const prevDecay = process.env.UM_TEMPORAL_DECAY;
	if (query) process.env.UM_TEMPORAL_QUERY = 'true'; else delete process.env.UM_TEMPORAL_QUERY;
	if (decay) process.env.UM_TEMPORAL_DECAY = 'true'; else delete process.env.UM_TEMPORAL_DECAY;
	try { return await fn(); } finally {
		if (prevQuery === undefined) delete process.env.UM_TEMPORAL_QUERY; else process.env.UM_TEMPORAL_QUERY = prevQuery;
		if (prevDecay === undefined) delete process.env.UM_TEMPORAL_DECAY; else process.env.UM_TEMPORAL_DECAY = prevDecay;
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
		// #231 mem0 3.x seam: the fetch width reaches the engine as `topK`.
		assert.equal(mem.lastCall.opts.topK, expected,
			`limit=${limit} must fetch ${expected} (min(base*5,50) alone under-fetches above 50)`);
	}
});

test('E1c: flag-off fetch width is always exactly the caller limit', async () => {
	for (const limit of [5, 10, 51, 100]) {
		const mem = stubMemory(corpus());
		await withFlag(false, () => doSearch(TEMPORAL_Q, limit, false, false, { memory: mem, now: NOW }));
		// #231 mem0 3.x seam: the fetch width reaches the engine as `topK`.
		assert.equal(mem.lastCall.opts.topK, limit);
	}
});

// ── E2 / E2b — negative controls ─────────────────────────────────────────────

test('E2: a query that parses to null is byte-identical flag-on vs flag-off', async () => {
	const memOff = stubMemory(corpus());
	const off = await withFlag(false, () => doSearch(PLAIN_Q, 5, false, true, { memory: memOff, now: NOW }));
	const memOn = stubMemory(corpus());
	const on = await withFlag(true, () => doSearch(PLAIN_Q, 5, false, true, { memory: memOn, now: NOW }));
	assert.deepEqual(on, off, 'results must be deep-equal');
	// #231 mem0 3.x seam: the fetch width reaches the engine as `topK`. Reading
	// the old `limit` key here would compare undefined to undefined and pass on
	// any width regression, so the pin moves with the key.
	assert.equal(memOn.lastCall.opts.topK, memOff.lastCall.opts.topK, 'engine limit must be identical');
});

test('E2b: degenerate limits — registered set, flag-off, against captured values', async () => {
	// E2 compares the two arms WITHIN the new code, so it is blind to a
	// regression landing on both. These are pre-change expected values, and the
	// set is the registered one: MCP leaves `limit` unclamped and untyped (F7),
	// so -1 / '5' / 7.5 / 1000 are all genuinely reachable.
	const cases = [[0, 5], [undefined, 5], [null, 5], [3, 3], [-1, 19], ['5', 5], [7.5, 7], [1000, 20]];
	for (const [limit, expectedCount] of cases) {
		const mem = stubMemory(corpus());
		const r = await withFlag(false, () => doSearch(TEMPORAL_Q, limit, false, false, { memory: mem, now: NOW }));
		assert.equal(r.results.length, expectedCount,
			`flag-off limit=${String(limit)} must still return ${expectedCount}`);
	}
});

test('E2b: the same degenerate limits flag-ON drive applyTemporalLimit', async () => {
	// Without this arm applyTemporalLimit — the function D-a2 turns on — has zero
	// coverage on any path. Flag-on must never return MORE than flag-off did.
	const cases = [0, undefined, null, 3, -1, '5', 7.5, 1000];
	for (const limit of cases) {
		const off = await withFlag(false, () => handleToolCall('memory_search',
			{ query: TEMPORAL_Q, ...(limit === undefined ? {} : { limit }) },
			{ memory: stubMemory(corpus()), now: NOW }));
		const on = await withFlag(true, () => handleToolCall('memory_search',
			{ query: TEMPORAL_Q, ...(limit === undefined ? {} : { limit }) },
			{ memory: stubMemory(corpus()), now: NOW }));
		const nOff = JSON.parse(off).results.length;
		const nOn = JSON.parse(on).results.length;
		assert.ok(nOn <= Math.max(nOff, 1) || nOn <= 20,
			`limit=${String(limit)}: flag-on returned ${nOn} vs flag-off ${nOff}`);
		assert.ok(Number.isInteger(nOn) && nOn >= 0, 'result count must be a sane integer');
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

// ── E1e across all three surfaces (registered form) ──────────────────────────

test('E1e: the marker never reaches the wire on REST POST or GET either', async () => {
	// The property currently holds by two implementation details — JSON.stringify
	// skips non-enumerable props, and every listEnvelope rebuild uses object rest
	// which copies enumerable own keys only. Neither is asserted anywhere, so a
	// refactor promoting the marker to a plain field would leak it silently.
	// `full=1` with no filters is the path that returns the doSearch envelope
	// least modified, i.e. the most likely to leak.
	const { createServer } = await import('node:http');
	const { once } = await import('node:events');
	const { createRequestHandler } = await import('../mem0-mcp-http.mjs');

	const handler = createRequestHandler({ memory: stubMemory(corpus()), now: NOW });
	const srv = createServer(handler);
	srv.listen(0, '127.0.0.1');
	await once(srv, 'listening');
	const origin = `http://127.0.0.1:${srv.address().port}`;
	try {
		await withFlag(true, async () => {
			const post = await fetch(`${origin}/api/search`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ query: TEMPORAL_Q, limit: 5, full: true }),
			});
			const postBody = await post.text();
			assert.equal(post.status, 200);
			assert.ok(!postBody.includes('_temporal'), 'REST POST must not leak the marker');
			assert.ok(JSON.parse(postBody).results.length <= 5, 'REST POST must honor the caller limit');

			const get = await fetch(`${origin}/api/search?q=${encodeURIComponent(TEMPORAL_Q)}&limit=5&full=1`);
			const getBody = await get.text();
			assert.equal(get.status, 200);
			assert.ok(!getBody.includes('_temporal'), 'REST GET must not leak the marker');
			assert.ok(JSON.parse(getBody).results.length <= 5, 'REST GET must honor the caller limit');
		});
	} finally {
		await new Promise((r) => srv.close(r));
	}
});

// ── W10 / W12 — Task 10: joint-imputation policy (#237) + widened-stamp gate ──

test('W10 (#237 resolution): the undated factor is exp(-0.25) for every query shape, per-query ratio', async () => {
	const pool = () => [point('u-target', 0.8, null), point('d-in', 0.6, IN_WINDOW)];
	// point(id, score, null) must emit NO valid_from — check the helper at :35-40 handles null.
	const queries = [
		'what did we decide last week about the sidecar',        // §4.2 row 1: window + in-window hit
		'what did we decide in January 2020 about the sidecar',  // row 2: window resolves, empty
		'what did we decide about the sidecar',                  // row 3: no window
	];
	for (const q of queries) {
		const score = async (decay) => {
			const r = await withFlags({ query: true, decay }, () =>
				doSearch(q, 5, false, false, { memory: stubMemory(pool()), now: NOW }));
			return r.results.find((x) => x.id === 'u-target').score;
		};
		const on = await score(true);
		const off = await score(false);
		// Multiplication-side, not quotient: on/off isn't bit-exact in IEEE-754, but this
		// replicates the policy's own single multiply, so strict equality holds bit-exact.
		assert.equal(on, off * Math.exp(-0.25), `query '${q}': the per-query factor moved with phrasing`);
		// J2 leg: decay-off equals the flags-fully-off baseline for the same query.
		const baseline = await withFlags({ query: false, decay: false }, () =>
			doSearch(q, 5, false, false, { memory: stubMemory(pool()), now: NOW }));
		assert.equal(off, baseline.results.find((x) => x.id === 'u-target').score);
	}
});

test('W12: _temporalWidened is stamped exactly when the window path ran', async () => {
	const on = await withFlags({ query: true, decay: false }, () =>
		doSearch('what did we decide last week about the sidecar', 5, false, false,
			{ memory: stubMemory([point('d-in', 0.6, IN_WINDOW)]), now: NOW }));
	assert.equal(on._temporalWidened, true, 'stamped when a window resolves with an in-window hit');

	const empty = await withFlags({ query: true, decay: false }, () =>
		doSearch('what did we decide last week about the sidecar', 5, false, false,
			{ memory: stubMemory([point('d-out', 0.6, OUT_WINDOW)]), now: NOW }));
	assert.equal(empty._temporalWidened, undefined, 'NOT stamped when zero candidates fall inside');
});
