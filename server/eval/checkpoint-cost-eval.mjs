/**
 * server/eval/checkpoint-cost-eval.mjs — README-benchmarks Task B2: checkpoint-cost eval.
 *
 * Sibling of lane-eval.mjs / cross-session-eval.mjs / d3-eval.mjs: PURE aggregation
 * (aggregateCostRuns) exported + unit-tested offline in
 * test/checkpoint-cost-eval.test.mjs; the CLI shim (arg parsing, live HTTP calls
 * against a running mem0-mcp-http server, qdrant + vault cleanup) is guarded by
 * IS_MAIN so importing this module for its pure export never opens a socket.
 *
 * Purpose: measure the real dollar + token cost of ONE session-checkpoint
 * synthesis (POST /api/checkpoint) over N runs against FIXTURE projects
 * (`bench-checkpoint-cost-<i>` — never real project names), so the README can
 * report a measured median/p95 cost per checkpoint instead of a guess.
 *
 * WALLED ITERATIONS: each iteration gets its OWN fixture project
 * (`bench-checkpoint-cost-0` .. `-<N-1>`). doCheckpoint has no incremental
 * cursor — without `since` it re-summarizes ALL of the project's same-day raw
 * captures, and captures are never archived after a checkpoint. Sharing one
 * project across same-day iterations therefore measures "the Nth checkpoint
 * over an accumulating transcript" (tokens_in grows ~linearly run-over-run),
 * NOT the steady-state number a reader cares about. Per-iteration projects
 * wall each measurement off: N independent samples of "one checkpoint over a
 * fresh 4-turn session".
 *
 * Unlike every other eval/*.mjs harness (which import mem0ai/Memory/embed
 * directly and drive them in-process), this one targets a LIVE, already-running
 * server over HTTP — it deliberately does NOT start/stop the server itself
 * (the keyed run starts+stops node --env-file=.env mem0-mcp-http.mjs around the
 * CLI invocation). This is the correct shape for measuring what a real caller
 * pays: the full HTTP + auth + reindex pipeline, not an in-process shortcut.
 *
 * Per iteration i of N:
 *   1. POST 4 templated conversation turns via /api/append-turn into project
 *      `bench-checkpoint-cost-<i>` (content also varies per i so synthesis has
 *      real, distinct material — a checkpoint with no new captures may no-op
 *      and report near-zero cost, silently understating the measurement).
 *   2. POST /api/checkpoint for that iteration's project.
 *   3. Record { cost_usd, tokens_in, tokens_out } from the response — fail-loud
 *      if any of the three is not a finite number (a checkpoint response
 *      missing cost telemetry is a regression, not a benign gap).
 *
 * Cleanup (always — success or failure): for EVERY iteration project
 * `bench-checkpoint-cost-<i>` (i in 0..N-1), delete its qdrant points from the
 * `memories` collection and remove its captures/, sessions/, state/ subtrees
 * under the vault dir. Scoped ONLY to the fixture project slugs — never
 * touches any other project's data.
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const FIXTURE_PROJECT_PREFIX = 'bench-checkpoint-cost';
const DEFAULT_BASE = 'http://127.0.0.1:6335';
const DEFAULT_N = 20;
const MIN_SUCCESSES = 15;

/** Per-iteration fixture project slug — walls each iteration's captures/summary/facts off from every other's. */
const fixtureProject = (i) => `${FIXTURE_PROJECT_PREFIX}-${i}`;

// ---------------------------------------------------------------------------
// PURE aggregation (no I/O) — unit-tested directly in
// test/checkpoint-cost-eval.test.mjs.
// ---------------------------------------------------------------------------

/**
 * TRUE median (not nearest-rank): even n averages the two middle values.
 * Deliberately distinct from lib/stats.mjs's nearest-rank percentile() — this
 * eval reports a central-tendency headline number, so the textbook median is
 * the right statistic. Throws on an empty sample (no median of nothing).
 *
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  if (values.length === 0) throw new Error('median: empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Nearest-rank p95 (house convention — matches lib/stats.mjs's rankValue):
 * idx = clamp(ceil(0.95*n) - 1, 0, n-1). Throws on an empty sample.
 *
 * @param {number[]} values
 * @returns {number}
 */
