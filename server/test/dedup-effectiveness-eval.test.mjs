// server/test/dedup-effectiveness-eval.test.mjs — B3 dedup-effectiveness eval unit tests.
//
// Mirrors the checkpoint-cost-eval.mjs pattern: PURE aggregation logic lives in
// eval/dedup-effectiveness-eval.mjs as a named export (computeDedupReport), unit-
// tested here with NO live server / no I/O / no qdrant / no provider calls. The
// CLI shim (arg parsing, /api/add HTTP calls to a live server, qdrant count/delete
// cleanup) is guarded by IS_MAIN and only exercised by the keyed run, never by
// this suite.
//
// Fail-loud contract (per feedback_test_integrity / house convention): an empty
// rows array, or a row with an unrecognized `kind`, throws — a silently-skipped
// row would understate/inflate the reported merge rate rather than surfacing
// the gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDedupReport } from '../eval/dedup-effectiveness-eval.mjs';

test('computeDedupReport: empty rows throws', () => {
  assert.throws(() => computeDedupReport([]), /empty/);
});

test('computeDedupReport: unknown kind throws', () => {
  const rows = [{ id: 'r1', kind: 'bogus', mergedOnVariant: true, idStable: true }];
  assert.throws(() => computeDedupReport(rows), /kind/);
});

test('computeDedupReport: all-merge exact + paraphrase, clean control — perfect scores', () => {
  const rows = [
    { id: 'e1', kind: 'exact', mergedOnVariant: true, idStable: true },
    { id: 'e2', kind: 'exact', mergedOnVariant: true, idStable: true },
    { id: 'p1', kind: 'paraphrase', mergedOnVariant: true, idStable: true },
    { id: 'p2', kind: 'paraphrase', mergedOnVariant: true, idStable: true },
    { id: 'c1', kind: 'control', mergedOnVariant: false, idStable: false },
  ];
  const report = computeDedupReport(rows);
  assert.equal(report.n, 5);
  assert.deepEqual(report.byKind.exact, { n: 2, mergeRate: 1 });
  assert.deepEqual(report.byKind.paraphrase, { n: 2, mergeRate: 1 });
  assert.deepEqual(report.byKind.control, { n: 1, falseMerges: 0 });
  assert.equal(report.overall.duplicateMergeRate, 1);
  assert.equal(report.overall.falseMergeRate, 0);
});

test('computeDedupReport: partial paraphrase merge + one control false-merge — honest fractions, not rounded away', () => {
  const rows = [
    { id: 'e1', kind: 'exact', mergedOnVariant: true, idStable: true },
    { id: 'e2', kind: 'exact', mergedOnVariant: true, idStable: true },
    { id: 'p1', kind: 'paraphrase', mergedOnVariant: true, idStable: true },
    { id: 'p2', kind: 'paraphrase', mergedOnVariant: false, idStable: false }, // paraphrase MISS — must survive in the data
    { id: 'p3', kind: 'paraphrase', mergedOnVariant: true, idStable: true },
    { id: 'p4', kind: 'paraphrase', mergedOnVariant: true, idStable: true },
    { id: 'c1', kind: 'control', mergedOnVariant: false, idStable: false },
    { id: 'c2', kind: 'control', mergedOnVariant: true, idStable: true },  // control FALSE-MERGE — must surface loudly
  ];
  const report = computeDedupReport(rows);
  assert.equal(report.n, 8);
  assert.deepEqual(report.byKind.exact, { n: 2, mergeRate: 1 });
  assert.equal(report.byKind.paraphrase.n, 4);
  assert.equal(report.byKind.paraphrase.mergeRate, 0.75);
  assert.deepEqual(report.byKind.control, { n: 2, falseMerges: 1 });
  // overall.duplicateMergeRate spans exact+paraphrase together (both are true duplicates)
  assert.equal(report.overall.duplicateMergeRate, 5 / 6);
  assert.equal(report.overall.falseMergeRate, 0.5);
});

test('computeDedupReport: all-zero paraphrase merges reported honestly (not clamped/hidden)', () => {
  const rows = [
    { id: 'p1', kind: 'paraphrase', mergedOnVariant: false, idStable: false },
    { id: 'p2', kind: 'paraphrase', mergedOnVariant: false, idStable: false },
  ];
  const report = computeDedupReport(rows);
  assert.equal(report.byKind.paraphrase.mergeRate, 0);
  assert.equal(report.overall.duplicateMergeRate, 0);
});

test('computeDedupReport: a kind entirely absent from rows reports n:0 rather than throwing', () => {
  const rows = [
    { id: 'e1', kind: 'exact', mergedOnVariant: true, idStable: true },
  ];
  const report = computeDedupReport(rows);
  assert.equal(report.byKind.paraphrase.n, 0);
  assert.equal(report.byKind.paraphrase.mergeRate, 0);
  assert.equal(report.byKind.control.n, 0);
  assert.equal(report.byKind.control.falseMerges, 0);
});
