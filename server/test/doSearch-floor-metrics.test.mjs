/**
 * doSearch relevance-floor observability counter (no-answer precision, v1.6).
 *
 * um_retrieval_floor_total{outcome=trimmed|abstained|passthrough}, incremented
 * ONCE PER SEARCH, only when the floor is active (minScore>0) and the search
 * returned ≥1 row before the floor. Inert path (minScore≤0) and zero-result
 * searches increment nothing — so the metric is a clean soak signal for how
 * often / how hard the floor fires in the wild (spec §7 R1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { doSearch } from '../mem0-mcp-http.mjs';
import { umRetrievalFloorTotal } from '../lib/metrics.mjs';

const row = (id, score) => ({ id, memory: `mem-${id}`, metadata: { id, title: id, status: 'current' }, ...(score === undefined ? {} : { score }) });
const mockMemory = (results) => ({ search: async () => ({ results }) });

async function floorCount(outcome) {
  const m = await umRetrievalFloorTotal.get();
  return m.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
}
async function totalCount() {
  const m = await umRetrievalFloorTotal.get();
  return m.values.reduce((s, v) => s + v.value, 0);
}

test('floor counter: trimmed (+1) when the floor removes some-but-not-all', async () => {
  const before = await floorCount('trimmed');
  await doSearch('q', 5, false, true, { memory: mockMemory([row('a', 0.5), row('b', 0.2)]), minScore: 0.3 });
  assert.equal(await floorCount('trimmed') - before, 1);
});

test('floor counter: abstained (+1) when the floor empties a non-empty set', async () => {
  const before = await floorCount('abstained');
  await doSearch('q', 5, false, true, { memory: mockMemory([row('a', 0.1), row('b', 0.2)]), minScore: 0.3 });
  assert.equal(await floorCount('abstained') - before, 1);
});

test('floor counter: passthrough (+1) when the floor is active but removes nothing', async () => {
  const before = await floorCount('passthrough');
  await doSearch('q', 5, false, true, { memory: mockMemory([row('a', 0.9), row('b', 0.8)]), minScore: 0.3 });
  assert.equal(await floorCount('passthrough') - before, 1);
});

test('floor counter: NO increment when inert (minScore=0)', async () => {
  const before = await totalCount();
  await doSearch('q', 5, false, true, { memory: mockMemory([row('a', 0.1)]), minScore: 0 });
  assert.equal(await totalCount() - before, 0, 'inert path emits nothing');
});

test('floor counter: NO increment when the search returned zero rows pre-floor', async () => {
  const before = await totalCount();
  await doSearch('q', 5, false, true, { memory: mockMemory([]), minScore: 0.3 });
  assert.equal(await totalCount() - before, 0, 'empty input → no outcome to record');
});
