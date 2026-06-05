// server/test/fbeta.test.mjs — shared precision-weighted F-score helpers (Gap-5 P2
// rule-of-three extraction). Pins the canonical contract the three eval harnesses share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F_BETA, fHalfFrom, f1From } from '../eval/fbeta.mjs';

function approx(a, b, eps = 1e-12) { assert.ok(Math.abs(a - b) <= eps, `expected ≈${b}, got ${a}`); }

test('F_BETA is 0.5 (precision-weighted)', () => {
  assert.equal(F_BETA, 0.5);
});

test('fHalfFrom: precision-weighted (β=0.5) — favors precision over recall', () => {
  approx(fHalfFrom(0.5, 0.5), 0.5); // P==R → equals P
  assert.ok(fHalfFrom(0.9, 0.5) > fHalfFrom(0.5, 0.9), 'F0.5 scores higher when precision leads');
});

test('f1From: balanced harmonic mean (symmetric in P, R)', () => {
  approx(f1From(0.5, 0.5), 0.5);
  approx(f1From(0.9, 0.5), f1From(0.5, 0.9)); // F1 symmetric
});

test('fHalfFrom / f1From: null P or R → 0 (no NaN)', () => {
  assert.equal(fHalfFrom(null, 0.5), 0);
  assert.equal(fHalfFrom(0.5, null), 0);
  assert.equal(f1From(null, null), 0);
});

test('fHalfFrom / f1From: zero denominator → 0', () => {
  assert.equal(fHalfFrom(0, 0), 0);
  assert.equal(f1From(0, 0), 0);
});
