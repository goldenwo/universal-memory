/**
 * Retrieval relevance-floor config + predicate (no-answer precision, v1.6).
 *
 * retrievalMinScore() is the eval-pinned floor below which doSearch drops a
 * result; passesRelevanceFloor() is the per-result keep/drop decision. Both are
 * pure so they can be unit-tested offline and reused by the eval sweep.
 *
 * The default is PROVISIONAL (pending the Phase-5 grown-fixture sweep, gates a–e)
 * and recall-safe by construction: missing/non-numeric scores are KEPT, and a
 * floor of 0 is inert. Keep the default in lockstep with .env.example
 * UM_RETRIEVAL_MIN_SCORE (added Phase 6) — this is the drift gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retrievalMinScore,
  passesRelevanceFloor,
  DEFAULT_RETRIEVAL_MIN_SCORE,
} from '../lib/retrieval.mjs';

// ---------------------------------------------------------------------------
// retrievalMinScore — eval-pinned default + env override (drift gate)
// ---------------------------------------------------------------------------

test('retrievalMinScore: provisional default (lockstep with .env.example), env-overridable', () => {
  assert.equal(DEFAULT_RETRIEVAL_MIN_SCORE, 0.30, 'provisional pin — pending Phase-5 sweep; lockstep with .env.example');
  assert.equal(retrievalMinScore({}), DEFAULT_RETRIEVAL_MIN_SCORE, 'unset → default');
  assert.equal(retrievalMinScore({ UM_RETRIEVAL_MIN_SCORE: '0.4' }), 0.4, 'valid float parsed');
  assert.equal(retrievalMinScore({ UM_RETRIEVAL_MIN_SCORE: '0.35' }), 0.35);
});

test('retrievalMinScore: explicit 0 is honored (inert escape hatch)', () => {
  assert.equal(retrievalMinScore({ UM_RETRIEVAL_MIN_SCORE: '0' }), 0, '0 = off, not the default');
});

test('retrievalMinScore: invalid / empty → default; whitespace trimmed', () => {
  assert.equal(retrievalMinScore({ UM_RETRIEVAL_MIN_SCORE: '' }), DEFAULT_RETRIEVAL_MIN_SCORE, 'empty → default');
  assert.equal(retrievalMinScore({ UM_RETRIEVAL_MIN_SCORE: 'not-a-number' }), DEFAULT_RETRIEVAL_MIN_SCORE, 'invalid → default');
  assert.equal(retrievalMinScore({ UM_RETRIEVAL_MIN_SCORE: '  0.32  ' }), 0.32, 'leading/trailing whitespace tolerated');
});

// ---------------------------------------------------------------------------
// passesRelevanceFloor — the per-result keep/drop decision (recall-safe)
// ---------------------------------------------------------------------------

test('passesRelevanceFloor: present numeric score gated by floor (inclusive)', () => {
  assert.equal(passesRelevanceFloor(0.50, 0.30), true, 'above floor → keep');
  assert.equal(passesRelevanceFloor(0.20, 0.30), false, 'below floor → drop');
  assert.equal(passesRelevanceFloor(0.30, 0.30), true, 'equal to floor → keep (inclusive)');
});

test('passesRelevanceFloor: missing / non-numeric score is KEPT (recall-safe polarity)', () => {
  assert.equal(passesRelevanceFloor(undefined, 0.30), true, 'missing score → keep, never drop');
  assert.equal(passesRelevanceFloor(null, 0.30), true);
  assert.equal(passesRelevanceFloor(Number.NaN, 0.30), true);
  assert.equal(passesRelevanceFloor('0.1', 0.30), true, 'non-number type → keep (do not coerce-and-drop)');
});

test('passesRelevanceFloor: floor of 0 (or negative) is inert — keeps everything', () => {
  assert.equal(passesRelevanceFloor(0.05, 0), true, 'floor 0 → no filtering');
  assert.equal(passesRelevanceFloor(0.05, -1), true, 'non-positive floor → no filtering');
  assert.equal(passesRelevanceFloor(undefined, 0), true);
});
