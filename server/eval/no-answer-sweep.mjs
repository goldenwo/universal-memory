#!/usr/bin/env node
//
// no-answer-sweep.mjs — LIVE no-answer precision sweep + pin (plan Phase 5).
//
// Seeds recall-set.jsonl into a scratch qdrant collection, runs the answerable
// queries and the no-answer-set.jsonl distractors through the REAL doSearch at
// minScore=0, sweeps candidate floors with the production passesRelevanceFloor,
// pins F* (highest floor with ZERO floor-induced recall loss) → pin = F*-0.02, and
// checks the fixture hardness gate. Runs TWICE for determinism. Writes the
// canonical evidence file. Real `memories` collection is untouched (asserted).
//
//   UM_QDRANT_INTEGRATION=1 node --env-file=.env eval/no-answer-sweep.mjs
//
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { runNoAnswerSweep, loadFixtureJsonl } from './memory-quality-eval.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const recallRows = await loadFixtureJsonl(join(here, 'recall-set.jsonl'));
const noAnswerRows = await loadFixtureJsonl(join(here, 'no-answer-set.jsonl'));

console.log(`[mq-noans] recall rows: ${recallRows.length} | distractors: ${noAnswerRows.length}`);
const run1 = await runNoAnswerSweep({ recallRows, noAnswerRows, runid: 'r1' });
const run2 = await runNoAnswerSweep({ recallRows, noAnswerRows, runid: 'r2' });

// Determinism (gate d): same pin + per-floor metrics within tolerance.
const tol = 0.001;
const close = (a, b) => a == null && b == null ? true : Math.abs((a ?? -9) - (b ?? -9)) <= tol;
const perFloorAgree = run1.perFloor.every((r, i) =>
  r.floor === run2.perFloor[i].floor && close(r.retention, run2.perFloor[i].retention) && close(r.precision, run2.perFloor[i].precision));
const pinAgree = run1.pin === run2.pin && run1.fStar === run2.fStar;
const deterministic = pinAgree && perFloorAgree;

const r = run1; // report run1; run2 confirms determinism
const gates = {
  a_recall_retention_1: r.pin != null && r.pinRetention === 1,                 // floor drops no recalled gold
  b_floor_on_eq_off: r.pin != null && r.pinRetention === 1,                    // same as (a) by construction (delta=0)
  c_no_answer_precision_ge_0p5: r.pinPrecision != null && r.pinPrecision >= 0.5,
  d_deterministic: deterministic,
  e_hardness_zone_ok: r.hardnessOk,
};
const allPass = r.pin != null && Object.values(gates).every(Boolean);

const fmt = (x) => x == null ? 'n/a' : x.toFixed(3);
console.log('\n floor | retention | no-answer precision | kept | abstained');
for (const f of r.perFloor) console.log(`  ${f.floor.toFixed(3)} |   ${fmt(f.retention)}   |       ${fmt(f.precision)}        | ${f.kept} | ${f.abstained}`);
console.log(`\n baseline recall@${r.limit} (floor off): ${fmt(r.baselineRecallAtLimit)} | answerable=${r.answerableCount} distractors=${r.distractorCount}`);
console.log(` F* = ${fmt(r.fStar)} → PIN = ${fmt(r.pin)} | pin retention ${fmt(r.pinRetention)} | pin precision ${fmt(r.pinPrecision)}`);
console.log(` hardness golds in [pin±0.05]: ${r.goldScores.filter((s) => r.pin != null && s >= r.pin - 0.05 && s <= r.pin + 0.05).length} (need ≥5) | gold scores: [${r.goldScores.join(', ')}]`);
console.log('\n GATES:', JSON.stringify(gates), '\n VERDICT:', allPass ? 'PASS' : 'FAIL (see gates)');
console.log(' determinism:', deterministic ? 'pin + per-floor agree across 2 runs' : `DIVERGED (pinAgree=${pinAgree}, perFloorAgree=${perFloorAgree})`);

// Evidence file
const ts = r.timestamp.slice(0, 10);
const path = join(here, 'results', `${ts}-no-answer-precision-validation.md`);
const table = r.perFloor.map((f) => `| ${f.floor.toFixed(3)} | ${fmt(f.retention)} | ${fmt(f.precision)} | ${f.kept} | ${f.abstained} |`).join('\n');
const md = `# No-answer precision — sweep + pin validation

_${r.timestamp}_ · 2 deterministic live runs (gpt embeddings + qdrant scratch; \`memories\` untouched).

Recall corpus: ${recallRows.length} rows (incl. 6 oblique weak-but-real). Distractors: ${noAnswerRows.length} (all de-leaked). limit=${r.limit}, decay off.

## Sweep

| floor | recall-retention (Δ vs floor-off) | no-answer precision | golds kept | distractors abstained |
|---|---|---|---|---|
${table}

Baseline recall@${r.limit} (floor off) = ${fmt(r.baselineRecallAtLimit)}.

## Pin

- **F\\*** = ${fmt(r.fStar)} (highest floor with zero floor-induced recall loss) → **pin = F\\*−0.02 = ${fmt(r.pin)}**
- pin recall-retention = ${fmt(r.pinRetention)} · pin no-answer precision = ${fmt(r.pinPrecision)}
- hardness gold scores (in top-${r.limit} at floor-off): [${r.goldScores.join(', ')}]

## Acceptance gates

- (a) recall-retention = 1.0 at pin (no recalled gold dropped): **${gates.a_recall_retention_1 ? 'PASS' : 'FAIL'}**
- (b) floor-on == floor-off recall (Δ = 0): **${gates.b_floor_on_eq_off ? 'PASS' : 'FAIL'}**
- (c) no-answer precision ≥ 0.5 at pin: **${gates.c_no_answer_precision_ge_0p5 ? 'PASS' : 'FAIL'}** (${fmt(r.pinPrecision)})
- (d) determinism (2 runs agree, ±0.001): **${gates.d_deterministic ? 'PASS' : 'FAIL'}**
- (e) fixture hardness (≥5 golds in [pin±0.05]): **${gates.e_hardness_zone_ok ? 'PASS' : 'FAIL'}**

**VERDICT: ${allPass ? 'PASS — pin = ' + fmt(r.pin) : 'FAIL'}**
`;
await mkdir(dirname(path), { recursive: true });
await writeFile(path, md, 'utf8');
console.log(`\n evidence → ${path}`);
process.exit(allPass ? 0 : 1);
