// server/test/rot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainPurity } from '../eval/lib/rot.mjs';

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
