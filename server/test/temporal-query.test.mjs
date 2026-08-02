/**
 * temporal-query.test.mjs — Task 1 of the temporal query-resolution v1 arc.
 *
 * Covers spec D-d: the deterministic date-expression parser. Every case injects a
 * fixed `now`, so no assertion depends on wall-clock time.
 *
 * Registered checks exercised here:
 *   E3  — parser precision AND recall (conjunction; a null-returning parser must fail)
 *   E3b — ReDoS measured, not asserted (timing bound over adversarial inputs)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parseTemporalWindow,
	TEMPORAL_KINDS,
	isTemporalKind,
	TEMPORAL_PATTERNS,
	TEMPORAL_PARSE_MAX_CHARS,
	MAX_RELATIVE_N,
} from '../lib/temporal-query.mjs';

// Fixed reference instant: Wednesday 2026-08-05T14:30:00Z.
// Chosen mid-week/mid-month/mid-year so week/month/year boundaries are all
// unambiguous and a rollover bug cannot coincidentally pass.
const NOW = Date.UTC(2026, 7, 5, 14, 30, 0);
const iso = (ms) => new Date(ms).toISOString();
const parse = (q, now = NOW) => parseTemporalWindow(q, { now });

// ── positive cases: one per kind, exact boundaries ────────────────────────────

test('today → start of UTC day .. now', () => {
	const w = parse('what did I decide today about the sidecar');
	assert.equal(w.kind, 'today');
	assert.equal(iso(w.start), '2026-08-05T00:00:00.000Z');
	assert.equal(w.end, NOW, 'end edge is now, never end-of-day');
});

test('yesterday → the whole previous UTC day', () => {
	const w = parse('yesterday notes');
	assert.equal(w.kind, 'yesterday');
	assert.equal(iso(w.start), '2026-08-04T00:00:00.000Z');
	assert.equal(iso(w.end), '2026-08-04T23:59:59.999Z');
});

test('this week → ISO week start (Monday) .. now, never into the future', () => {
	const w = parse('this week deploys');
	assert.equal(w.kind, 'this_week');
	assert.equal(iso(w.start), '2026-08-03T00:00:00.000Z', 'Monday of the ISO week containing Wed 08-05');
	assert.equal(w.end, NOW);
});

test('last week → the full previous Mon..Sun', () => {
	const w = parse('what did we decide last week about the sidecar');
	assert.equal(w.kind, 'last_week');
	assert.equal(iso(w.start), '2026-07-27T00:00:00.000Z');
	assert.equal(iso(w.end), '2026-08-02T23:59:59.999Z');
});

test('this month → 1st .. now', () => {
	const w = parse('this month summary');
	assert.equal(w.kind, 'this_month');
	assert.equal(iso(w.start), '2026-08-01T00:00:00.000Z');
	assert.equal(w.end, NOW);
});

test('last month → the full previous calendar month', () => {
	const w = parse('last month retro');
	assert.equal(w.kind, 'last_month');
	assert.equal(iso(w.start), '2026-07-01T00:00:00.000Z');
	assert.equal(iso(w.end), '2026-07-31T23:59:59.999Z');
});

test('this year / last year → calendar years', () => {
	const t = parse('this year roadmap');
	assert.equal(t.kind, 'this_year');
	assert.equal(iso(t.start), '2026-01-01T00:00:00.000Z');
	assert.equal(t.end, NOW);

	const l = parse('last year roadmap');
	assert.equal(l.kind, 'last_year');
	assert.equal(iso(l.start), '2025-01-01T00:00:00.000Z');
	assert.equal(iso(l.end), '2025-12-31T23:59:59.999Z');
});

test('on <YYYY-MM-DD> → that single UTC day', () => {
	const w = parse('what landed on 2026-07-14');
	assert.equal(w.kind, 'on_date');
	assert.equal(iso(w.start), '2026-07-14T00:00:00.000Z');
	assert.equal(iso(w.end), '2026-07-14T23:59:59.999Z');
});

test('since <YYYY-MM-DD> → [date, now]; end edge is now, not end-of-day', () => {
	const w = parse('changes since 2026-07-14');
	assert.equal(w.kind, 'since_date');
	assert.equal(iso(w.start), '2026-07-14T00:00:00.000Z');
	assert.equal(w.end, NOW);
});

test('last N days / weeks / months', () => {
	const d = parse('in the last 3 days');
	assert.equal(d.kind, 'last_n');
	assert.equal(iso(d.start), '2026-08-02T14:30:00.000Z');
	assert.equal(d.end, NOW);

	const w = parse('past 2 weeks');
	assert.equal(iso(w.start), '2026-07-22T14:30:00.000Z');

	const m = parse('the last 2 months');
	assert.equal(iso(m.start), '2026-06-05T14:30:00.000Z');
});

test('last N months uses calendar subtraction with end-of-month clamping', () => {
	// 2026-03-31 minus 1 month must clamp to 02-28, not overflow into March.
	const w = parse('last 1 month', Date.UTC(2026, 2, 31, 12, 0, 0));
	assert.equal(iso(w.start), '2026-02-28T12:00:00.000Z');
});

// ── in <Month> — the year-defaulting rule ─────────────────────────────────────

test('in <Month> with no year → most recent occurrence at or before now', () => {
	const w = parse('what did we decide in March about the sidecar');
	assert.equal(w.kind, 'in_month');
	assert.equal(iso(w.start), '2026-03-01T00:00:00.000Z');
	assert.equal(iso(w.end), '2026-03-31T23:59:59.999Z');
});

test('in <Month> rolls back a year when the month is still ahead in this one', () => {
	// In January 2026, "in December" means December 2025 — not the coming one.
	const jan = Date.UTC(2026, 0, 15, 9, 0, 0);
	const w = parse('in December', jan);
	assert.equal(iso(w.start), '2025-12-01T00:00:00.000Z');
	assert.equal(iso(w.end), '2025-12-31T23:59:59.999Z');
});

test('in <Month> <YYYY> with an explicit future year parses as given', () => {
	const w = parse('in March 2027');
	assert.equal(iso(w.start), '2027-03-01T00:00:00.000Z');
	// Window simply contains nothing; D-b1 makes it a no-op downstream.
});

test('during <Month> is accepted alongside "in"', () => {
	assert.equal(parse('during July').kind, 'in_month');
});

// ── priority order ───────────────────────────────────────────────────────────

test('a query matching two patterns resolves deterministically to the higher-priority one', () => {
	// on_date outranks last_week.
	const w = parse('last week vs on 2026-07-14');
	assert.equal(w.kind, 'on_date');
});

// ── E3 precision: the false-positive gate ────────────────────────────────────

const NEGATIVES = [
	'the March release notes',            // bare month, no preposition
	'what does may() return',             // project/function name colliding with the inventory
	'"last week" as a literal string',    // quoted content
	'how does the augustine module work', // month name as a substring
	'summarize the sidecar decision',
	'what is the current lane classifier default',
	'show me the reaction gate accept rule',
	'january_report.md schema',           // month name inside an identifier
];

test('E3 precision: realistic non-temporal queries all parse to null (zero false positives)', () => {
	for (const q of NEGATIVES) {
		assert.equal(parse(q), null, `false positive on: ${q}`);
	}
});

test('E3 recall: every kind in TEMPORAL_KINDS is reachable by at least one query', () => {
	// The conjunction half of E3 — without this, a parser that returns null for
	// everything would score a perfect precision run.
	const reached = new Set([
		'today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month',
		'this_year', 'last_year', 'on_date', 'since_date', 'last_n', 'in_month',
	].map((k) => {
		const q = {
			today: 'today', yesterday: 'yesterday', this_week: 'this week',
			last_week: 'last week', this_month: 'this month', last_month: 'last month',
			this_year: 'this year', last_year: 'last year',
			on_date: 'on 2026-07-14', since_date: 'since 2026-07-14',
			last_n: 'last 3 days', in_month: 'in March',
		}[k];
		const w = parse(q);
		assert.ok(w, `kind ${k} unreachable via "${q}"`);
		return w.kind;
	}));
	assert.deepEqual(reached, new Set(TEMPORAL_KINDS), 'every declared kind must be reachable');
});

// ── fail-open + input bounds ─────────────────────────────────────────────────

test('non-string and degenerate inputs return null rather than throwing', () => {
	for (const bad of [null, undefined, 42, {}, [], '']) {
		assert.equal(parseTemporalWindow(bad, { now: NOW }), null);
	}
});

test('N is bounded — an absurd N returns null, never a NaN window', () => {
	assert.equal(parse('last 999999999 days'), null);
	assert.equal(parse(`last ${MAX_RELATIVE_N + 1} days`), null);
	const ok = parse(`last ${MAX_RELATIVE_N} days`);
	assert.ok(Number.isFinite(ok.start) && Number.isFinite(ok.end));
});

test('a 2 MB query returns null in bounded time (input is capped, not scanned)', () => {
	const huge = 'a'.repeat(2 * 1024 * 1024);
	const t0 = process.hrtime.bigint();
	assert.equal(parse(huge), null);
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	assert.ok(ms < 50, `parse took ${ms.toFixed(1)}ms on a 2MB input`);
});

test('only the first TEMPORAL_PARSE_MAX_CHARS are matched', () => {
	const buried = 'x'.repeat(TEMPORAL_PARSE_MAX_CHARS) + ' last week';
	assert.equal(parse(buried), null, 'a phrase past the cap must not be seen');
});

// ── E3b: ReDoS measured, not asserted ────────────────────────────────────────

test('E3b: no pattern backtracks catastrophically on adversarial inputs', () => {
	const N = TEMPORAL_PARSE_MAX_CHARS;
	const adversarial = [
		'in ' + 'a'.repeat(N),
		'last ' + '9'.repeat(N),
		'since ' + '2026-'.repeat(N / 5),
		'last' + ' '.repeat(N) + 'week',
		'week '.repeat(N / 5),
		'on ' + '2026-07-'.repeat(N / 8),
	];
	const t0 = process.hrtime.bigint();
	for (const input of adversarial) {
		for (const { re } of TEMPORAL_PATTERNS) re.test(input.slice(0, N));
	}
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	assert.ok(ms < 50, `pattern sweep took ${ms.toFixed(1)}ms — possible catastrophic backtracking`);
});

test('E3b tripwire: no pattern source contains a nested quantifier', () => {
	// Cheap syntactic check kept alongside the timing test above. It is a proxy
	// (it misses overlapping alternation like (a|a)*), which is exactly why the
	// measured timing assertion is the real gate.
	const nested = /\([^)]*[+*]\)[+*]/;
	for (const { kind, re } of TEMPORAL_PATTERNS) {
		assert.equal(nested.test(re.source), false, `nested quantifier in pattern for ${kind}: ${re.source}`);
	}
});

test('TEMPORAL_KINDS is genuinely immutable and matches the pattern table', () => {
	// Object.freeze(new Set()) does NOT block .add() — the vocabulary must be a
	// frozen array so the bounded-outcome guarantee is real, not advertised.
	assert.ok(Object.isFrozen(TEMPORAL_KINDS));
	assert.throws(() => { TEMPORAL_KINDS.push('injected'); });
	for (const { kind } of TEMPORAL_PATTERNS) {
		assert.ok(TEMPORAL_KINDS.includes(kind), `pattern kind ${kind} missing from TEMPORAL_KINDS`);
	}
	assert.equal(isTemporalKind('last_week'), true);
	assert.equal(isTemporalKind('in_month:2026-03'), false, 'interpolated kinds must be rejected');
});

// ── apostrophes are not quote delimiters ─────────────────────────────────────
// A single-quote span requires whitespace/BOL before the opener and
// whitespace/EOL/punctuation after the closer. Without that, ordinary English
// possessives and contractions pair up and blank the phrase between them —
// which would be a silent false negative in the feature AND a systematic
// under-count in the flag-off prevalence measurement that justifies the arc.

test('contractions and possessives do NOT suppress a temporal phrase', () => {
	for (const q of [
		"what's the plan we made last week for Bob's project",
		"here's what we didn't decide last month about Ana's connector",
		"the team's call yesterday — didn't it cover Bob's issue?",
	]) {
		assert.ok(parse(q), `apostrophes must not blank the phrase in: ${q}`);
	}
});

test('genuinely quoted spans are still blanked', () => {
	assert.equal(parse('"last week" as a literal string'), null);
	assert.equal(parse('search for `last week` verbatim'), null);
	assert.equal(parse("the phrase 'last week' in quotes"), null);
});

test('E3b covers the quote-blanking pattern too, not just the kind table', () => {
	const N = TEMPORAL_PARSE_MAX_CHARS;
	const inputs = ['"'.repeat(N), "'".repeat(N), '`'.repeat(N), '"' + 'a'.repeat(N)];
	const t0 = process.hrtime.bigint();
	for (const s of inputs) parseTemporalWindow(s.slice(0, N), { now: NOW });
	const ms = Number(process.hrtime.bigint() - t0) / 1e6;
	assert.ok(ms < 50, `quote-blanking sweep took ${ms.toFixed(1)}ms`);
});

// ── E3 precision, registered form: the INDEPENDENT negative set ──────────────
// The 8 rows above were authored alongside the pattern table, so they can only
// contain failure modes already anticipated. recall-set.jsonl's 66 queries were
// written for an unrelated eval by someone not looking at these regexes — that
// independence is the whole point of the registered wording, and it is the half
// that can actually falsify the patterns.

test('E3 precision: zero false positives across the 66 independently-authored queries', async () => {
	const { readFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const path = fileURLToPath(new URL('../eval/recall-set.jsonl', import.meta.url));
	const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
	assert.equal(rows.length, 66, 'a shrunk corpus must fail loudly, not silently weaken the gate');
	const falsePositives = rows
		.map((r) => ({ q: r.query, w: parse(r.query) }))
		.filter((x) => x.w !== null);
	assert.deepEqual(falsePositives, [], `false positives: ${falsePositives.map((x) => `"${x.q}" -> ${x.w?.kind}`).join('; ')}`);
});

// ── now-anchored vs fixed-calendar windows ───────────────────────────────────
// Clock-skew tolerance may only apply where the end edge IS `now` (spec D-d).
// A fixed calendar boundary has no drift to absorb, so widening it would be a
// silent semantic change, not a robustness measure.

test('now-anchored kinds are flagged; fixed-calendar kinds are not', () => {
	for (const q of ['today', 'this week', 'this month', 'this year', 'since 2026-07-14', 'last 3 days']) {
		assert.equal(parse(q).nowAnchored, true, `${q} ends at now`);
	}
	for (const q of ['yesterday', 'last week', 'last month', 'last year', 'on 2026-07-14', 'in March']) {
		assert.equal(parse(q).nowAnchored, false, `${q} ends on a calendar boundary`);
	}
});

test('every now-anchored window actually ends at the injected now', () => {
	for (const q of ['today', 'this week', 'this month', 'this year', 'since 2026-07-14', 'last 3 days']) {
		assert.equal(parse(q).end, NOW, `${q}: end edge must be exactly now`);
	}
});
