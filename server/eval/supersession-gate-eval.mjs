/**
 * supersession-gate-eval.mjs — run the LIVE in-band judge over the three validation
 * fixtures and record, per row and per run, what the judge said (J-sg).
 *
 * History: the R2 paired-Opus review (BL3) asked for the JOINT operating point of the
 * in-band gates; the 2026-06-19 run of this harness (results/2026-06-19-supersession-gate-
 * eval-ceil1.json) is that record:
 *   - capture — held-out-contradiction-set.jsonl: every IN-BAND row should FIRE;
 *   - decline — over-supersession-set.jsonl `decline` rows should HOLD (a false-supersede
 *     demotes a true fact = SILENT DATA LOSS); `boundary` (version-upgrade) rows are kept
 *     apart (no pass/fail; §5.2);
 *   - duplicate — the D1 dedup set's merge-positive pairs should stay merged.
 *
 * Model migration Phase B (spec R2, docs/plans/2026-10-25-model-migration-phase-b/): the judge
 * now samples at temperature 1 and its threshold is re-measured, so this harness no longer
 * decides anything. It injects the judge into the REAL `evaluateInBandSupersession` at
 * `judgeThreshold: 0`, so every in-band record carries `contradicts` and its raw confidence
 * (not a pre-thresholded supersede) plus the call record (ok, failCause, the R1 fields,
 * latency), and the frozen scorer applies τ. The June in-band id lists are frozen (59 rows,
 * boundary included): a run whose live in-band set differs is recorded as an integrity breach.
 * `runGate` is the one code path for a live run and the offline replay control (recorded
 * cosines, a stub judge answering June's verdicts).
 *
 * In-band is decided as production does it for the band + eligibility gates:
 * `evaluateInBandSupersession` returns judged:true only when score ∈ [bandFloor,
 * bandCeiling] AND the row is partition-eligible (lane present). The #276 direction arm is
 * deliberately NOT mirrored: every row is handed a synthetic incoming-newer truth pair,
 * because this harness measures the JUDGE, and a production direction abstain never reaches it.
 *
 * Pure embed + real judge — NO qdrant, NO collections, real `memories` untouched.
 * Needs OPENAI_API_KEY (the embedder; the judge's provider key too). Run from server/:
 *   node --env-file=.env eval/supersession-gate-eval.mjs --out=<path> [--runs=1] [--ceiling=1.0]
 * It never writes the June reference path.
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';
import { timed, callRecord } from './lib/call-record.mjs';

// Labels in dedup-labels.json that are genuine re-ingests (must MERGE, never supersede).
const MERGE_POSITIVE = new Set(['identical', 'duplicate', 'paraphrase', 'near-duplicate', 'near_dup']);

export const FLOOR = 0.84;    // dedup floor (UM_DEDUP_EMBEDDING_THRESHOLD) — band lower edge
const JUNE_REF = new URL('./results/2026-06-19-supersession-gate-eval-ceil1.json', import.meta.url);
const KINDS = ['capture', 'decline', 'dup', 'boundary'];

/**
 * The three fixtures as one row list {id, lane, older, newer, kind, group}:
 *   kind 'capture'  → expected FIRE (held-out)
 *   kind 'decline'  → expected HOLD (over-supersession decline)
 *   kind 'boundary' → kept apart (over-supersession version-upgrade)
 *   kind 'dup'      → expected HOLD (a D1 duplicate must stay merged); synthetic lane for eligibility
 */
export async function loadGateRows() {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const heldout = await loadFixtureJsonl(here('./held-out-contradiction-set.jsonl'));
  const oversup = await loadFixtureJsonl(here('./over-supersession-set.jsonl'));
  const dedup = JSON.parse(await readFile(here('../test/fixtures/dedup-labels.json'), 'utf8'));
  return [
    ...heldout.map((r) => ({
      id: r.id, lane: r.lane, older: r.original_fact, newer: r.updated_fact,
      kind: 'capture', group: r.difficulty ?? 'single-slot-swap',
    })),
    ...oversup.map((r) => ({
      id: r.id, lane: r.lane, older: r.fact_a, newer: r.fact_b,
      kind: r.expected === 'boundary' ? 'boundary' : 'decline', group: r.relation,
    })),
    ...dedup.filter((r) => MERGE_POSITIVE.has(r.label)).map((r, i) => ({
      id: `dup${String(i + 1).padStart(2, '0')}`, lane: 'dev', older: r.a, newer: r.b,
      kind: 'dup', group: r.label,
    })),
  ];
}

