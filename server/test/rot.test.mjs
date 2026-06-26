// server/test/rot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainPurity, retrievalPurity, effectiveDepth, engagedDepth } from '../eval/lib/rot.mjs';

test('chainPurity: clean chain — only the latest is current', () => {
  // depth 4: facts[0..2] superseded, facts[3] current, latestIdx=3
  const statuses = { 0: 'superseded', 1: 'superseded', 2: 'superseded', 3: 'current' };
  assert.deepEqual(chainPurity(statuses, 3), { staleSurvivors: 0, latestCurrent: true, latestOnly: true });
});

test('chainPurity: accumulation — two stale survivors still current', () => {
  // facts[1] and facts[2] never got demoted → staleSurvivors=2, not latestOnly
  const statuses = { 0: 'superseded', 1: 'current', 2: 'current', 3: 'current' };
  assert.deepEqual(chainPurity(statuses, 3), { staleSurvivors: 2, latestCurrent: true, latestOnly: false });
});

test('chainPurity: latest itself wrongly superseded → latestCurrent false', () => {
  const statuses = { 0: 'superseded', 1: 'superseded', 2: 'current', 3: 'superseded' };
  assert.deepEqual(chainPurity(statuses, 3), { staleSurvivors: 1, latestCurrent: false, latestOnly: false });
});

test('retrievalPurity: only latest surfaced, top-1 → onlyCurrent', () => {
  const facts = ['fact a', 'fact b', 'fact c']; // normalized
  const results = ['fact c', 'unrelated x', 'unrelated y']; // top-K bodies, rank order
  assert.deepEqual(retrievalPurity(results, facts, 3),
    { staleSurfaced: 0, latestSurfaced: true, latestTop1: true, onlyCurrent: true });
});

test('retrievalPurity: a stale version leaks into results → not onlyCurrent', () => {
  const facts = ['fact a', 'fact b', 'fact c'];
  const results = ['fact c', 'fact a']; // stale fact a still surfaced
  assert.deepEqual(retrievalPurity(results, facts, 3),
    { staleSurfaced: 1, latestSurfaced: true, latestTop1: true, onlyCurrent: false });
});

test('retrievalPurity: latest present but out-ranked → latestTop1 false', () => {
  const facts = ['fact a', 'fact b', 'fact c'];
  const results = ['fact b', 'fact c']; // stale b ranks above latest c
  assert.deepEqual(retrievalPurity(results, facts, 3),
    { staleSurfaced: 1, latestSurfaced: true, latestTop1: false, onlyCurrent: false });
});

test('effectiveDepth vs engagedDepth diverge: out-of-band ADD deepens store but does not engage', () => {
  // cycle1 ADD(no fire), cycle2 fired inband, cycle3 ADD-no-detector-hit (fired:false), cycle4 fired detector
  const ev = [
    { event: 'ADD', fired: false },              // cycle 1 (no predecessor)
    { event: 'SUPERSEDED_INBAND', fired: true }, // cycle 2
    { event: 'ADD', fired: false },              // cycle 3 — out-of-band, store grew, NOT engaged
    { event: 'ADD', fired: true },               // cycle 4 — detector fired
  ];
  assert.equal(effectiveDepth(ev), 4); // no DEDUP_MERGED → full store growth
  assert.equal(engagedDepth(ev), 2);   // only 2 cycles fired
});

test('effectiveDepth: DEDUP_MERGED collapses store growth', () => {
  const ev = [
    { event: 'ADD', fired: false },
    { event: 'DEDUP_MERGED', fired: false }, // value too near predecessor → did not deepen
    { event: 'SUPERSEDED_INBAND', fired: true },
  ];
  assert.equal(effectiveDepth(ev), 2); // 3 cycles − 1 dedup
  assert.equal(engagedDepth(ev), 1);
});