function p95NearestRank(values) {
  if (values.length === 0) throw new Error('p95NearestRank: empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Aggregate an array of per-run checkpoint-cost samples into the reported
 * summary shape: { n, cost_usd: {median, p95}, tokens_in: {median}, tokens_out: {median} }.
 *
 * FAIL-LOUD (per feedback_test_integrity / house convention): a run missing
 * `cost_usd` throws immediately — a dropped cost sample would silently
 * understate the reported number rather than surfacing the gap. `tokens_in`
 * and `tokens_out` are treated the same way for symmetry (both are load-
 * bearing headline numbers).
 *
 * @param {Array<{cost_usd:number, tokens_in:number, tokens_out:number}>} runs
 * @returns {{n:number, cost_usd:{median:number,p95:number}, tokens_in:{median:number}, tokens_out:{median:number}}}
 */
export function aggregateCostRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('aggregateCostRuns: runs must be a non-empty array (empty sample has no aggregate)');
  }
  const costUsd = [];
  const tokensIn = [];
  const tokensOut = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (typeof r?.cost_usd !== 'number' || !Number.isFinite(r.cost_usd)) {
      throw new Error(`aggregateCostRuns: run[${i}] missing/invalid cost_usd (got ${JSON.stringify(r?.cost_usd)})`);
    }
    if (typeof r?.tokens_in !== 'number' || !Number.isFinite(r.tokens_in)) {
      throw new Error(`aggregateCostRuns: run[${i}] missing/invalid tokens_in (got ${JSON.stringify(r?.tokens_in)})`);
    }
    if (typeof r?.tokens_out !== 'number' || !Number.isFinite(r.tokens_out)) {
      throw new Error(`aggregateCostRuns: run[${i}] missing/invalid tokens_out (got ${JSON.stringify(r?.tokens_out)})`);
    }
    costUsd.push(r.cost_usd);
    tokensIn.push(r.tokens_in);
    tokensOut.push(r.tokens_out);
  }
  return {
    n: runs.length,
    cost_usd: { median: median(costUsd), p95: p95NearestRank(costUsd) },
    tokens_in: { median: median(tokensIn) },
    tokens_out: { median: median(tokensOut) },
  };
}

// ---------------------------------------------------------------------------
// CLI shim — live HTTP calls + vault/qdrant cleanup. Guarded by IS_MAIN so
// importing this module for aggregateCostRuns never opens a socket.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, n: DEFAULT_N, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--n') args.n = Number.parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

/** Templated fake dev-session turns — vary per iteration `i` so each checkpoint has real new material to synthesize. */
function buildTurns(i) {
  const svc = `fictional-service-${i}`;
  return [
    { role: 'user', content: `Let's keep working on ${svc}. Iteration ${i}: I want to add a retry queue for the outbound webhook dispatcher.` },
    { role: 'assistant', content: `Sounds good — for ${svc} iteration ${i} I'll add an exponential-backoff retry queue (max 5 attempts, jitter) around the webhook dispatch call, and log each retry with the attempt count.` },
    { role: 'user', content: `Also add a dead-letter table for ${svc} so failed webhooks after max retries land somewhere inspectable instead of being dropped.` },
    { role: 'assistant', content: `Added a dead_letter_webhooks table for ${svc} (iteration ${i}): payload, error, attempt_count, first_failed_at columns; the dispatcher inserts there after retry exhaustion.` },
  ];
}

