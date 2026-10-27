/**
 * extraction-fidelity-eval.mjs — Tier-2 #10. Runs the REAL facts() extraction over a labelled
 * fixture, judges extracted↔gold both directions (lib/extraction-grader.mjs), and scores
 * micro-averaged precision/recall (pure extractionFidelity) + per-stratum metrics
 * (extractionByStratum). Sibling of answer-grader-eval.mjs. One invocation = one run (run
 * twice for stability). Live deps lazy-imported inside cliMain.
 *
 * Empty-gold (noise) rows short-circuit: the judge is never called for them and they feed
 * abstention counters only (spec R2-G4 — noise rows are excluded from precision sums).
 *
 * Modes:
 *   default        — judge-scored precision/recall + per-stratum + noise abstention.
 *   --verdict-only — NO judge calls for ANY row; per-row verdict (abstain/extract) vs the
 *                    designed/derived expected verdict; used by the CI guard + the 982 pass.
 *                    The result JSON carries verdictGate and extraction: null — no unjudged
 *                    pseudo-recall/precision may appear in a CI artifact of record.
 *
 * Run (from server/):
 *   node --env-file=.env eval/extraction-fidelity-eval.mjs --fixture eval/extraction-set.jsonl --out eval/results/<date>-tier2-extraction-run1.json
 *   --fixture may repeat (rows concatenate in argument order);
 *   --gate eval/mq-gate-thresholds.json evaluates extractionThresholds fail-closed (exit 1 on breach OR unconfigured gate).
 *   --gate is VALID ONLY with --verdict-only AND the openai provider (exit 2 otherwise):
 *   the extractionThresholds paths live under verdictGate.* (a judged run leaves them
 *   undefined → guaranteed 'unmeasured' breaches) and their pool floors are calibrated
 *   to the CI's openai fixture set. Judged runs and non-openai providers are gated by
 *   hand against pre-registered arc gates instead (#181 arc).
 *   --effort <level> / --thinking <adaptive|disabled> / --thinking-headroom <tokens> pass
 *   through to factsInvoke (ignored by models that take no such knob — anthropic capabilitiesFor).
 *   --control <gold-echo|first-gold|always-abstain|input-echo|replay> swaps the extractor for a canned
 *   one (positive controls: proves the scoring can reach both ends before any model arm runs;
 *   first-gold returns only each row's first gold fact, so the judge must leave the rest unmatched).
 *   replay (with --replay-file <result.json>) returns a recorded run's own extraction per row, so
 *   a retired extractor's run can be re-judged in today's window (judge-drift anchor).
 *
 * Every run also saves the raw per-call record (`calls`: extracted facts, stop reason, parse
 * status, tokens, cost, wall-clock latency, and the judge's per-fact verdicts), `callStats`,
 * and the sha256 of each fixture file it read.
 */
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import {
  extractionFidelity,
  extractionByStratum,
  computeVerdictGate,
  deriveExpectedVerdict,
  evaluateGate,
  formatGateReport,
  loadFixtureJsonl,
} from './memory-quality-eval.mjs';

function parseArgs(argv) {
  const args = { fixtures: [] };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--fixture') args.fixtures.push(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--verdict-only') args.verdictOnly = true;
    else if (argv[i] === '--gate') args.gate = argv[++i];
    else if (argv[i] === '--effort') args.effort = argv[++i];
    else if (argv[i] === '--thinking') args.thinking = argv[++i];
    else if (argv[i] === '--thinking-headroom') args.thinkingHeadroom = Number(argv[++i]);
    else if (argv[i] === '--control') args.control = argv[++i];
    else if (argv[i] === '--replay-file') args.replayFile = argv[++i];
  }
  return args;
}

/**
 * Canned extractors for positive controls, shaped like a provider module so they run
 * through the real facts() → scoring path. Per-row: gold-echo needs the row's gold.
 */
