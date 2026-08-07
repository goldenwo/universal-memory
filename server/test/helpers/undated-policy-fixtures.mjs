// server/test/helpers/undated-policy-fixtures.mjs — shared fixtures for the undated-decay
// policy tests and its red controls (RC1-RC6).
//
// Deliberately NOT a *.test.mjs file: importing fixtures from a test module would
// re-register that module's tests in every importing runner process.
//
// Every consumer must write the LITERAL Math.exp(-1) in its assertions rather than
// importing UNDATED_FACTOR — see the note at the top of ranking-undated-policy.test.mjs.

export const FIXED_NOW = Date.parse('2026-08-06T00:00:00.000Z');
export const DAY = 86400000;
export const H = 30;

/** Run `fn` with a pinned clock so ages — and therefore factors — are exact. */
export function withFixedNow(fn) {
  const original = Date.now;
  Date.now = () => FIXED_NOW;
  try { return fn(); } finally { Date.now = original; }
}

/** A dated item `age` days old carrying `score`. */
export const datedItem = (id, age, score) => ({
  id, score, metadata: { valid_from: new Date(FIXED_NOW - age * DAY).toISOString() },
});

/**
 * An undated item. `score` may be omitted entirely, which is a case the policy's score
 * guard must handle (the key must stay absent, not be minted).
 *
 * It always carries a `createdAt` whose implied factor differs from exp(-1): without that,
 * a mutant grading undated items on `createdAt` would be INERT on the fixture and its red
 * control could never go red.
 */
export const undatedItem = (id, score, createdAtAge = 120) => ({
  id,
  ...(score === undefined ? {} : { score }),
  createdAt: new Date(FIXED_NOW - createdAtAge * DAY).toISOString(),
});

/** The analytic oracle for the dated branch — never a vendored copy of the function. */
export const datedExpect = (age, score) => (score || 1) * Math.exp(-age / H);

/**
 * The two dated members of `mixedSet`, as (age, score) pairs. Exported so the inversion
 * guard can assert the property from the SAME source the fixture is built from, instead of
 * retyping the numbers as literals (which would let a fixture edit silently void it).
 */
export const DATED_PAIRS = Object.freeze([
  Object.freeze({ id: 'd-old-high', age: 120, score: 0.9 }),
  Object.freeze({ id: 'd-new-low', age: 1, score: 0.3 }),
]);

export const UNDATED_PAIRS = Object.freeze([
  Object.freeze({ id: 'u-high', score: 0.8 }),
  Object.freeze({ id: 'u-low', score: 0.2 }),
]);

/**
 * A mixed set whose DATED members have their cosine order INVERTED by decay: 0.9 aged 120d
 * lands below 0.3 aged 1d. Any order-only assertion over this set is therefore genuinely
 * sensitive — without the inversion, a mutant replacing the dated factor entirely could
 * preserve order and the invariant test would pass anyway.
 */
export const mixedSet = () => [
  ...DATED_PAIRS.map((p) => datedItem(p.id, p.age, p.score)),
  ...UNDATED_PAIRS.map((p) => undatedItem(p.id, p.score)),
];
