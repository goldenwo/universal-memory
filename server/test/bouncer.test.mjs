import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounceTopHit, bouncerEnabled, bouncerTimeoutMs, BOUNCER_SCORE_GATE } from '../lib/bouncer.mjs';

test('BOUNCER_SCORE_GATE drift gate — pinned 0.60 from the 2026-06-23 live sweep; re-sweep if this changes', () => {
  // Pinned: lowest gate holding both mq floors (AC>=0.78, NAP>=0.95) over 2 identical live runs.
  // If this assertion fails, the gate was changed WITHOUT re-running --sweep — re-pin from a
  // committed 2-run sweep (eval/results/2026-06-23-bouncer-sweep-STATUS.md), do not just edit.
  assert.equal(BOUNCER_SCORE_GATE, 0.60);
});

const item = (over = {}) => ({ id: 'm1', score: 0.4, body: 'a memory body', ...over });
const grader = (out) => async () => out;                         // stub gradeAnswer
const opts = (over = {}) => ({ enabled: true, high: 0.55, tau: 0.05, gradeAnswer: grader({ ok: true, answers: false, confidence: 0.9 }), ...over });

test('no-op when disabled: no grade, answered:true, ok:true, graded:false', async () => {
  let called = 0;
  const r = await bounceTopHit('q', item(), opts({ enabled: false, gradeAnswer: async () => { called++; return { ok: true, answers: false, confidence: 1 }; } }));
  assert.deepEqual(r, { answered: true, ok: true, graded: false });
  assert.equal(called, 0);
});

test('no-op when no topItem', async () => {
  const r = await bounceTopHit('q', undefined, opts());
  assert.deepEqual(r, { answered: true, ok: true, graded: false });
});

test('skip-high: score > high trusts without grading', async () => {
  let called = 0;
  const r = await bounceTopHit('q', item({ score: 0.8 }), opts({ gradeAnswer: async () => { called++; return { ok: true, answers: false, confidence: 1 }; } }));
  assert.deepEqual(r, { answered: true, ok: true, graded: false, skippedHigh: true });
  assert.equal(called, 0);
});

test('in-band + grader says NOT answered → answered:false (the flag case)', async () => {
  const r = await bounceTopHit('q', item({ score: 0.4 }), opts({ gradeAnswer: grader({ ok: true, answers: false, confidence: 0.9 }) }));
  assert.deepEqual(r, { answered: false, ok: true, graded: true });
});

test('in-band + grader says answered (conf≥tau) → answered:true', async () => {
  const r = await bounceTopHit('q', item({ score: 0.4 }), opts({ gradeAnswer: grader({ ok: true, answers: true, confidence: 0.9 }) }));
  assert.deepEqual(r, { answered: true, ok: true, graded: true });
});

test('confidence below tau → not answered', async () => {
  const r = await bounceTopHit('q', item({ score: 0.4 }), opts({ tau: 0.5, gradeAnswer: grader({ ok: true, answers: true, confidence: 0.1 }) }));
  assert.equal(r.answered, false);
});

test('FAIL-OPEN: grader ok:false → answered:true, ok:false (no flag live)', async () => {
  const r = await bounceTopHit('q', item({ score: 0.4 }), opts({ gradeAnswer: grader({ ok: false, answers: false, confidence: 0 }) }));
  assert.deepEqual(r, { answered: true, ok: false, graded: true });
});

test('FAIL-OPEN: grader throws → answered:true, ok:false', async () => {
  const r = await bounceTopHit('q', item({ score: 0.4 }), opts({ gradeAnswer: async () => { throw new Error('boom'); } }));
  assert.deepEqual(r, { answered: true, ok: false, graded: true });
});

test('FAIL-OPEN on timeout: a never-resolving grader → answered:true, ok:false', async () => {
  const r = await bounceTopHit('q', item({ score: 0.4 }), opts({ timeoutMs: 5, gradeAnswer: () => new Promise(() => {}) }));
  assert.deepEqual(r, { answered: true, ok: false, graded: true });
});

test('late grader result after timeout does not throw or mutate (loser discarded)', async () => {
  let resolveLate;
  const late = new Promise((res) => { resolveLate = res; });
  const r = await bounceTopHit('q', item({ score: 0.4 }), opts({ timeoutMs: 5, gradeAnswer: () => late }));
  assert.equal(r.ok, false);                 // already failed open
  resolveLate({ ok: true, answers: false, confidence: 1 }); // late: must be harmless
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(r.ok, false);                 // unchanged
});

test('bouncerEnabled is opt-IN (default off, trim-aware)', () => {
  assert.equal(bouncerEnabled({}), false);
  assert.equal(bouncerEnabled({ UM_BOUNCER_ENABLED: 'true' }), true);
  assert.equal(bouncerEnabled({ UM_BOUNCER_ENABLED: ' true ' }), true);
  assert.equal(bouncerEnabled({ UM_BOUNCER_ENABLED: 'false' }), false);
});

test('bouncerTimeoutMs defaults to 1500, parses override, rejects junk', () => {
  assert.equal(bouncerTimeoutMs({}), 1500);
  assert.equal(bouncerTimeoutMs({ UM_BOUNCER_TIMEOUT_MS: '800' }), 800);
  assert.equal(bouncerTimeoutMs({ UM_BOUNCER_TIMEOUT_MS: 'x' }), 1500);
});
