/**
 * query-shape.test.mjs — #203 PR 1 (spec D9, §4.2.1; plan T1): the query-shape
 * classifier and the frozen IDENTIFIER_RX it now owns.
 *
 * Registered cases Q1–Q9 (the spec lists nine without per-case numbers; Q6 and Q9
 * follow the plan's assignment, the rest follow the spec's order):
 *   Q1–Q3 one case per shape (dominant, embedded, none)
 *   Q4    stopword-only text → none
 *   Q5    an identifier with ≥ 4 other content words → embedded
 *   Q6    IDENTIFIER_RX.source byte-equal to the July (2026-07-28) literal
 *   Q7    an identifier-heavy text over 8 content tokens → not dominant
 *   Q8    the same input classified twice in a row gives the same answer
 *   Q9    a 2 MB single-token input: same class as its first 5000 chars, the
 *         matcher never receives more than 5000 chars, loose 1 s bound
 *         (structural — not a second timing test next to C.10)
 *
 * Plus the plan T1.3 substitute: buildPopulation on a synthetic fixture returns
 * exactly what the pre-move eval returned (the July regex moved, nothing else).
 *
 * Every query below is SYNTHETIC (plan P9): no transcript or corpus text is read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  classifyQueryShape,
  IDENTIFIER_RX,
  EXT,
  MIN_IDENT_LEN,
  QUERY_SHAPES,
  QUERY_SHAPE_MAX_CHARS,
  STOPWORDS,
} from '../lib/query-shape.mjs';
import { buildPopulation } from '../eval/exact-token-eval.mjs';
import { POPULATION_FIXTURE_POINTS } from './fixtures/exact-token-population.fixture.mjs';

// ── Q1–Q3: one case per shape ────────────────────────────────────────────────

test('Q1 dominant: a short, identifier-led query', () => {
	for (const q of [
		'UM_TEMPORAL_DECAY',
		'what is v1.26.1',              // stopwords drop out; one identifier, one content token
		'#351',
		'server/lib/stats.mjs freshness', // 1 identifier of 2 content tokens: exactly half
		'how does --dry-run work?',     // "work?" strips to "work": 1 of 2
		'UM_A_FLAG and UM_B_FLAG',
	]) {
		assert.equal(classifyQueryShape(q), 'dominant', q);
	}
});

test('Q2 embedded: an identifier inside a longer natural-language query', () => {
	for (const q of [
		'why does the reindex fail after UM_TEMPORAL_DECAY flips on in production',
		'fix the --dry-run flag parsing bug',     // 1 identifier of 5 content tokens
	]) {
		assert.equal(classifyQueryShape(q), 'embedded', q);
	}
});

test('Q3 none: no identifier of 4+ chars anywhere', () => {
	for (const q of [
		'how did we fix the reindex warnings',
		'what is #12',                  // a 3-char match is below MIN_IDENT_LEN
		'temporal decay feature flag',
	]) {
		assert.equal(classifyQueryShape(q), 'none', q);
	}
});

// ── Q4: stopword-only ────────────────────────────────────────────────────────

test('Q4 stopword-only text → none (and empty / punctuation-only text too)', () => {
	for (const q of ['what is the', 'What IS the?', 'how, why, when?', '', '   ', '?? -- !!', '\n\t']) {
		assert.equal(classifyQueryShape(q), 'none', JSON.stringify(q));
	}
});

// ── Q4 (continued): the tokenizer and stopword rules, each pinned ────────────
// Q4's inputs carry no identifier, so they classify `none` whatever the
// stopword handling does. These cases put one identifier beside one content
// word, so a single extra content token flips `dominant` (1 of 2) to
// `embedded` (1 of 3): every rule below changes an answer if it regresses.

// Spec D9's list, written out here in the spec's order.
const SPEC_D9_STOPWORDS = [
	'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about', 'into',
	'over', 'under', 'between', 'through', 'during', 'after', 'before', 'via', 'and', 'or', 'what',
	'how', 'why', 'where', 'when', 'which', 'who', 'is', 'are', 'was', 'were', 'does', 'do', 'did',
	'can', 'should',
];

test('Q4 stopwords: the exported list is spec D9\'s, in order, and frozen', () => {
	assert.deepEqual([...STOPWORDS], SPEC_D9_STOPWORDS);
	assert.ok(Object.isFrozen(STOPWORDS));
});

test('Q4 stopwords: every stopword, in any case and with edge punctuation, is not a content token', () => {
	// Iterates the spec's list, not the export, so a word dropped from the
	// module fails here on behaviour as well as in the list pin above.
	for (const w of SPEC_D9_STOPWORDS) {
		for (const form of [w, w.toUpperCase(), `${w}?`, `(${w},`]) {
			assert.equal(classifyQueryShape(`alpha UM_FLAG_X ${form}`), 'dominant', `"${form}" must not count as content`);
		}
	}
	// Control: a non-stopword in the same slot is content, so the frame discriminates.
	assert.equal(classifyQueryShape('alpha UM_FLAG_X it'), 'embedded');
});

test('Q4 tokenizer: punctuation-only tokens are dropped; any whitespace separates tokens', () => {
	assert.equal(classifyQueryShape('alpha UM_FLAG_X -- ->'), 'dominant', 'tokens that strip to empty are not content');
	assert.equal(classifyQueryShape('UM_FLAG_X\nalpha'), 'dominant');
	// A newline or tab between two words makes two content tokens (1 of 3).
	assert.equal(classifyQueryShape('UM_FLAG_X alpha\nbeta'), 'embedded');
	assert.equal(classifyQueryShape('UM_FLAG_X\talpha\tbeta'), 'embedded');
});

test('short matches consume the text they cover, exactly as the July eval\'s .match did (kept on purpose)', () => {
	assert.equal(classifyQueryShape('#12.3.4'), 'none', '`#12` (3 chars) is taken first, so no version is left');
	assert.equal(classifyQueryShape('12.3.4'), 'dominant');
});

// ── Q5: identifier + ≥ 4 other content words ─────────────────────────────────

test('Q5 an identifier with ≥ 4 other content words → embedded (and the half boundary both ways)', () => {
	assert.equal(classifyQueryShape('UM_TEMPORAL_DECAY ranking recall regression analysis'), 'embedded');
	assert.equal(classifyQueryShape('what is the UM_FLAG_X for'), 'dominant',
		'stopwords do not count toward the content tokens (counted, this would be 1 of 5)');
	// identifier tokens ≥ half the content tokens:
	assert.equal(classifyQueryShape('UM_FLAG_X ranking'), 'dominant', '1 of 2 is half');
	assert.equal(classifyQueryShape('UM_FLAG_X ranking recall'), 'embedded', '1 of 3 is under half');
	assert.equal(classifyQueryShape('UM_FLAG_X UM_FLAG_Y ranking recall'), 'dominant', '2 of 4 is half');
});

// ── Q6: the frozen July regex ────────────────────────────────────────────────

// The `.source` of the regex exactly as server/eval/exact-token-eval.mjs built it
// on 2026-07-28 (main @ f951828). A one-character edit to any alternative, to EXT,
// or to the join breaks comparability with #188's July numbers and with the #203
// census, so it must fail here first.
const JULY_SOURCE = String.raw`[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}|v?\d+\.\d+\.\d+|#\d{1,4}|[\w-]+(?:[./][\w-]+)*\.(?:mjs|js|json|sh|ya?ml|md|ts|py|db|sql|toml|ini|env|lock)\b|--[a-z][a-z0-9-]{2,}|[a-z_][a-z0-9_]*\(\)|(?<![\w-])~?\/[\w.-]+(?:\/[\w.-]+)+|[a-z][\w-]*:\d{2,5}`;

test('Q6 IDENTIFIER_RX.source is byte-equal to the July literal; flags, EXT and MIN_IDENT_LEN unchanged', () => {
	assert.equal(IDENTIFIER_RX.source, JULY_SOURCE);
	assert.equal(Buffer.compare(Buffer.from(IDENTIFIER_RX.source, 'utf8'), Buffer.from(JULY_SOURCE, 'utf8')), 0);
	assert.equal(IDENTIFIER_RX.flags, 'g');
	assert.equal(EXT, 'mjs|js|json|sh|ya?ml|md|ts|py|db|sql|toml|ini|env|lock');
	assert.equal(MIN_IDENT_LEN, 4);
});

// ── Q7: identifier-heavy, over 8 content tokens ──────────────────────────────

test('Q7 an identifier-heavy text over 8 content tokens is not dominant', () => {
	const nine = '#101 #102 #103 #104 #105 #106 #107 #108 #109';
	assert.notEqual(classifyQueryShape(nine), 'dominant');
	assert.equal(classifyQueryShape(nine), 'embedded');
	assert.equal(classifyQueryShape('#101 #102 #103 #104 #105 #106 #107 #108'), 'dominant', '8 content tokens is still within the bound');
	assert.equal(classifyQueryShape('UM_A_ONE UM_B_TWO UM_C_THREE UM_D_FOUR UM_E_FIVE alpha beta gamma delta'), 'embedded',
		'5 of 9 is over half, but 9 content tokens is over the bound');
});

// ── Q8: no state shared across calls ─────────────────────────────────────────

test('Q8 the same input classified twice in a row gives the same answer (no shared lastIndex)', () => {
	const inputs = [
		'UM_TEMPORAL_DECAY',
		'why does the reindex fail after UM_TEMPORAL_DECAY flips on in production',
		'how did we fix the reindex warnings',
		'see v1.26.1 and v1.26.2',
	];
	for (const q of inputs) {
		const first = classifyQueryShape(q);
		assert.equal(classifyQueryShape(q), first, q);
	}
	// Another consumer of the shared, `g`-flagged IDENTIFIER_RX (the eval, the
	// census) may leave its lastIndex mid-string. String.prototype.matchAll copies
	// lastIndex into its clone, so a classifier that matched on the shared object
	// would start past the identifier (index 10 is past `UM_FLAG_X`) and miss it.
	const prev = IDENTIFIER_RX.lastIndex;
	try {
		IDENTIFIER_RX.lastIndex = 10;
		assert.equal(classifyQueryShape('UM_FLAG_X ranking'), 'dominant');
		assert.equal(classifyQueryShape('UM_FLAG_X ranking'), 'dominant');
	} finally {
		IDENTIFIER_RX.lastIndex = prev;
	}
});

// ── Q9: the 5000-char cap (structural) ───────────────────────────────────────

test('Q9 a 2 MB single-token input: same class as its first 5000 chars, matcher capped, under 1 s', () => {
	assert.equal(QUERY_SHAPE_MAX_CHARS, 5000);
	// An unbroken lowercase run is the regex's quadratic worst case (spec D9:
	// 41 ms at 5000 chars, 67 s at 200 000) — uncapped, this input would not return.
	const huge = 'a'.repeat(2 * 1024 * 1024);
	const prefix = huge.slice(0, QUERY_SHAPE_MAX_CHARS);
	const seen = [];
	const original = RegExp.prototype[Symbol.matchAll];
	// Spy on the real matcher (no production seam): String.prototype.matchAll
	// dispatches through RegExp.prototype[Symbol.matchAll]. Refuse oversize input
	// BEFORE matching, so a regressed cap fails fast instead of hanging the suite.
	RegExp.prototype[Symbol.matchAll] = function spy(str) {
		if (this.source === IDENTIFIER_RX.source) {
			const len = String(str).length;
			seen.push(len);
			if (len > QUERY_SHAPE_MAX_CHARS) throw new Error(`matcher received ${len} chars`);
		}
		return original.call(this, str);
	};
	let shapeHuge;
	let elapsed;
	try {
		const t0 = performance.now();
		shapeHuge = classifyQueryShape(huge);
		elapsed = performance.now() - t0;
		assert.equal(classifyQueryShape(prefix), shapeHuge);
		// A shape that depends on the token: an identifier-led 2 MB token.
		const flagged = `UM_TEMPORAL_DECAY ${'b'.repeat(2 * 1024 * 1024)}`;
		assert.equal(classifyQueryShape(flagged), classifyQueryShape(flagged.slice(0, QUERY_SHAPE_MAX_CHARS)));
	} finally {
		RegExp.prototype[Symbol.matchAll] = original;
	}
	assert.equal(shapeHuge, 'none');
	assert.ok(seen.length > 0, 'the spy must have seen the identifier matcher (else the cap check is vacuous)');
	assert.ok(Math.max(...seen) <= QUERY_SHAPE_MAX_CHARS, `matcher received ${Math.max(...seen)} chars`);
	assert.ok(elapsed < 1000, `classification took ${elapsed.toFixed(0)} ms`);
});

// ── vocabulary + totality (supporting, unnumbered) ───────────────────────────

test('the classifier only ever returns a QUERY_SHAPES member; a non-string is none', () => {
	assert.deepEqual([...QUERY_SHAPES], ['none', 'embedded', 'dominant']);
	assert.ok(Object.isFrozen(QUERY_SHAPES));
	for (const q of ['UM_X_FLAG', 'a b c UM_X_FLAG d e f', 'plain words', '', undefined, null, 42, {}]) {
		assert.ok(QUERY_SHAPES.includes(classifyQueryShape(q)), String(q));
	}
	assert.equal(classifyQueryShape(undefined), 'none');
	assert.equal(classifyQueryShape(null), 'none');
});

// ── plan T1.3 substitute: the move changed nothing in the eval ───────────────

// Computed from the PRE-MOVE server/eval/exact-token-eval.mjs (main @ f951828) on
// the synthetic fixture: sha256 of JSON.stringify(buildPopulation(points)), plus
// the readable shape of the same output.
const PRE_MOVE_POPULATION_SHA256 = 'f7c4695436553d14013d72b99f7440c7ff60c8bccd40e8cfad32a51d79589340';
const PRE_MOVE_POPULATION = [
	{ identifier: '#4321', relevant: ['doc-alpha', 'doc-gamma'], df: 2, stratum: 'doc', seedLen: 110 },
	{ identifier: '#7001', relevant: ['doc-zeta'], df: 1, stratum: 'fact', seedLen: 33 },
	{ identifier: '9.8.7', relevant: ['doc-alpha', 'doc-delta', 'p-3'], df: 3, stratum: 'fact', seedLen: 110 },
	{ identifier: 'FAKE_FLAG_ONE', relevant: ['doc-alpha', 'doc-beta'], df: 2, stratum: 'fact', seedLen: 110 },
	{ identifier: 'do_thing()', relevant: ['p-3'], df: 1, stratum: 'fact', seedLen: 65 },
	{ identifier: 'host-a:8080', relevant: ['doc-beta'], df: 1, stratum: 'fact', seedLen: 90 },
	{ identifier: 'lib/widget.mjs', relevant: ['doc-alpha'], df: 1, stratum: 'fact', seedLen: 110 },
	{ identifier: 'v1.2.3', relevant: ['doc-delta'], df: 1, stratum: 'doc', seedLen: 82 },
	{ identifier: 'v9.8.7', relevant: ['doc-alpha', 'doc-delta'], df: 2, stratum: 'doc', seedLen: 110 },
	{ identifier: '~/demo/path/file', relevant: ['doc-gamma'], df: 1, stratum: 'doc', seedLen: 1200 },
];

test('T1.3 substitute: buildPopulation on a synthetic fixture returns exactly the pre-move output', () => {
	const out = buildPopulation(POPULATION_FIXTURE_POINTS.map((p) => structuredClone(p)));
	assert.deepEqual(out.map(({ seedText, ...r }) => ({ ...r, seedLen: seedText.length })), PRE_MOVE_POPULATION);
	assert.equal(createHash('sha256').update(JSON.stringify(out)).digest('hex'), PRE_MOVE_POPULATION_SHA256);
	// Twice in a row: the eval's own `match` on the shared regex leaves no state behind.
	const again = buildPopulation(POPULATION_FIXTURE_POINTS.map((p) => structuredClone(p)));
	assert.equal(createHash('sha256').update(JSON.stringify(again)).digest('hex'), PRE_MOVE_POPULATION_SHA256);
});
