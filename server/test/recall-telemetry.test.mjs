/**
 * recall-telemetry.test.mjs — Task 3 of the temporal query-resolution v1 arc.
 *
 * Covers noteTemporalQuery (spec D-f): the durable prevalence counter that makes
 * the eventual flag-flip decision evidence-based rather than an argument.
 *
 * Two gates, both load-bearing:
 *   • surface gate — mirrors noteRecallSearch (spec F9). doSearch has ~25
 *     test/eval callers that thread no surface; an eval sweep would otherwise
 *     dwarf real operator traffic in the prevalence figure.
 *   • kind-vocabulary gate — `outcome` is part of the counters PRIMARY KEY and,
 *     unlike `surface`, carries no length cap. An interpolated kind would mint
 *     one durable row per distinct query on a table with 400d retention, and the
 *     fire-and-forget writer would fail silently while doing it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { noteTemporalQuery, RECALL_EVENTS } from '../lib/recall-telemetry.mjs';

/** Capture what reaches the recordCaptureEvent seam without touching sqlite. */
function collector() {
	const rows = [];
	return { rows, record: (evt) => rows.push(evt) };
}

test('emits a recall.temporal_query row for a valid kind on a production surface', () => {
	const c = collector();
	noteTemporalQuery({ surface: 'claude-code', kind: 'last_week' }, { record: c.record });
	assert.equal(c.rows.length, 1);
	assert.deepEqual(c.rows[0], {
		surface: 'claude-code',
		project: '',
		event: RECALL_EVENTS.TEMPORAL_QUERY,
		outcome: 'last_week',
	});
});

test("pinned event name is 'recall.temporal_query' — outside the capture.% namespace", () => {
	// The signal.*/recall.* namespace rule: new counter events live outside
	// capture.% so an older server is downgrade-inert against them.
	assert.equal(RECALL_EVENTS.TEMPORAL_QUERY, 'recall.temporal_query');
	assert.ok(!RECALL_EVENTS.TEMPORAL_QUERY.startsWith('capture.'));
});

test("a null parse emits outcome 'none' so prevalence is self-contained", () => {
	// Prevalence = sum(kinds) / (sum(kinds) + none), computed entirely inside one
	// event family. Dividing by recall.search would be malformed: the compat
	// facade emits recall.search from handleList too, which serves query-less
	// reads that can never produce a temporal parse.
	const c = collector();
	noteTemporalQuery({ surface: 'discord', kind: null }, { record: c.record });
	assert.equal(c.rows.length, 1);
	assert.equal(c.rows[0].outcome, 'none');
});

test('surface gate: no surface ⇒ no emission (the ~25 eval/test callers)', () => {
	const c = collector();
	for (const surface of [undefined, null, '', 42, {}]) {
		noteTemporalQuery({ surface, kind: 'last_week' }, { record: c.record });
	}
	assert.equal(c.rows.length, 0, 'eval/test callers must not pollute prevalence');
});

test('vocabulary gate: an out-of-vocabulary kind emits nothing', () => {
	const c = collector();
	for (const kind of ['in_month:2026-03', 'made_up', 'LAST_WEEK', '../../etc', 'capture.turn']) {
		noteTemporalQuery({ surface: 'claude-code', kind }, { record: c.record });
	}
	assert.equal(c.rows.length, 0, 'only the frozen TEMPORAL_KINDS vocabulary may reach the PRIMARY KEY');
});

test('every declared kind is accepted by the vocabulary gate', async () => {
	const { TEMPORAL_KINDS } = await import('../lib/temporal-query.mjs');
	const c = collector();
	for (const kind of TEMPORAL_KINDS) {
		noteTemporalQuery({ surface: 'claude-code', kind }, { record: c.record });
	}
	assert.equal(c.rows.length, TEMPORAL_KINDS.length, 'the gate must not reject its own vocabulary');
});

test('fire-and-forget: never throws when the seam throws', () => {
	const throwing = () => { throw new Error('sqlite is unhappy'); };
	assert.doesNotThrow(() => {
		noteTemporalQuery({ surface: 'claude-code', kind: 'today' }, { record: throwing });
	});
});

test('never throws on a malformed argument object', () => {
	assert.doesNotThrow(() => noteTemporalQuery());
	assert.doesNotThrow(() => noteTemporalQuery(null));
	assert.doesNotThrow(() => noteTemporalQuery({}));
});
