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
import { BOUNCER_SCORE_GATE } from '../lib/bouncer.mjs';

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

// T1 — this case used to assert ONLY `results.length === 2`. Under the undated policy its
// two items swap order, and a length assertion stays green through that, so "full suite
// green" was not evidence about the ranking change. It now pins order AND absolute scores.
test('decay: an undated doc is demoted below an equally-scored recent dated doc (order + absolute)', async () => {
	// Both start at cosine 0.5. The dated doc is 5 days old, so it barely decays; the
	// undated doc takes the flat imputed factor and lands well below it.
	const canned = [
		{ id: 'no-date', memory: 'x', score: 0.5, metadata: {} },
		result({ id: 'dated', score: 0.5, daysOld: 5 }),
	];
	const mock = mockMemory(canned);

	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);
		assert.equal(results.length, 2, 'both docs survive decay pass');

		// Order flipped: before the policy the undated doc kept 0.5 and TIED for first.
		assert.deepEqual(results.map((r) => r.id), ['dated', 'no-date']);

		// The undated score is EXACT — the imputed factor has no time term at all.
		// Literal Math.exp(-0.25), never the imported UNDATED_FACTOR: importing it would make
		// this hold for any constant. See ranking-undated-policy.test.mjs.
		const undated = results.find((r) => r.id === 'no-date');
		assert.equal(undated.score, 0.5 * Math.exp(-0.25));

		// The dated score carries real-clock drift between `daysAgo()` and Date.now(),
		// so it gets a tolerance rather than exact equality.
		const dated = results.find((r) => r.id === 'dated');
		assert.ok(
			Math.abs(dated.score - 0.5 * Math.exp(-5 / 30)) < 1e-6,
			`dated score ${dated.score} should be ~${0.5 * Math.exp(-5 / 30)}`,
		);
	});
});

// T2 — a doSearch-level mixed case asserting the ABSOLUTE top-1 score, which is the value
// `bounceTopHit` consumes (it gates on an absolute post-decay score, not a rank). This is
// the coupling worth having a test for: the policy moves undated items ACROSS that gate.
test('decay: mixed set — absolute top-1 score is the post-decay value the bouncer would gate on', async () => {
	// Chosen so the undated doc crosses BOUNCER_SCORE_GATE (0.60) because of the policy:
	//   before: undated 0.72 untouched  -> top-1, ABOVE the gate  (grading skipped)
	//   after:  undated 0.72 * exp(-0.25) = 0.5607 -> BELOW the gate (grading triggered),
	//           and the dated doc at 0.65 * exp(-3/30) = 0.5881 becomes top-1.
	// NOTE the retune margin: the ordering below needs 0.72 * exp(-E) < 0.5881, i.e.
	// E > 0.203 — this fixture is a genuine LOWER bound on any future retune of the
	// constant, and it reddens if the policy gets mild enough to stop crossing the gate.
	const canned = [
		{ id: 'undated-strong', memory: 'x', score: 0.72, metadata: {} },
		result({ id: 'dated-fresh', score: 0.65, daysOld: 3 }),
	];
	const mock = mockMemory(canned);

	await withEnv({ UM_TEMPORAL_DECAY: 'true', UM_DECAY_HALF_LIFE_DAYS: '30' }, async () => {
		const { results } = await doSearch('q', 5, false, false, mock);

		assert.deepEqual(results.map((r) => r.id), ['dated-fresh', 'undated-strong'],
			'the undated doc must no longer take top-1 on raw cosine alone');

		// bounceTopHit consumes items[0] and NOTHING else, so every gate assertion below is
		// on results[0]. An earlier version asserted the crossing on results[1] (rank 2,
		// which the bouncer never sees) and paired it with `assert.ok(0.72 > 0.60)` — two
		// literals, an assertion no production change could ever redden.
		//
		// Values are READ from `canned` and the gate is the REAL exported constant, not
		// retyped numbers: binding a literal to a name does not stop it constant-folding.
		// The point is that retuning BOUNCER_SCORE_GATE must redden this test rather than
		// silently leaving its narrative false.
		const undatedRaw = canned.find((c) => c.id === 'undated-strong').score;
		const datedRaw = canned.find((c) => c.id === 'dated-fresh').score;
		const datedDecayed = datedRaw * Math.exp(-3 / 30);

		assert.ok(
			Math.abs(results[0].score - datedDecayed) < 1e-6,
			`absolute top-1 score ${results[0].score} should be ~${datedDecayed}`,
		);

		// THE CROSSING, on the value the bouncer reads, against the gate it really uses
		// (bouncer.mjs gates on `topItem.score > BOUNCER_SCORE_GATE`, strict >).
		// Before the policy top-1 was the undated doc, ABOVE the gate → grading skipped.
		// After it, top-1 is the dated doc BELOW the gate → an LLM grade is triggered.
		assert.ok(undatedRaw > BOUNCER_SCORE_GATE, 'fixture precondition: the pre-policy top-1 sat above the gate');
		assert.ok(results[0].score < BOUNCER_SCORE_GATE, 'post-policy top-1 falls below the bouncer gate — real cost, real latency');

		// And the demoted doc's absolute value, exactly (the imputed factor has no time term).
		assert.equal(results[1].score, undatedRaw * Math.exp(-0.25));
	});
});