/** The June in-band id lists by kind (sorted), from that run's perRow — the frozen set. */
export function juneInBand(perRow) {
  const out = Object.fromEntries(KINDS.map((k) => [k, []]));
  for (const r of perRow) if (r.inBand) out[r.kind].push(r.id);
  for (const k of KINDS) out[k].sort();
  return out;
}

/** The live in-band set against the frozen lists: {ok, missing (frozen, not in-band), extra}. */
export function inBandIntegrity(rows, frozen) {
  const want = new Set(KINDS.flatMap((k) => frozen[k] ?? []));
  const have = new Set(rows.filter((r) => r.inBand).map((r) => r.id));
  const missing = [...want].filter((id) => !have.has(id)).sort();
  const extra = [...have].filter((id) => !want.has(id)).sort();
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

/** Bounded-concurrency map — keeps the judge call-rate civil without serializing. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * `runs` runs of the real in-band decision over every row, with `judge` injected at
 * judgeThreshold 0. Each run's record for a row is {judged} plus, when the judge ran,
 * {contradicts, confidence} and the call record — taken from `decision.verdict`, so a row's
 * fields come from its own call even under concurrency. A row is in-band when it reached the
 * judge in every run.
 *
 * @param {object} p
 * @param {Array} p.rows - loadGateRows() rows
 * @param {(older: string, newer: string) => Promise<object>} p.judge - judgeContradiction-shaped
 * @param {(row: object) => Promise<number>} p.cosineOf - the dedup-hit score this row would show
 * @param {number} [p.runs]
 * @param {number} [p.ceiling] - band ceiling (1.0 = no skip)
 * @param {number} [p.concurrency]
 */
export async function runGate({ rows, judge, cosineOf, runs = 1, ceiling = 1.0, concurrency = 6 }) {
  const { evaluateInBandSupersession } = await import('../lib/supersede.mjs');
  return mapLimit(rows, concurrency, async (r) => {
    const cosine = await cosineOf(r);
    const records = [];
    for (let run = 0; run < runs; run++) {
      // evaluateInBandSupersession embeds nothing — it judges the two texts, handed the
      // precomputed cosine as the dedup-hit score. #276: the rows are bare text pairs, so every
      // row gets an incoming-newer truth pair, or the judge is never reached.
      // eslint-disable-next-line no-await-in-loop
      const decision = await evaluateInBandSupersession({
        score: cosine, olderText: r.older, newerText: r.newer,
        lane: r.lane, bandFloor: FLOOR, bandCeiling: ceiling, enabled: true, judgeThreshold: 0,
        olderTruth: { valid_from: '2026-01-01T00:00:00.000Z' }, newerTruth: { assertedAt: new Date().toISOString() },
        _judge: (o, n) => timed(() => judge(o, n)),
      });
      const v = decision.verdict;
      records.push(decision.judged
        ? { judged: true, contradicts: v.contradicts, confidence: v.confidence, reasoning: v.reasoning, ...callRecord(v) }
        : { judged: false });
    }
    return { ...r, cosine, inBand: records.every((x) => x.judged), runs: records };
  });
}

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function main() {
  const out = arg('out');
  if (!out) {
    console.error('[gate-eval] --out=<path> is required (this harness never writes the June reference path)');
    process.exit(2);
  }
  if (existsSync(out)) { console.error(`[gate-eval] refusing to overwrite ${out}`); process.exit(2); }
  if (!process.env.OPENAI_API_KEY && !process.env.UM_OPENAI_API_KEY) {
    console.error('[gate-eval] OPENAI_API_KEY not set — run: node --env-file=.env eval/supersession-gate-eval.mjs --out=<path>');
    process.exit(2);
  }
  const RUNS = Math.max(1, Number.parseInt(arg('runs', '1'), 10) || 1);
  const CEILING = Number.parseFloat(arg('ceiling', '1.0'));

  const { embed } = await import('../lib/embed.mjs');
  const { cosineStrict } = await import('../lib/vector.mjs');
  const { NOOP_METRICS } = await import('../lib/metrics.mjs');
  const { judgeContradiction, JUDGE_BACKENDS } = await import('../lib/contradiction-judge.mjs');
  const { autoSupersedeJudgeThreshold } = await import('../lib/supersede.mjs');
  const provider = process.env.UM_CONTRADICTION_PROVIDER ?? process.env.UM_SUMMARIZER_PROVIDER ?? 'openai';
  // The model the judge resolves to (contradiction-judge.mjs): env, else that provider's default.
  const JUDGE_MODEL = process.env.UM_CONTRADICTION_MODEL ?? JUDGE_BACKENDS[provider]?.defaults?.summarizerModel ?? null;

  const rows = await loadGateRows();
  const frozen = juneInBand(JSON.parse(await readFile(JUNE_REF, 'utf8')).perRow);

  // Embed every distinct text once (real embedder, same as prod dedup path).
  const cache = new Map();
  const need = new Set(rows.flatMap((r) => [r.older, r.newer]));
  process.stderr.write(`[gate-eval] embedding ${need.size} distinct texts...\n`);
  await mapLimit([...need], 8, async (t) => { const e = await embed(t, { metrics: NOOP_METRICS }); cache.set(t, e.vector); });
  const cosineOf = async (r) => +cosineStrict(cache.get(r.older), cache.get(r.newer)).toFixed(4);

  process.stderr.write(`[gate-eval] judging ${rows.length} rows × ${RUNS} run(s) at ceiling ${CEILING} (judge ${provider}/${JUDGE_MODEL}, threshold 0)...\n`);
  const judged = await runGate({ rows, judge: judgeContradiction, cosineOf, runs: RUNS, ceiling: CEILING });
  const integrity = inBandIntegrity(judged, frozen);

  const result = {
    timestamp: new Date().toISOString(),
    suite: 'J-sg',
    judgeProvider: provider,
    judgeModel: JUDGE_MODEL,
    embeddingModel: process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    floor: FLOOR, ceiling: CEILING, runs: RUNS, judgeThreshold: 0,
    inBandRef: 'eval/results/2026-06-19-supersession-gate-eval-ceil1.json',
    integrity,
    perRow: judged.map(({ id, kind, group, lane, cosine, inBand, runs, older, newer }) => ({ id, kind, group, lane, cosine, inBand, runs, older, newer })),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');

  // ---- Console summary at the production threshold (the scorer applies the registered τ grid) ----
  const tau = autoSupersedeJudgeThreshold();
  console.log(`\n=== supersession in-band gate eval — judge ${provider}/${JUDGE_MODEL}, ${RUNS} run(s), band [${FLOOR}, ${CEILING}] ===`);
  console.log(`in-band integrity vs June: ${integrity.ok ? 'OK (59 rows)' : `BREACH missing [${integrity.missing.join(',')}] extra [${integrity.extra.join(',')}]`}`);
  for (const kind of ['capture', 'decline', 'dup']) {
    const inB = judged.filter((r) => r.inBand && r.kind === kind);
    const fired = (run) => inB.filter((r) => r.runs[run].contradicts === true && r.runs[run].confidence >= tau).map((r) => r.id);
    const errors = inB.reduce((n, r) => n + r.runs.filter((x) => x.failCause === 'invoke-error').length, 0);
    console.log(`  ${kind.padEnd(8)} in-band ${String(inB.length).padStart(2)}  fired at τ=${tau}: ${Array.from({ length: RUNS }, (_, run) => fired(run).length).join(' / ')}  invoke-errors ${errors}` +
      (kind !== 'capture' ? `  run-1 fires [${fired(0).join(',')}]` : ''));
  }
  console.log(`result -> ${out}`);
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) main().catch((e) => { console.error('[gate-eval] FATAL:', e); process.exit(1); });