export function controlProvider(kind, row, { replay } = {}) {
  const outputs = {
    'gold-echo': () => row.expected_facts ?? [],
    'first-gold': () => (row.expected_facts ?? []).slice(0, 1),
    'always-abstain': () => [],
    'input-echo': () => [row.input_text],
    // A recorded run's own extraction for the row, re-judged in today's window — the
    // judge-drift anchor when the recorded extractor can no longer be run (2026-10-23 prereg C0).
    replay: () => replay.get(row.id),
  };
  if (!outputs[kind]) throw new Error(`unknown control '${kind}' (valid: ${Object.keys(outputs).join(', ')})`);
  if (kind === 'replay') {
    if (!replay) throw new Error('control replay needs --replay-file <recorded result.json>');
    if (!replay.has(row.id)) throw new Error(`row '${row.id}' is not in the replay record`);
  }
  return {
    supports: { facts: true },
    defaults: { factsModel: kind },
    factsInvoke: async () => ({ facts: outputs[kind](), usage: { tokensIn: 0, tokensOut: 0 }, stopReason: 'control' }),
  };
}

/** Row id → recorded extraction, from a prior run's result file (its `calls`). */
export async function loadReplay(path) {
  const { calls } = JSON.parse(await readFile(path, 'utf8'));
  return new Map(calls.map((c) => [c.id, c.extracted]));
}

const round = (x, places) => (x == null ? null : +x.toFixed(places));

