/**
 * Tests for server/lib/ranking.mjs — applyTemporalDecay
 *
 * Run with: node --test server/test/ranking.test.mjs
 *
 * Date.now is pinned via try/finally in each test that needs deterministic
 * scores. This avoids the need for beforeEach/afterEach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTemporalDecay, resolveItemDate, isUsableDate } from '../lib/ranking.mjs';

// Fixed "now" for all date-dependent tests.
const FIXED_NOW = new Date('2026-04-17T00:00:00Z').getTime();

// ---------------------------------------------------------------------------
// 1. Basic decay ordering
// ---------------------------------------------------------------------------

test('applyTemporalDecay — recent ranks above old with half-life 30', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    // recent: 7 days old  — effective score ≈ exp(-7/30)  ≈ 0.7919
    // old:   106 days old — effective score ≈ exp(-106/30) ≈ 0.02908
    const recent = { id: 'r', metadata: { valid_from: '2026-04-10T00:00:00Z' }, score: 1.0 };
    const old    = { id: 'o', metadata: { valid_from: '2026-01-01T00:00:00Z' }, score: 1.0 };

    // Pass old first — function must re-sort
    const result = applyTemporalDecay([old, recent], 30);

    assert.equal(result[0].id, 'r', 'recent should rank first');
    assert.equal(result[1].id, 'o', 'old should rank second');
    assert.ok(Math.abs(result[0].score - Math.exp(-7  / 30)) < 1e-9, `recent score mismatch: ${result[0].score}`);
    assert.ok(Math.abs(result[1].score - Math.exp(-106 / 30)) < 1e-9, `old score mismatch: ${result[1].score}`);
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 2. Missing valid_from (and missing created_at) — returned unchanged
// ---------------------------------------------------------------------------

test('applyTemporalDecay — missing valid_from and created_at gets the imputed undated factor', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const item = { id: 'a', metadata: {}, score: 0.5 };
    const out = applyTemporalDecay([item], 30);
    // The LITERAL Math.exp(-1), never the imported UNDATED_FACTOR — see the note at the
    // top of ranking-undated-policy.test.mjs. Importing the constant would make this
    // assertion move with any retune and stop testing anything.
    assert.equal(out[0].score, 0.5 * Math.exp(-1));
    assert.equal(out[0].id, 'a');
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 3. createdAt / created_at are NOT ranking dates — deliberately (spec D-h)
// ---------------------------------------------------------------------------
// This assertion was INVERTED on 2026-08-01, on measurement, and the inversion
// changes no production behavior. The old test asserted a fall-back to
// snake_case `created_at` — a path production never reached, because mem0ai
// returns camelCase `createdAt` (so the fallback was dead: spec F13). It passed
// only against this hand-made fixture.
//
// Activating it "correctly" would have been worse than leaving it dead. A live
// cross-tab (spec F19) showed the 186 of 353 points lacking `valid_from` are
// bulk-arrival artifacts — 86.5% of them on just two days, a migration and a
// reindex — because `umAdd` stamps `createdAt` at write time and a reindex
// rebuilds through `umAdd`. Grading on it would rank half the corpus by which
// import a point arrived in — so an arrival stamp is NOT a ranking date.
//
// That conclusion still stands. What changed is the treatment of "no ranking date":
// such an item is now given a fixed imputed factor instead of being left at 1.0, because
// 1.0 became the top of the range once everything else decayed. The guard below is
// STRONGER for it: an item graded on createdAt would produce exp(-age/H), a different
// number, so this still fails the moment anything starts grading on an arrival stamp.

test('applyTemporalDecay — does NOT grade on created_at/createdAt; gets the flat undated factor', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    for (const key of ['created_at', 'createdAt']) {
      const item = { id: 'x', [key]: '2026-04-10T00:00:00Z', score: 1.0 };
      const out = applyTemporalDecay([item], 30);
      // LITERAL Math.exp(-1) on purpose: grading on the stamp would give exp(-age/30),
      // which for this date is nowhere near exp(-1). Writing UNDATED_FACTOR here would
      // make the test tautological under a retune and void the red control.
      assert.equal(out[0].score, 1.0 * Math.exp(-1), `${key} must not be treated as a ranking date`);
    }
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 4. valid_from takes precedence over created_at
// ---------------------------------------------------------------------------

test('applyTemporalDecay — valid_from takes precedence over created_at', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    // valid_from 7 days old, created_at 106 days old
    // If valid_from is used → score ≈ exp(-7/30)
    // If created_at is used → score ≈ exp(-106/30)  (very different)
    const item = {
      id: 'v',
      metadata: { valid_from: '2026-04-10T00:00:00Z' },
      created_at: '2026-01-01T00:00:00Z',
      score: 1.0,
    };
    const out = applyTemporalDecay([item], 30);
    assert.ok(
      Math.abs(out[0].score - Math.exp(-7 / 30)) < 1e-9,
      `expected valid_from-based score, got ${out[0].score}`
    );
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 5. Empty array returns empty array
// ---------------------------------------------------------------------------

test('applyTemporalDecay — empty array returns empty array', () => {
  const out = applyTemporalDecay([], 30);
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// 6. Does not mutate input array
// ---------------------------------------------------------------------------

test('applyTemporalDecay — does not mutate input results array', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const recent = { id: 'r', metadata: { valid_from: '2026-04-10T00:00:00Z' }, score: 1.0 };
    const old    = { id: 'o', metadata: { valid_from: '2026-01-01T00:00:00Z' }, score: 1.0 };
    const input  = [old, recent];

    applyTemporalDecay(input, 30);

    // Input order must be unchanged
    assert.equal(input[0].id, 'o', 'input[0] should still be old');
    assert.equal(input[1].id, 'r', 'input[1] should still be recent');
    // Original score objects must be unchanged
    assert.equal(input[0].score, 1.0);
    assert.equal(input[1].score, 1.0);
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 7. Missing metadata field (metadata is undefined)
// ---------------------------------------------------------------------------

test('applyTemporalDecay — item with no metadata and only createdAt gets the undated factor', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    // metadata is undefined (not present at all); only an arrival stamp exists.
    // Per spec D-h that is still "no resolvable date" — the arrival stamp is never graded
    // on. It is now imputed at a flat one e-folding rather than left at 1.0.
    const item = { id: 'y', createdAt: '2026-04-10T00:00:00Z', score: 1.0 };
    const out = applyTemporalDecay([item], 30);
    // LITERAL, not the imported constant — see the note in ranking-undated-policy.test.mjs.
    assert.equal(out[0].score, 1.0 * Math.exp(-1));
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 8. Missing score treated as 1 (multiplication base)
// ---------------------------------------------------------------------------

test('applyTemporalDecay — missing score defaults to 1 before multiplication', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const item = { id: 'z', metadata: { valid_from: '2026-04-10T00:00:00Z' } };
    // no score property
    const out = applyTemporalDecay([item], 30);
    // (score || 1) * factor = 1 * exp(-7/30)
    assert.ok(
      Math.abs(out[0].score - Math.exp(-7 / 30)) < 1e-9,
      `expected exp(-7/30), got ${out[0].score}`
    );
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 9. isUsableDate — the write-side guard (VF-SUB)
// ---------------------------------------------------------------------------

// VF-SUB — the subset invariant: everything isUsableDate ACCEPTS must be
// resolvable by resolveItemDate. Pins the direction RC6 cannot: a future
// TIGHTENING of the reader would otherwise silently preserve values the
// reader can no longer resolve, reopening the undated-points defect with no
// failing test.
test('VF-SUB: accept(isUsableDate) is a subset of resolvable(resolveItemDate)', () => {
  const fixtures = [
    '2026-08-02T04:00:00.000Z',
    '2026-08-02',
    'March 3, 2026',   // Date-parseable but NOT ISO — makes RC7 demonstrable
    '',
    'yesterday',
    [],
    {},
    true,
    1,
    1754107200000,
    null,
    undefined,
  ];
  for (const v of fixtures) {
    if (isUsableDate(v)) {
      const ms = resolveItemDate({ metadata: { valid_from: v } });
      assert.notEqual(ms, null, `isUsableDate accepted ${JSON.stringify(v)} but resolveItemDate could not resolve it`);
    }
  }
});

test('VF-SUB: isUsableDate rejects non-strings that resolveItemDate WOULD resolve', () => {
  // true and 1 resolve read-side to 1970-01-01T00:00:00.001Z. They must still
  // be rejected write-side so the payload honours openapi.mjs:174 (date-time).
  assert.equal(isUsableDate(true), false);
  assert.equal(isUsableDate(1), false);
  assert.notEqual(resolveItemDate({ metadata: { valid_from: true } }), null);
});

test('VF-SUB: isUsableDate accepts a real ISO string and a parseable non-ISO string', () => {
  assert.equal(isUsableDate('2026-08-02T04:00:00.000Z'), true);
  assert.equal(isUsableDate('March 3, 2026'), true);
});

test('VF-SUB: isUsableDate rejects empty, unparseable, and container values', () => {
  for (const v of ['', 'yesterday', [], {}, null, undefined]) {
    assert.equal(isUsableDate(v), false, `expected ${JSON.stringify(v)} to be rejected`);
  }
});
