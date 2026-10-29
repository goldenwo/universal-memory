// server/test/summary-eval.test.mjs — the S-sum keyed eval's pure parts (model migration Phase B,
// prereg S-sum): normaliser, matcher, the four invented-identifier classes and their boundary
// rule, the format rule (headings and the trivial-session form), the five controls (pass and
// fail each), the per-summary score and the aggregate. Offline: no provider is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalise, occursBounded, findKeys, identifierTokens, inventedIdentifiers,
  formatOk, sentenceCount, controls, scoreSummary, aggregate, FABRICATED,
} from '../eval/summary-eval.mjs';

// --- normaliser ------------------------------------------------------------

test('normalise: state-cap-eval deletions, whitespace, case-fold, plus \\ → / and a leading v on a version', () => {
  assert.equal(normalise('**`Fix_Bar`** (see [x])'), 'fixbar see x');
  assert.equal(normalise('server\\lib\\X.mjs'), 'server/lib/x.mjs');
  assert.equal(normalise('shipped v1.29.0 and V2.0'), 'shipped 1.29.0 and 2.0');
  assert.equal(normalise('dev1.2.3 envy1.2.3'), 'dev1.2.3 envy1.2.3', 'a v inside a word is not a version prefix');
  assert.equal(normalise('a \n\t b'), 'a b');
});

test('the normaliser applies to both sides: a key written with backticks matches plain summary text', () => {
  assert.deepEqual(findKeys(['`runGate`'], 'calls rungate twice').found, ['`runGate`']);
  assert.deepEqual(findKeys(['runGate'], 'calls `runGate()` twice').found, ['runGate']);
  assert.deepEqual(findKeys(['v1.29.0'], 'released 1.29.0').found, ['v1.29.0']);
  assert.deepEqual(findKeys(['server/lib/a.mjs'], 'edited server\\lib\\a.mjs').found, ['server/lib/a.mjs']);
});

// --- matcher boundary rule ---------------------------------------------------

test('matcher: no letter or digit immediately before or after — #39 is not credited by #394', () => {
  assert.equal(occursBounded('#39', 'fixed #394 today'), false);
  assert.equal(occursBounded('#39', 'fixed #39, today'), true);
  assert.equal(occursBounded('#39', 'see #394 and #39'), true, 'a later bounded occurrence counts');
  assert.equal(occursBounded('plan.md', 'docs/plan.md'), true, '/ is not a letter or digit');
  assert.equal(occursBounded('abc1234', 'xabc1234'), false);
  assert.equal(occursBounded('', 'anything'), false);
});

// --- invented identifiers, one class at a time --------------------------------

test('issue class: #\\d+ with no digit after; not inside a word or a path', () => {
  assert.deepEqual(identifierTokens('see #203, #394 and c#1 and a/#7').issue, ['#203', '#394']);
});

test('path class: contains / and a file extension starting with a letter; trailing sentence dot excluded', () => {
  const t = identifierTokens('edit server/lib/x.mjs. Then ./docs/a.md, rate 1/2.5, and https://h.com/p.html');
  assert.deepEqual(t.path, ['server/lib/x.mjs', './docs/a.md']);
});

test('hex class: 7–40 hex chars with at least one a–f letter; all-digit runs and short runs excluded', () => {
  const t = identifierTokens('commit eaf8f7b, number 1234567, short abc12, long ' + 'a'.repeat(41) + ' and 0123456789abcdef0123456789abcdef01234567');
  assert.deepEqual(t.hex, ['eaf8f7b', '0123456789abcdef0123456789abcdef01234567']);
});

test('version class: \\d+.\\d+.\\d+ not followed by a digit or dot (so an IP is not a version)', () => {
  const t = identifierTokens('v1.29.0 and 1.30.0-rc but not 10.0.0.1 or 1.2');
  assert.deepEqual(t.version, ['1.29.0', '1.30.0']);
});

test('inventedIdentifiers: a token is invented when the normalised transcript lacks it under the boundary rule', () => {
  const transcript = 'We fixed #394 in server/lib/add.mjs at commit eaf8f7b and shipped v1.29.0';
  assert.deepEqual(inventedIdentifiers('fixed #394 (server/lib/add.mjs, eaf8f7b) in 1.29.0', transcript), []);
  assert.deepEqual(inventedIdentifiers('fixed #39', transcript), [{ cls: 'issue', token: '#39' }], '#39 is not credited by #394');
  assert.deepEqual(inventedIdentifiers('see lib/nope.mjs', transcript), [{ cls: 'path', token: 'lib/nope.mjs' }]);
  assert.equal(inventedIdentifiers('#7 #7 #7', transcript).length, 1, 'counted once per distinct token');
});

// --- format ----------------------------------------------------------------

test('format: any of the four headings passes; a code fence or a preamble line fails', () => {
  assert.equal(formatOk('## What happened\nDid x.\n\n## Next steps\n- y').ok, true);
  assert.equal(formatOk('## In flight\n- a').ok, true);
  assert.equal(formatOk('Here is the summary:\n## What happened\nx').ok, false, 'preamble before the first heading');
  assert.equal(formatOk('## What happened\n```js\nx\n```').ok, false, 'code fence');
  assert.equal(formatOk('## Summary\nOne. Two. Three. Four.').ok, false, 'an unlisted heading is not one of the four; four sentences fail the trivial form');
});