async function preflightHealth(base) {
  let res;
  try {
    res = await fetch(`${base}/health`);
  } catch (err) {
    console.error(`[checkpoint-cost-eval] server unreachable at ${base}/health: ${err.message}`);
    console.error(`[checkpoint-cost-eval] start it first: node --env-file=.env mem0-mcp-http.mjs`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`[checkpoint-cost-eval] ${base}/health returned HTTP ${res.status} — server is not healthy`);
    process.exit(2);
  }
}

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** Run one checkpoint iteration in its OWN project: seed 4 turns, then checkpoint. Returns the cost sample or throws a descriptive error. */
async function runIteration(base, i) {
  const project = fixtureProject(i);
  for (const turn of buildTurns(i)) {
    const r = await postJson(base, '/api/append-turn', { project, ...turn });
    if (!r.ok) {
      throw new Error(`append-turn failed (iteration ${i}): HTTP ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
  const r = await postJson(base, '/api/checkpoint', { project });
  if (!r.ok) {
    throw new Error(`checkpoint failed (iteration ${i}): HTTP ${r.status} ${JSON.stringify(r.json)}`);
  }
  const { cost_usd, tokens_in, tokens_out } = r.json ?? {};
  if (typeof cost_usd !== 'number' || typeof tokens_in !== 'number' || typeof tokens_out !== 'number') {
    throw new Error(`checkpoint response missing cost telemetry (iteration ${i}): ${JSON.stringify(r.json)}`);
  }
  return { cost_usd, tokens_in, tokens_out };
}

/** Delete every qdrant point tagged with ANY of the N iteration projects, from the live `memories` collection. Best-effort — logs and continues on failure. */
async function cleanupQdrant(n) {
  try {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const host = process.env.QDRANT_HOST ?? 'localhost';
    const port = Number.parseInt(process.env.QDRANT_PORT ?? '6333', 10);
    const client = new QdrantClient({ host, port });
    // One delete with a should-clause per iteration project (exact-value match
    // only — never a prefix wildcard, so no other project can be swept in).
    await client.delete('memories', {
      wait: true,
      filter: { should: Array.from({ length: n }, (_, i) => ({ key: 'project', match: { value: fixtureProject(i) } })) },
    });
    console.log(`[checkpoint-cost-eval] cleanup: deleted qdrant points for projects ${fixtureProject(0)}..${fixtureProject(n - 1)}`);
  } catch (err) {
    console.error(`[checkpoint-cost-eval] cleanup: qdrant delete failed (non-fatal): ${err.message}`);
  }
}

/** Remove every iteration project's captures/sessions/state subtrees under the vault dir. Scoped to the fixture slugs only. Best-effort. */
async function cleanupVault(n) {
  const vaultDir = process.env.UM_VAULT_DIR;
  if (!vaultDir) {
    console.error('[checkpoint-cost-eval] cleanup: UM_VAULT_DIR not set — skipping vault cleanup');
    return;
  }
  let removed = 0;
  for (let i = 0; i < n; i++) {
    for (const sub of ['captures', 'sessions', 'state']) {
      const target = join(vaultDir, sub, fixtureProject(i));
      try {
        await rm(target, { recursive: true, force: true });
        removed++;
      } catch (err) {
        console.error(`[checkpoint-cost-eval] cleanup: failed to remove ${target} (non-fatal): ${err.message}`);
      }
    }
  }
  console.log(`[checkpoint-cost-eval] cleanup: removed ${removed} vault subtrees under ${vaultDir} for ${FIXTURE_PROJECT_PREFIX}-0..${n - 1}`);
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!Number.isInteger(args.n) || args.n < 1) {
    console.error('[checkpoint-cost-eval] --n must be a positive integer');
    process.exit(2);
  }
  if (!args.out) {
    console.error('Usage: checkpoint-cost-eval.mjs [--base http://127.0.0.1:6335] [--n 20] --out <path>');
    process.exit(2);
  }

  // Preflight: this eval hits the live checkpoint synthesis pipeline (LLM
  // summarize + facts extraction), so it needs an API key. --env-file=.env
  // is the documented invocation; also try loading ./.env directly in case
  // the caller forgot the flag.
  if (!process.env.OPENAI_API_KEY) {
    try { process.loadEnvFile?.(); } catch { /* no ./.env — fall through */ }
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      '[checkpoint-cost-eval] OPENAI_API_KEY not set — checkpoint synthesis calls the live LLM.\n' +
      '  run: node --env-file=.env eval/checkpoint-cost-eval.mjs --n 20 --out eval/results/<date>-checkpoint-cost.json',
    );
    process.exit(2);
  }

  await preflightHealth(args.base);

  console.log(`[checkpoint-cost-eval] running ${args.n} walled checkpoint iterations against ${args.base} (projects=${FIXTURE_PROJECT_PREFIX}-0..${args.n - 1})...`);

  const runs = [];
  let failures = 0;
  const failureMessages = [];
  try {
    for (let i = 0; i < args.n; i++) {
      try {
        const sample = await runIteration(args.base, i);
        runs.push(sample);
        console.log(`[checkpoint-cost-eval] iteration ${i + 1}/${args.n}: cost_usd=${sample.cost_usd} tokens_in=${sample.tokens_in} tokens_out=${sample.tokens_out}`);
      } catch (err) {
        failures++;
        failureMessages.push(err.message);
        console.error(`[checkpoint-cost-eval] iteration ${i + 1}/${args.n} FAILED (continuing): ${err.message}`);
      }
    }
  } finally {
    await cleanupQdrant(args.n);
    await cleanupVault(args.n);
  }

  if (runs.length < MIN_SUCCESSES) {
    console.error(
      `[checkpoint-cost-eval] only ${runs.length}/${args.n} iterations succeeded ` +
      `(need >= ${MIN_SUCCESSES}) — refusing to emit aggregates. Failures:\n` +
      failureMessages.map((m) => `  - ${m}`).join('\n'),
    );
    process.exit(1);
  }

  const aggregate = aggregateCostRuns(runs);
  const result = {
    timestamp: new Date().toISOString(),
    protocol: 'walled iterations — one fixture project per iteration (steady-state: one checkpoint over a fresh 4-turn session)',
    n_requested: args.n,
    n_succeeded: runs.length,
    n_failed: failures,
    failures: failureMessages,
    aggregate,
    runs,
    environment: {
      node: process.version,
      um_facts_model: process.env.UM_FACTS_MODEL ?? null,
      um_summarize_model: process.env.UM_SUMMARIZE_MODEL ?? null,
      um_provider: process.env.UM_PROVIDER ?? process.env.UM_EMBEDDING_PROVIDER ?? 'openai',
      date: new Date().toISOString().slice(0, 10),
    },
  };

  await writeJson(args.out, result);
  console.log(`[checkpoint-cost-eval] result -> ${args.out}`);
  console.log(
    `[checkpoint-cost-eval] n=${aggregate.n} median cost_usd=${aggregate.cost_usd.median} ` +
    `p95 cost_usd=${aggregate.cost_usd.p95} median tokens_in=${aggregate.tokens_in.median} ` +
    `median tokens_out=${aggregate.tokens_out.median} (failures=${failures})`,
  );
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  cliMain().catch((e) => {
    console.error('[checkpoint-cost-eval] FATAL:', e);
    process.exit(1);
  });
}
