// server/test/supersession-gate-eval.test.mjs — the J-sg harness (model migration Phase B, spec R2,
// plan T2): runGate is the one code path for a live run and the offline replay control; the June
// in-band id lists are frozen and a live in-band set that differs is an integrity breach. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runGate, juneInBand, inBandIntegrity, loadGateRows, FLOOR } from '../eval/supersession-gate-eval.mjs';

const june = JSON.parse(await readFile(new URL('../eval/results/2026-06-19-supersession-gate-eval-ceil1.json', import.meta.url), 'utf8'));
const juneById = new Map(june.perRow.map((r) => [r.id, r]));
const recordedCosine = async (row) => juneById.get(row.id).cosine;

test('juneInBand: the frozen June in-band lists — capture 27, decline 11, duplicate 19, boundary 2 (os017, os018)', () => {
  const f = juneInBand(june.perRow);
  assert.deepEqual([f.capture.length, f.decline.length, f.dup.length, f.boundary.length], [27, 11, 19, 2]);
  assert.deepEqual(f.boundary, ['os017', 'os018']);
  assert.ok(f.capture.includes('ho39'), 'the closest row, at cosine 0.8407');
});

test('loadGateRows: the three fixtures normalise to the June row set (same ids, kinds and groups)', async () => {
  const rows = await loadGateRows();
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.group]), june.perRow.map((r) => [r.id, r.kind, r.group]));
});

test('runGate replay: June\'s per-row verdicts through the harness reproduce June\'s gate counts at 0.80, over its 5 runs', async () => {
  const rows = await loadGateRows();
  const byText = new Map(june.perRow.map((r) => [`${r.older}\u0000${r.newer}`, r]));
  const judge = async (o, n) => { const r = byText.get(`${o}\u0000${n}`); return { contradicts: r.supersede, confidence: r.confidence, reasoning: r.reasoning, ok: true }; };
  const out = await runGate({ rows, judge, cosineOf: recordedCosine, runs: 5 });
  assert.equal(inBandIntegrity(out, juneInBand(june.perRow)).ok, true);
  const fires = (r, run) => r.runs[run].contradicts === true && r.runs[run].confidence >= 0.80;
  for (let run = 0; run < 5; run++) {
    const inBand = out.filter((r) => r.inBand);
    assert.equal(inBand.filter((r) => r.kind === 'capture' && fires(r, run)).length, 27);
    assert.deepEqual(inBand.filter((r) => r.kind === 'decline' && fires(r, run)).map((r) => r.id), ['os003', 'os022']);
    assert.equal(inBand.filter((r) => r.kind === 'dup' && fires(r, run)).length, 0);
  }
});

test('runGate: the judge is injected at threshold 0, so each in-band record carries contradicts and its raw confidence', async () => {
  const rows = (await loadGateRows()).filter((r) => r.id === 'ho01' || r.id === 'ho03');
  const out = await runGate({ rows, judge: async () => ({ contradicts: true, confidence: 0.05, ok: true }), cosineOf: recordedCosine, runs: 1 });
  const [ho01, ho03] = out;
  assert.equal(ho01.inBand, true);
  assert.deepEqual([ho01.runs[0].judged, ho01.runs[0].contradicts, ho01.runs[0].confidence], [true, true, 0.05], 'a 0.05 confidence is recorded, not thresholded away');
  assert.equal(ho03.inBand, false, `ho03 sits below the ${FLOOR} floor`);
  assert.deepEqual(ho03.runs[0], { judged: false });
});

test('runGate: under concurrency each row\'s record comes from its own call', async () => {
  const rows = await loadGateRows();
  const judge = async (o) => {
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
    return { contradicts: false, confidence: 0, ok: true, requestParams: { model: 'm' }, servedModel: `served:${o}`, systemFingerprint: null, reasoningTokens: 0, stopReason: 'stop' };
  };
  const out = await runGate({ rows, judge, cosineOf: recordedCosine, runs: 2, concurrency: 6 });
  for (const r of out.filter((x) => x.inBand)) {
    for (const run of r.runs) {
      assert.equal(run.servedModel, `served:${r.older}`, r.id);
      assert.equal(typeof run.ms, 'number');
    }
  }
});

test('runGate: an invoke-error is recorded with ok/failCause and no response fields', async () => {
  const rows = (await loadGateRows()).filter((r) => r.id === 'ho01');
  const out = await runGate({ rows, judge: async () => ({ contradicts: false, confidence: 0, ok: false, failCause: 'invoke-error' }), cosineOf: recordedCosine, runs: 1 });
  const rec = out[0].runs[0];
  assert.deepEqual([rec.judged, rec.ok, rec.failCause, 'requestParams' in rec], [true, false, 'invoke-error', false]);
});

test('inBandIntegrity: a live in-band set that differs from the frozen lists is a breach, naming the rows', () => {
  const frozen = { capture: ['a', 'b'], decline: ['c'], dup: [], boundary: ['d'] };
  const rows = (ids) => ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, inBand: ids.includes(id) }));
  assert.deepEqual(inBandIntegrity(rows(['a', 'b', 'c', 'd']), frozen), { ok: true, missing: [], extra: [] });
  assert.deepEqual(inBandIntegrity(rows(['a', 'c', 'd', 'e']), frozen), { ok: false, missing: ['b'], extra: ['e'] });
  assert.equal(inBandIntegrity(rows(['a', 'b', 'c']), frozen).ok, false, 'a boundary row leaving the band is a breach too');
});