test('format: the trivial-session form is 1–3 sentences with no lead-in line', () => {
  assert.equal(sentenceCount('Fixed x.mjs. Shipped v1.2.3! Done?'), 3);
  assert.equal(formatOk('Small session. Fixed a typo in README.md.').ok, true);
  assert.equal(formatOk('One. Two. Three. Four.').ok, false);
  assert.equal(formatOk('Summary:\nFixed a typo.').ok, false, 'a lead-in line ending in a colon');
  assert.equal(formatOk('').ok, false, 'an empty summary has no sentence');
  assert.equal(formatOk('[MOCK] openai summary').ok, true, 'the mock reply is one unterminated sentence');
});

// --- controls ---------------------------------------------------------------

const SESSIONS = {
  a: 'We worked on #203 in server/lib/add.mjs, ran runGate, and merged commit eaf8f7b.',
  b: 'Release v1.29.0 shipped with gpt-6-luna; the pi-swap-1.29.0.sh script ran.',
};
const LABELS = {
  a: { keys: ['#203', 'server/lib/add.mjs', 'runGate', 'eaf8f7b'] },
  b: { keys: ['v1.29.0', 'gpt-6-luna', 'pi-swap-1.29.0.sh', 'Release'] },
};

test('controls: all five pass on well-formed labels', () => {
  const c = controls(SESSIONS, LABELS);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(c.keys, { sessions: 2, total: 8, min: 4, max: 4 });
});

test('control 1 (top) fails when a key is absent from its own transcript', () => {
  const c = controls(SESSIONS, { ...LABELS, a: { keys: [...LABELS.a.keys, '#999'] } });
  assert.equal(c.top.ok, false);
  assert.deepEqual(c.top.missing, [{ id: 'a', key: '#999' }]);
  assert.equal(c.ok, false);
});

test('control 2 (cross-session) fails when a key is found in another session\'s transcript', () => {
  const c = controls({ ...SESSIONS, b: SESSIONS.b + ' Also runGate.' }, LABELS);
  assert.equal(c.cross.ok, false);
  assert.deepEqual(c.cross.hits, [{ id: 'a', key: 'runGate', foundIn: 'b' }]);
});

test('control 3 (middle) fails when a later key is found inside the first half\'s text', () => {
  const sessions = { a: 'docs/plan.md and plan.md and x.mjs and y.mjs' };
  const c = controls(sessions, { a: { keys: ['docs/plan.md', 'x.mjs', 'plan.md', 'y.mjs'] } });
  assert.equal(c.middle.ok, false, 'plan.md is credited by docs/plan.md, so half = 2 scores 3');
  assert.deepEqual(c.middle.failures, [{ id: 'a', expected: 2, found: 3, of: 4 }]);
});

test('control 4 (invented detection) fails when a fabricated token is already in the transcript', () => {
  const c = controls({ ...SESSIONS, a: `${SESSIONS.a} ${FABRICATED.issue}` }, LABELS);
  assert.equal(c.invented.ok, false);
  assert.equal(c.invented.failures[0].count, 3);
});

test('control 5 (harmless rewrites) fails when the normaliser does not fold the rewrite', () => {
  // A transcript cannot make this control fail with the shipped normaliser; check the property it
  // pins directly instead: without the \\ fold, server\\lib\\x.mjs would not credit server/lib/x.mjs.
  assert.equal(occursBounded('server/lib/x.mjs', 'server\\lib\\x.mjs'.toLowerCase()), false);
  assert.equal(controls(SESSIONS, LABELS).harmless.ok, true);
});

test('controls: a session with no labels, or labels naming no transcript, fail control 1', () => {
  assert.equal(controls({ ...SESSIONS, c: 'extra' }, LABELS).top.ok, false);
  assert.equal(controls({ a: SESSIONS.a }, LABELS).top.ok, false);
});

// --- score and aggregate ----------------------------------------------------

test('scoreSummary: keys found and missed, invented count, format and the whole output\'s length', () => {
  const s = scoreSummary({ summary: '## What happened\nFixed #203 in server/lib/add.mjs (#77).', transcript: SESSIONS.a, keys: LABELS.a.keys });
  assert.equal(s.keysFound, 2);
  assert.deepEqual(s.missed, ['runGate', 'eaf8f7b']);
  assert.equal(s.inventedCount, 1);
  assert.equal(s.format.ok, true);
  assert.equal(s.length, '## What happened\nFixed #203 in server/lib/add.mjs (#77).'.length);
});

test('aggregate: pooled recall, invented per summary, format per run, mean length; invoke-errors excluded and counted', () => {
  const call = (found, total, inv, fmt, len) => ({ ok: true, score: { keysFound: found, keysTotal: total, inventedCount: inv, format: { ok: fmt }, length: len } });
  const runs = [
    { calls: [call(3, 4, 0, true, 100), call(2, 4, 1, false, 300)] },
    { calls: [call(4, 4, 0, true, 200), { ok: false, failCause: 'invoke-error' }] },
  ];
  const a = aggregate(runs);
  assert.equal(a.recall, 9 / 12);
  assert.equal(a.inventedPerSummary, 1 / 3);
  assert.equal(a.formatPerRun, 1);
  assert.equal(a.meanLength, 200);
  assert.deepEqual(a.perRun.map((r) => [r.errors, r.errorRate]), [[0, 0], [1, 0.5]]);
});