/** sha256 of each fixture file's bytes, so a result names exactly what it scored. */
export async function fixtureDigests(paths) {
  const out = {};
  for (const path of paths) out[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  return out;
}

/** Nearest-rank percentile of an ascending-sorted array (null when empty). */
function percentile(sorted, q) {
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/**
 * Per-call cost / token / latency / stop-reason summary over the raw call records.
 * Means are per extraction call; latency is facts() wall-clock (network included).
 */
export function callStats(calls) {
  const n = calls.length;
  const sum = (key) => calls.reduce((acc, c) => acc + (c[key] ?? 0), 0);
  const mean = (key) => (n === 0 ? null : sum(key) / n);
  const latencies = calls.map((c) => c.latencyMs).sort((a, b) => a - b);
  const stopReasons = {};
  for (const c of calls) stopReasons[c.stopReason ?? 'null'] = (stopReasons[c.stopReason ?? 'null'] ?? 0) + 1;
  return {
    n,
    costUsd: { total: round(sum('costUsd'), 8), mean: round(mean('costUsd'), 10) },
    tokensIn: { mean: round(mean('tokensIn'), 2) },
    tokensOut: { mean: round(mean('tokensOut'), 2) },
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: n === 0 ? null : latencies[n - 1],
      mean: round(mean('latencyMs'), 1),
    },
    stopReasons,
    parseFailures: calls.filter((c) => c.parseOk === false).length,
  };
}

/**
 * A judged row's grader record: the verdicts, why ok is false, and one record per judge call
 * (recall, then precision) with its R1 fields and latency, from judgeExtraction (model
 * migration Phase B, spec R2 — G's request shape and served model are checked per call).
 */
export function judgeRecord(v) {
  return {
    ok: v.ok,
    ...(v.failCause ? { failCause: v.failCause } : {}),
    goldMatched: v.goldMatched,
    extractedSupported: v.extractedSupported,
    calls: v.calls ?? [],
  };
}

/** Normalize facts() output to a plain string list (factsInvoke returns string[]; defensive on objects). */
function normalizeExtracted(factsResult) {
  const f = factsResult?.facts;
  if (!Array.isArray(f)) return [];
  return f.map((x) => (typeof x === 'string' ? x : (x?.text ?? x?.memory ?? JSON.stringify(x)))).filter(Boolean);
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (args.fixtures.length === 0) {
    console.error('Usage: extraction-fidelity-eval.mjs --fixture <path> [--fixture <path> ...] [--out <path>] [--verdict-only] [--gate <thresholds.json>]');
    process.exit(2);
  }
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) {
    console.error('[extraction-eval] OPENAI_API_KEY not set — run: node --env-file=.env eval/extraction-fidelity-eval.mjs --fixture eval/extraction-set.jsonl');
    process.exit(2);
  }

  // Fail-fast on --gate misuse BEFORE any extraction spend (exit 2 = config error,
  // no result file — the classify step must never read these as metric breaches):
  // (a) --gate without --verdict-only: extractionThresholds are verdictGate-pathed,
  //     so a judged run can only ever fail them as 'unmeasured' — never meaningful.
  // (b) --gate with a non-openai provider: the thresholds are openai-calibrated.
  //     The provider read deliberately mirrors facts.mjs:48's env+default terms
  //     (`?? 'openai'`) — a one-line env read, kept in lockstep by construction.
  if (args.gate && !args.verdictOnly) {
    console.error('[extraction-eval] GATE FAIL: --gate requires --verdict-only (extractionThresholds are verdictGate-pathed; a judged run leaves them unmeasured — config error, not a breach).');
    process.exit(2);
  }
  if (args.gate && args.control) {
    console.error('[extraction-eval] GATE FAIL: --gate cannot score a --control run (config error, not a breach).');
    process.exit(2);
  }
  if (args.gate && (process.env.UM_FACTS_PROVIDER ?? 'openai') !== 'openai') {
    console.error(`[extraction-eval] GATE FAIL: --gate thresholds are openai-calibrated; UM_FACTS_PROVIDER=${process.env.UM_FACTS_PROVIDER} runs are gated by hand (config error, not a breach).`);
    process.exit(2);
  }

  // Fail-fast on an unconfigured gate BEFORE any extraction spend: no result file is
  // written, so the CI breach-vs-infra classify step correctly reads this as a config
  // error, never as a metric breach (an absent gate must never read as green either way).
  let gateThresholds = null;
  if (args.gate) {
    const config = JSON.parse(await readFile(args.gate, 'utf8'));
    gateThresholds = config.extractionThresholds;
    if (!Array.isArray(gateThresholds) || gateThresholds.length === 0) {
      console.error(`[extraction-eval] GATE FAIL: no extractionThresholds in ${args.gate} — gate unconfigured, not a pass (no result written).`);
      process.exit(1);
    }
  }

  const { facts } = await import('../lib/facts.mjs');
  // The grader: G's verdict, gpt-5.6-luna (model migration Phase B window 2, committed 0c4ca22),
  // through the library's own fallback constant so the eval and judgeExtraction cannot disagree.
  const { EXTRACTION_GRADER_FALLBACK_MODEL } = await import('../lib/extraction-grader.mjs');
  const model = process.env.UM_EXTRACTION_GRADER_MODEL || EXTRACTION_GRADER_FALLBACK_MODEL;
  const rows = [];
  for (const fixture of args.fixtures) rows.push(...await loadFixtureJsonl(fixture));
  const fixtureSha256 = await fixtureDigests(args.fixtures);

  // Truthful provider/model labels: captured from facts()'s own per-call return
  // ({provider, model} — facts.mjs), NEVER re-derived from env/registry (the old
  // env-only label reported the openai facts default, gpt-4.1-nano, on anthropic runs).
  let factsProvider = null;
  let factsModelSeen = null;
  const factsConfig = {
    temperature: 0,
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.thinking ? { thinking: args.thinking } : {}),
    ...(args.thinkingHeadroom ? { thinkingHeadroom: args.thinkingHeadroom } : {}),
  };
  const replay = args.replayFile ? await loadReplay(args.replayFile) : undefined;
  const calls = [];
  const runFacts = async (row) => {
    const ctx = args.control
      ? { ...factsConfig, provider: `control:${args.control}`, _providerOverride: controlProvider(args.control, row, { replay }) }
      : factsConfig;
    const t0 = performance.now();
    const factsResult = await facts(row.input_text, ctx);
    const latencyMs = Math.round(performance.now() - t0);
    factsProvider = factsResult.provider ?? factsProvider;
    factsModelSeen = factsResult.model ?? factsModelSeen;
    const extracted = normalizeExtracted(factsResult);
    const call = {
      id: row.id, extracted, stopReason: factsResult.stopReason ?? null, parseOk: factsResult.parseOk ?? null,
      tokensIn: factsResult.tokensIn, tokensOut: factsResult.tokensOut,
      costUsd: factsResult.costUsd, latencyMs,
      // What was actually sent and what answered — factsConfig above is only what was asked
      // for (a luna model drops its temperature 0); null for providers that don't report it.
      requestParams: factsResult.requestParams, servedModel: factsResult.servedModel,
      reasoningTokens: factsResult.reasoningTokens,
    };
    calls.push(call);
    return { extracted, call };
  };

  let result;
  if (args.verdictOnly) {
    // Judge-free: verdict = did the extractor produce anything at all.
    const verdictRows = [];
    for (const row of rows) {
      const { extracted } = await runFacts(row);
      verdictRows.push({
        id: row.id,
        expected: deriveExpectedVerdict(row),
        observed: extracted.length === 0 ? 'abstain' : 'extract',
        unstable: row.unstable === true,
      });
    }
    const verdictGate = computeVerdictGate(verdictRows);
    result = {
      timestamp: new Date().toISOString(), fixtures: args.fixtures, fixtureSha256, mode: 'verdict-only',
      judgeModel: null,
      factsProvider,
      factsModel: factsModelSeen,
      factsConfig,
      extraction: null,
      verdictGate,
      callStats: callStats(calls),
      calls,
    };
  } else {
    const { judgeExtraction } = await import('../lib/extraction-grader.mjs');
    const judgedRows = [];
    for (const row of rows) {
      const gold = row.expected_facts ?? [];
      const { extracted, call } = await runFacts(row);
      if (gold.length === 0) {
        // Noise row: nothing to judge — the only signal is whether extraction abstained.
        judgedRows.push({
          id: row.id, ok: true, noiseRow: true, stratum: row.stratum,
          goldTotal: 0, goldMatched: 0,
          extractedTotal: extracted.length, extractedSupported: 0,
        });
        continue;
      }
      const v = await judgeExtraction(row.input_text, gold, extracted, { model });
      call.judge = judgeRecord(v);
      judgedRows.push({
        id: row.id, ok: v.ok, stratum: row.stratum,
        goldTotal: gold.length,
        goldMatched: v.goldMatched.filter(Boolean).length,
        extractedTotal: extracted.length,
        extractedSupported: v.extractedSupported.filter(Boolean).length,
        // Infra-flake signal: the judge API call threw (vs answered unusably) —
        // surfaces in perRow as judgeError for the arc-gate carve-out.
        ...(v.failCause === 'invoke-error' ? { judgeError: true } : {}),
      });
    }
    const extraction = { ...extractionFidelity(judgedRows), byStratum: extractionByStratum(judgedRows) };
    result = {
      timestamp: new Date().toISOString(), fixtures: args.fixtures, fixtureSha256, mode: 'judged', judgeModel: model,
      factsProvider,
      factsModel: factsModelSeen,
      factsConfig,
      pinnable: extraction.parseFails === 0,
      extraction,
      callStats: callStats(calls),
      calls,
    };
  }

  const out = args.out ?? fileURLToPath(new URL(`./results/${result.timestamp.slice(0, 10)}-extraction-run1.json`, import.meta.url));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2) + '\n', 'utf8');

  if (args.verdictOnly) {
    const g = result.verdictGate;
    console.log(`[extraction-eval] mode=verdict-only abstain=${g.abstain.matched}/${g.abstain.total} (${g.abstain.matchRate}) extract=${g.extract.matched}/${g.extract.total} (${g.extract.matchRate}) excludedUnstable=${g.excludedUnstable} mismatches=[${g.mismatches.join(',')}]`);
  } else {
    const e = result.extraction;
    console.log(`[extraction-eval] judge=${model} graded=${e.graded} parseFails=${e.parseFails} precision=${e.precision} recall=${e.recall} f1=${e.f1} noiseAbstained=${e.noiseAbstained}/${e.noiseTotal}`);
    if (!result.pinnable) console.error(`[extraction-eval] WARNING: parseFails=${e.parseFails} > 0 — result NOT pinnable (treat as unmeasured); fix judge truncation/format before pinning targets.`);
  }
  const cs = result.callStats;
  console.log(`[extraction-eval] calls=${cs.n} costUsd mean=${cs.costUsd.mean} total=${cs.costUsd.total} latencyMs p50=${cs.latencyMs.p50} p95=${cs.latencyMs.p95} stopReasons=${JSON.stringify(cs.stopReasons)} parseFailures=${cs.parseFailures}`);
  console.log(`[extraction-eval] written to ${out}`);

  if (gateThresholds) {
    // Fail-closed breach path: the result JSON is already written above, so an exit 1
    // here IS a real metric breach (the CI classify step keys on file presence).
    // evaluateGate reads config.thresholds, so the namespaced key is re-wrapped — the
    // mq `thresholds` array stays untouched.
    const gate = evaluateGate(result, { thresholds: gateThresholds });
    console.log(formatGateReport(gate));
    if (gate.checked === 0) {
      console.error('[extraction-eval] GATE FAIL: 0 floors checked — gate unconfigured, not a pass.');
      process.exit(1);
    }
    if (!gate.pass) process.exit(1);
  }
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) cliMain().catch((e) => { console.error('[extraction-eval] FATAL:', e?.message ?? e); process.exit(1); });
