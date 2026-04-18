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

import { applyTemporalDecay } from '../lib/ranking.mjs';

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

test('applyTemporalDecay — missing valid_from and created_at returns item unchanged', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const item = { id: 'a', metadata: {}, score: 0.5 };
    const out = applyTemporalDecay([item], 30);
    // Score must not have changed
    assert.equal(out[0].score, 0.5);
    assert.equal(out[0].id, 'a');
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// 3. Falls back to created_at when valid_from is absent
// ---------------------------------------------------------------------------

test('applyTemporalDecay — falls back to created_at when valid_from absent', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    // created_at 7 days before FIXED_NOW
    const item = { id: 'x', created_at: '2026-04-10T00:00:00Z', score: 1.0 };
    const out = applyTemporalDecay([item], 30);
    assert.ok(
      Math.abs(out[0].score - Math.exp(-7 / 30)) < 1e-9,
      `expected exp(-7/30), got ${out[0].score}`
    );
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

test('applyTemporalDecay — missing metadata property falls back to created_at', () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const item = { id: 'y', created_at: '2026-04-10T00:00:00Z', score: 1.0 };
    // metadata is undefined (not present at all)
    const out = applyTemporalDecay([item], 30);
    assert.ok(
      Math.abs(out[0].score - Math.exp(-7 / 30)) < 1e-9,
      `expected exp(-7/30), got ${out[0].score}`
    );
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
