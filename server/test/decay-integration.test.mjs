/**
 * decay-integration.test.mjs — integration test for temporal-decay wiring.
 *
 * Closes issue #8 (previously a placeholder). Exercises doSearch() from
 * mem0-mcp-http.mjs with a mocked memory client to verify:
 *   - UM_TEMPORAL_DECAY env var gates the behavior (off by default)
 *   - UM_DECAY_HALF_LIFE_DAYS env var is honored (default 30)
 *   - Status filter runs BEFORE decay (superseded docs don't get re-ranked)
 *   - includeSuperseded=true bypasses the filter
 *
 * Why "integration" and not just "unit": the underlying math
 * (applyTemporalDecay) is covered in ranking.test.mjs. This test exercises
 * the WIRING — env-var reads, filter+decay ordering, the full doSearch
 * code path a real request would hit — with a fake memory client so the
 * test runs in milliseconds without Qdrant / OpenAI / Docker.
 *
 * Implementation: mem0-mcp-http.mjs exports doSearch and accepts an
 * optional `memoryClient` param for dependency injection. Module-level
 * bootstrap is guarded by IS_MAIN so importing for tests does not start
 * a real HTTP server or call initMemory().
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { doSearch } from '../mem0-mcp-http.mjs';

// ---------------------------------------------------------------------------
// Fixtures — ISO-8601 strings at known offsets from "now"
// ---------------------------------------------------------------------------
const NOW = new Date();
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

/** Make a memory-like result with a deterministic shape */
function result({ id, score, daysOld, status, invalidated_at }) {
	return {
		id,
		memory: `text-${id}`,
		score,
		metadata: {
			schema_version: 1,
			type: 'session_summary',
			id,
			valid_from: daysAgo(daysOld),
			...(status != null ? { status } : {}),
			...(invalidated_at !== undefined ? { invalidated_at } : {}),
		},
	};
}

/** Mock memory client — returns whatever canned results you hand it */
function mockMemory(cannedResults) {
	let lastCall = null;
	return {
		search: async (query, opts) => {
			lastCall = { query, opts };
			return { results: cannedResults };
		},
		get lastCall() { return lastCall; },
	};
}

// ---------------------------------------------------------------------------
// Env-var sandbox helpers — restore after each test so suites don't bleed.
// ---------------------------------------------------------------------------
async function withEnv(overrides, fn) {
	const saved = {};
	for (const key of Object.keys(overrides)) {
		saved[key] = process.env[key];
		if (overrides[key] === undefined) delete process.env[key];
		else process.env[key] = overrides[key];
	}
	try {
		// IMPORTANT: await so finally runs AFTER fn's promise resolves, not before.
		return await fn();
	} finally {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('decay: off by default — mem0 order preserved', async () => {
	// Two results: old+high-score, recent+low-score. Without decay, the
	// mem0-side score determines order.
	const canned = [
		result({ id: 'old-high', score: 0.9, daysOld: 365 }),
		result({ id: 'recent-low', score: 0.3, daysOld: 1 }),
	];
	const mock = mockMemory(canned);

	await withEnv({ UM_TEMPORAL_DECAY: undefined }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);
		assert.equal(results.length, 2);
		assert.equal(results[0].id, 'old-high', 'old doc should stay first — no decay applied');
		assert.equal(results[0].score, 0.9, 'score unchanged when decay off');
	});
});

test('decay: on — recent doc outranks older doc with higher mem0 score', async () => {
	const canned = [
		result({ id: 'old-high', score: 0.9, daysOld: 120 }),  // 4 half-lives old at default 30d
		result({ id: 'recent-low', score: 0.3, daysOld: 1 }),
	];
	const mock = mockMemory(canned);

	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);
		// After 4 half-lives, old doc's 0.9 decays to ~0.056. Recent doc's 0.3
		// barely decays at 1 day — stays near 0.29. Recent wins.
		const recent = results.find((r) => r.id === 'recent-low');
		const old = results.find((r) => r.id === 'old-high');
		assert.ok(recent && old, 'both docs present after decay');
		assert.ok(
			recent.score > old.score,
			`recent.score (${recent.score}) should beat old.score (${old.score}) after decay`,
		);
	});
});

test('decay: UM_DECAY_HALF_LIFE_DAYS is honored', async () => {
	const canned = [
		result({ id: 'mid-age', score: 0.5, daysOld: 10 }),
	];
	const mock = mockMemory(canned);

	let longHalfLifeScore;
	let shortHalfLifeScore;

	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '90' }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);
		longHalfLifeScore = results[0].score;
	});

	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '5' }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);
		shortHalfLifeScore = results[0].score;
	});

	// 10 days old @ 90-day half-life → decay factor ~0.926 (score ~0.463)
	// 10 days old @  5-day half-life → decay factor 0.25    (score ~0.125)
	// Longer half-life = less decay = higher surviving score.
	assert.ok(
		longHalfLifeScore > shortHalfLifeScore,
		`90-day half-life score (${longHalfLifeScore}) should exceed 5-day (${shortHalfLifeScore})`,
	);
});

test('filter + decay: status filter applies BEFORE decay (superseded doc excluded, not just demoted)', async () => {
	const canned = [
		result({ id: 'current-old', score: 0.4, daysOld: 60 }),
		result({ id: 'superseded-recent', score: 0.95, daysOld: 1, status: 'superseded' }),
	];
	const mock = mockMemory(canned);

	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);
		assert.equal(results.length, 1, 'superseded doc filtered out');
		assert.equal(results[0].id, 'current-old', 'only current doc remains');
	});
});

test('filter: invalidated_at doc excluded by default', async () => {
	const canned = [
		result({ id: 'alive', score: 0.4, daysOld: 1 }),
		result({ id: 'invalidated', score: 0.9, daysOld: 1, invalidated_at: daysAgo(0) }),
	];
	const mock = mockMemory(canned);

	const { results } = await doSearch('q', 5, false, false, mock);
	assert.equal(results.length, 1);
	assert.equal(results[0].id, 'alive');
});

test('includeSuperseded=true bypasses all status/invalidation filtering', async () => {
	const canned = [
		result({ id: 'current', score: 0.5, daysOld: 1 }),
		result({ id: 'superseded', score: 0.4, daysOld: 1, status: 'superseded' }),
		result({ id: 'deprecated', score: 0.3, daysOld: 1, status: 'deprecated' }),
		result({ id: 'rejected', score: 0.2, daysOld: 1, status: 'rejected' }),
		result({ id: 'invalidated', score: 0.1, daysOld: 1, invalidated_at: daysAgo(0) }),
	];
	const mock = mockMemory(canned);

	const { results } = await doSearch('q', 10, true, false, mock);
	assert.equal(results.length, 5, 'all docs returned when includeSuperseded=true');
});

test('decay does NOT crash on docs with missing valid_from (graceful fallback)', async () => {
	// applyTemporalDecay should handle docs without valid_from — common for
	// legacy docs that predate the frontmatter schema.
	const canned = [
		{ id: 'no-date', memory: 'x', score: 0.5, metadata: {} },
		result({ id: 'dated', score: 0.5, daysOld: 5 }),
	];
	const mock = mockMemory(canned);

	await withEnv({ UM_TEMPORAL_DECAY: 'true' }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);
		assert.equal(results.length, 2, 'both docs survive decay pass');
	});
});
