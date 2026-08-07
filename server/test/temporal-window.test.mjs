/**
 * temporal-window.test.mjs — Task 2b of the temporal query-resolution v1 arc.
 *
 * Covers spec D-b (mechanism), D-b0 (temporalActive semantics), D-b1 (zero-in-window
 * skip), D-b2 (span-scaled falloff + demotion floor), D-b3 (input contract) and
 * D-h REVISED (resolveItemDate grades on valid_from ONLY).
 *
 * Every case supplies an explicit window, so nothing depends on the parser or on
 * wall-clock time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyTemporalWindow,
	resolveItemDate,
	countInWindow,
	windowFalloffDays,
	DEMOTION_FLOOR,
	CLOCK_SKEW_TOLERANCE_MS,
} from '../lib/ranking.mjs';

const DAY = 86400000;
const T = (isoDay) => Date.UTC(2026, 6, isoDay); // July 2026
const item = (id, score, date, extra = {}) => ({
	id, score, metadata: date ? { valid_from: new Date(date).toISOString() } : {}, ...extra,
});
const ids = (rows) => rows.map((r) => r.id);

// A one-week window: 2026-07-13 .. 2026-07-19 inclusive.
const WEEK = { start: T(13), end: T(19) + DAY - 1, kind: 'last_week' };

// ── D-h REVISED: valid_from is the only ranking date ─────────────────────────

test('resolveItemDate grades on valid_from only — createdAt is NOT a ranking date', () => {
	assert.equal(resolveItemDate({ metadata: { valid_from: '2026-07-15T00:00:00Z' } }), Date.UTC(2026, 6, 15));

	// MECHANISM CORRECTED 2026-08-05 — see lib/ranking.mjs's resolveItemDate. This
	// comment used to say "createdAt is bulk-arrival time for exactly the points lacking
	// valid_from", which was MEASURED FALSE: createdAt is genuine WRITE time and survived
	// the reindex intact. It is uninformative only where a bulk operation wrote many
	// points at one instant (164 of 186). The conclusion is unchanged — an arrival stamp
	// is never a ranking date — but the wrong reason invites a backfill that cannot exist.
	assert.equal(resolveItemDate({ createdAt: '2026-07-15T00:00:00Z' }), null);
	assert.equal(resolveItemDate({ created_at: '2026-07-15T00:00:00Z' }), null);
});

test('resolveItemDate: absent, empty, or unparseable all mean "no resolvable date"', () => {
	assert.equal(resolveItemDate({}), null);
	assert.equal(resolveItemDate({ metadata: {} }), null);
	assert.equal(resolveItemDate({ metadata: { valid_from: '' } }), null);
	assert.equal(resolveItemDate({ metadata: { valid_from: 'not-a-date' } }), null);
	assert.equal(resolveItemDate(null), null);
});

test('an undated item keeps its original score and is never demoted (D-b1 path)', () => {
	// NOTE: this fixture has NO in-window item, so the D-b1 early return fires and the
	// per-item map is never reached. It pins D-b1, not the undated branch — the case below
	// is the one that actually exercises the branch.
	const rows = [item('dated-out', 0.9, T(1)), item('undated', 0.5, null)];
	const out = applyTemporalWindow(rows, WEEK);
	const undated = out.find((r) => r.id === 'undated');
	assert.equal(undated.score, 0.5, 'undated items are neutral, not penalised');
});

test('an undated item is untouched even when the window IS active (reaches the branch)', () => {
	// The invariant this pins became LOAD-BEARING with the undated-decay policy: decay now
	// imputes exp(-0.25) for an undated point while the window path deliberately does not, and
	// the two imputations must be chosen JOINTLY (see lib/ranking.mjs's module header). That
	// asymmetry is a documented design point, so it needs a test that can actually fail.
	//
	// It previously had none: the only undated case short-circuits on D-b1, so a mutant
	// demoting undated items inside applyTemporalWindow passed the whole suite.
	const rows = [
		item('dated-in', 0.9, T(15)),      // inside WEEK (13..19) → D-b1 does NOT fire
		item('dated-out', 0.8, T(1)),      // well before the window → demoted
		item('undated', 0.5, null),
	];
	const out = applyTemporalWindow(rows, WEEK);
	assert.equal(out.find((r) => r.id === 'undated').score, 0.5,
		'the window path must leave an undated item UNSCALED — changing this is a joint decision with decay');
	assert.ok(out.find((r) => r.id === 'dated-out').score < 0.8,
		'precondition: the window really was active, so the per-item map ran');
});

// ── D-b core mechanism ───────────────────────────────────────────────────────

test('in-window items keep their score; out-of-window items are demoted', () => {
	const rows = [item('in', 0.5, T(15)), item('out', 0.9, T(1))];
	const out = applyTemporalWindow(rows, WEEK);
	assert.equal(out.find((r) => r.id === 'in').score, 0.5, 'in-window score is untouched');
	assert.ok(out.find((r) => r.id === 'out').score < 0.9, 'out-of-window is demoted');
});

test('demotion uses distance to the NEAREST edge — symmetric before and after', () => {
	const before = item('before', 1, T(13) - 3 * DAY);
	const after = item('after', 1, T(19) + DAY - 1 + 3 * DAY);
	const out = applyTemporalWindow([before, after], WEEK);
	const a = out.find((r) => r.id === 'before').score;
	const b = out.find((r) => r.id === 'after').score;
	assert.ok(Math.abs(a - b) < 1e-9, `equal distances must decay equally (${a} vs ${b})`);
});

test('re-ranked scores never exceed the original (demote, never boost)', () => {
	const rows = [item('a', 0.8, T(15)), item('b', 0.8, T(1)), item('c', 0.8, null)];
	for (const r of applyTemporalWindow(rows, WEEK)) {
		assert.ok(r.score <= 0.8 + 1e-12, `${r.id} was boosted above its original score`);
	}
});

test('output is sorted descending and the input is never mutated', () => {
	const rows = [item('lo', 0.2, T(15)), item('hi', 0.9, T(15))];
	const snapshot = JSON.parse(JSON.stringify(rows));
	const out = applyTemporalWindow(rows, WEEK);
	assert.deepEqual(ids(out), ['hi', 'lo']);
	assert.deepEqual(rows, snapshot, 'input array and items must not be mutated');
	assert.notEqual(out, rows);
});

test('relevance still orders WITHIN the window (not a date sort)', () => {
	// The high-cosine item is deliberately the OLDER one — a pure date sort would
	// invert this. Same fixture constraint the E1(b) threshold pins.
	const older = item('high-cosine-older', 0.9, T(14));
	const newer = item('low-cosine-newer', 0.3, T(18));
	assert.deepEqual(ids(applyTemporalWindow([newer, older], WEEK)), ['high-cosine-older', 'low-cosine-newer']);
});

// ── D-b1 / D-b0: zero in-window ──────────────────────────────────────────────

test('D-b1: zero in-window candidates leaves ordering completely untouched', () => {
	// Distinct distances, and the item NEAREST the window carries the LOWEST
	// cosine — so a missing D-b1 provably inverts the visible order rather than
	// coincidentally preserving it.
	const rows = [
		item('far-strong', 0.9, T(1)),
		item('mid', 0.6, T(5)),
		item('near-weak', 0.2, T(12)),
	];
	const out = applyTemporalWindow(rows, WEEK);
	assert.deepEqual(ids(out), ['far-strong', 'mid', 'near-weak'], 'order must equal the input order');
	assert.deepEqual(out.map((r) => r.score), [0.9, 0.6, 0.2], 'scores must be untouched');
});

test('countInWindow drives the temporalActive decision (D-b0)', () => {
	assert.equal(countInWindow([item('a', 1, T(15))], WEEK), 1);
	assert.equal(countInWindow([item('a', 1, T(1))], WEEK), 0);
	assert.equal(countInWindow([item('a', 1, null)], WEEK), 0, 'undated never counts as in-window');
});

test('clock skew: an item marginally past the end edge is still in-window', () => {
	const now = T(19) + DAY - 1;
	const w = { start: T(13), end: now, kind: "this_week", nowAnchored: true };
	const justAfter = item('just-after', 1, now + CLOCK_SKEW_TOLERANCE_MS - 1000);
	const wellAfter = item('well-after', 1, now + CLOCK_SKEW_TOLERANCE_MS + 60 * 60 * 1000);
	assert.equal(countInWindow([justAfter], w), 1, 'within tolerance ⇒ in-window');
	assert.equal(countInWindow([wellAfter], w), 0, 'beyond tolerance ⇒ out');
});

// ── D-b2: span-scaled falloff + demotion floor ───────────────────────────────

test('D-b2: falloff scales to the window span and is clamped', () => {
	const day = { start: T(15), end: T(15) + DAY - 1 };
	const month = { start: Date.UTC(2026, 2, 1), end: Date.UTC(2026, 3, 1) - 1 };
	const year = { start: Date.UTC(2026, 0, 1), end: Date.UTC(2027, 0, 1) - 1 };
	assert.equal(windowFalloffDays(day), 1, 'clamped at the 1-day floor');
	assert.ok(windowFalloffDays(month) > windowFalloffDays(day), 'month scale exceeds day scale');
	assert.equal(windowFalloffDays(year), 30, 'clamped at the 30-day ceiling');
});

test('D-b2: "demoted, not annihilated" holds at BOTH ends of the scale', () => {
	// The whole point of the floor. Without it, a day-scale window annihilates a
	// week-old item (exp(-7) ≈ 9e-4) just as badly as a fixed 14-day falloff
	// annihilated a months-old one.
	const dayWindow = { start: T(15), end: T(15) + DAY - 1 };
	const monthWindow = { start: Date.UTC(2026, 2, 1), end: Date.UTC(2026, 3, 1) - 1 };

	for (const [label, w, farDate] of [
		['day scale', dayWindow, T(15) - 7 * DAY],
		['month scale', monthWindow, Date.UTC(2026, 6, 1)], // ~4 months out
	]) {
		const strongFar = item('strong-far', 1.0, farDate);
		const weakIn = item('weak-in', 0.02, w.start + 1000);
		const out = applyTemporalWindow([weakIn, strongFar], w);
		assert.equal(out[0].id, 'strong-far',
			`${label}: a sufficiently strong out-of-window item must still be able to outrank a weak in-window one`);
		assert.ok(out.find((r) => r.id === 'strong-far').score >= DEMOTION_FLOOR - 1e-12,
			`${label}: demotion must not fall below the floor`);
	}
});

// ── D-b3: exported-function input contract ───────────────────────────────────

test('D-b3: a non-finite window edge returns the input unchanged', () => {
	const rows = [item('a', 0.9, T(1)), item('b', 0.5, T(15))];
	for (const bad of [{ start: NaN, end: T(19) }, { start: T(13), end: NaN }, null, undefined]) {
		assert.deepEqual(ids(applyTemporalWindow(rows, bad)), ['a', 'b']);
	}
});

test('D-b3: a degenerate falloffDays override falls back to the derived default', () => {
	const rows = [item('in', 0.5, T(15)), item('out', 0.9, T(1))];
	const expected = applyTemporalWindow(rows, WEEK).map((r) => r.score);
	for (const bad of [0, -5, NaN, Infinity, 'x', null]) {
		const out = applyTemporalWindow(rows, WEEK, { falloffDays: bad });
		assert.deepEqual(out.map((r) => r.score), expected, `falloffDays=${String(bad)} must fall back`);
		for (const r of out) assert.ok(Number.isFinite(r.score), 'no NaN may reach the wire');
	}
});

test('an explicit valid falloffDays override IS honored', () => {
	// The in-window anchor is required: with zero in-window candidates D-b1
	// short-circuits and no falloff is applied at all, so a fixture of only
	// out-of-window items cannot observe this.
	const rows = [item('anchor', 0.1, T(15)), item('out', 1, T(1))];
	const score = (f) => applyTemporalWindow(rows, WEEK, { falloffDays: f }).find((r) => r.id === 'out').score;
	assert.ok(score(30) > score(1), 'a longer falloff must demote less');
});

test('items with no score are handled without producing NaN', () => {
	const rows = [
		item('anchor', 0.1, T(15)),
		{ id: 'scoreless', metadata: { valid_from: new Date(T(1)).toISOString() } },
	];
	const out = applyTemporalWindow(rows, WEEK);
	assert.ok(Number.isFinite(out.find((r) => r.id === 'scoreless').score));
});

// ── clock-skew tolerance is scoped to now-anchored windows ───────────────────

test('clock skew is NOT applied to fixed-calendar windows', () => {
	// `yesterday` ends on a calendar boundary. An item three minutes into today
	// is not clock drift — it is a different day — so widening the window would
	// be a silent semantic change, and it can flip temporalActive on its own.
	const yesterdayEnd = T(15) + DAY - 1;
	const fixed = { start: T(15), end: yesterdayEnd, kind: 'yesterday', nowAnchored: false };
	const justAfter = item('just-after', 1, yesterdayEnd + 3 * 60 * 1000);
	assert.equal(countInWindow([justAfter], fixed), 0, 'calendar boundary must be exact');

	// The same instant against a now-anchored window IS absorbed.
	const anchored = { start: T(15), end: yesterdayEnd, kind: 'this_week', nowAnchored: true };
	assert.equal(countInWindow([justAfter], anchored), 1, 'now-anchored ends absorb drift');
});

test('an unmarked window defaults to exact (no tolerance)', () => {
	// Fail-safe: a caller that omits nowAnchored gets the strict boundary rather
	// than a silently widened one.
	const w = { start: T(15), end: T(15) + DAY - 1 };
	const justAfter = item('x', 1, T(15) + DAY - 1 + 60 * 1000);
	assert.equal(countInWindow([justAfter], w), 0);
});
