// reaction-signal.test.mjs — #187: constants + normalizer contract + the namespace
// boundary pin (spec §7 R3: signal.reaction must never match the capture.% filter).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNAL_EVENTS,
  REACTION_OUTCOME_KEYS,
  REACTION_COUNT_MAX,
  normalizeReactionMetadata,
  _resetReactionSignalForTest,
} from '../lib/reaction-signal.mjs';

test('SIGNAL_EVENTS is frozen and REACTION lives OUTSIDE the capture.* namespace (load-bearing filter boundary)', () => {
  assert.ok(Object.isFrozen(SIGNAL_EVENTS));
  assert.equal(SIGNAL_EVENTS.REACTION, 'signal.reaction');
  // The stats queries filter `event LIKE 'capture.%'` — a reaction row matching it
  // would double-count events_today and advance freshness (and corrupt stats on
  // DOWNGRADE, where the exclusion logic doesn't exist). SQL LIKE 'capture.%' ⇔
  // startsWith('capture.') for this literal.
  assert.ok(!SIGNAL_EVENTS.REACTION.startsWith('capture.'));
});

test('REACTION_OUTCOME_KEYS is the frozen admission-verdict vocabulary', () => {
  assert.ok(Object.isFrozen(REACTION_OUTCOME_KEYS));
  assert.deepEqual([...REACTION_OUTCOME_KEYS], ['stored', 'abstained']);
});

test('normalizeReactionMetadata: no reaction fields → metadata unchanged (new object, not mutated)', () => {
  const input = { project: 'x', other: 1 };
  const out = normalizeReactionMetadata(input);
  assert.deepEqual(out, input);
  assert.notEqual(out, input);
});

test('normalizeReactionMetadata: invalid count drops BOTH fields (count is the load-bearing signal)', () => {
  _resetReactionSignalForTest();
  for (const bad of [0, -1, 1.5, '3', null, undefined, NaN]) {
    const out = normalizeReactionMetadata({ reaction_count: bad, reaction_types: ['👍'], keep: true });
    assert.ok(!('reaction_count' in out), `count ${String(bad)} should be dropped`);
    assert.ok(!('reaction_types' in out), `types should be dropped with invalid count ${String(bad)}`);
    assert.equal(out.keep, true);
  }
});

test('normalizeReactionMetadata: valid count kept; clamped at REACTION_COUNT_MAX', () => {
  assert.equal(normalizeReactionMetadata({ reaction_count: 3 }).reaction_count, 3);
  assert.equal(normalizeReactionMetadata({ reaction_count: 999999 }).reaction_count, REACTION_COUNT_MAX);
});

test('normalizeReactionMetadata: count valid + types malformed → keep count, drop types (per-field independence)', () => {
  const out = normalizeReactionMetadata({ reaction_count: 2, reaction_types: 'not-an-array' });
  assert.equal(out.reaction_count, 2);
  assert.ok(!('reaction_types' in out));
});

test('normalizeReactionMetadata: valid array cleaned — non-strings dropped, entries truncated to 64, capped at 16', () => {
  const long = 'x'.repeat(100);
  const many = Array.from({ length: 20 }, (_, i) => `e${i}`);
  const out = normalizeReactionMetadata({ reaction_count: 1, reaction_types: ['👍', 42, long, ...many] });
  assert.ok(out.reaction_types.every((t) => typeof t === 'string' && t.length <= 64));
  assert.ok(out.reaction_types.length <= 16);
  assert.equal(out.reaction_types[0], '👍');
  assert.ok(!out.reaction_types.includes(42));
});

test('normalizeReactionMetadata: never throws on hostile shapes', () => {
  for (const hostile of [null, undefined, {}, { reaction_count: {} }, { reaction_types: { a: 1 } }, { reaction_count: Infinity, reaction_types: [Symbol.iterator] }]) {
    assert.doesNotThrow(() => normalizeReactionMetadata(hostile));
  }
});
