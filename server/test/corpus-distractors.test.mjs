// server/test/corpus-distractors.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanesFromRows } from '../eval/lib/corpus-distractors.mjs';

test('lanesFromRows: distinct lanes from seed_facts, in first-seen order', () => {
  const rows = [
    { seed_facts: [{ text: 'a', lane: 'home' }] },
    { seed_facts: [{ text: 'b', lane: 'dev' }] },
    { seed_facts: [{ text: 'c', lane: 'home' }] },
  ];
  assert.deepEqual(lanesFromRows(rows), ['home', 'dev']);
});

test('lanesFromRows: handles multi-fact rows + missing lane (skipped), empty → []', () => {
  const rows = [
    { seed_facts: [{ text: 'a', lane: 'work' }, { text: 'b', lane: 'food' }] },
    { seed_facts: [{ text: 'c' }] }, // no lane → skipped
  ];
  assert.deepEqual(lanesFromRows(rows), ['work', 'food']);
  assert.deepEqual(lanesFromRows([]), []);
  assert.deepEqual(lanesFromRows(null), []);
});
