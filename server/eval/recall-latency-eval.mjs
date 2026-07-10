/**
 * server/eval/recall-latency-eval.mjs — README-benchmarks Task B4: end-to-end
 * recall-latency eval.
 *
 * Sibling of checkpoint-cost-eval.mjs / dedup-effectiveness-eval.mjs: PURE
 * aggregation (percentiles) exported + unit-tested offline in
 * test/recall-latency-eval.test.mjs; the CLI shim (arg parsing, live HTTP
 * calls against a running server, qdrant cleanup) is guarded by IS_MAIN so
 * importing this module for its pure export never opens a socket.
 *
 * Purpose: measure the full end-to-end latency of a `memory_search` call —
 * the SAME path a real caller (Claude Code, the mem0-compat facade, a
 * vendor connector) pays — over the full MCP wire protocol (POST /mcp
 * JSON-RPC tools/call), not an in-process shortcut. The README figure ships
 * labeled "measured end-to-end against UM's API".
 *
 * TWO MODES, one shared timed-search core:
 *
 *   --mode seed-and-measure (dev leg): seeds a throwaway ~300-fact project
 *   (FIXTURE_PROJECT = 'bench-recall-latency') via POST /api/add (synthetic
 *   single-fact texts, unique codename entities across varied topics, so
 *   searches see a realistic score spread — extraction runs on every seed
 *   write, which is expected and cheap on a nano facts model), then runs the
 *   shared timed-search core against that corpus, then cleans up every
 *   seeded qdrant point in `finally` (project-filter delete, mirroring the
 *   sibling evals' cleanup convention — scoped ONLY to FIXTURE_PROJECT, never
 *   a wildcard sweep).
 *
 *   --mode measure-only (Pi leg): NO seeding, NO writes of any kind — reads
 *   the corpus size from /health and runs the SAME shared timed-search core
 *   read-only against whatever corpus is already live at --base. This is the
 *   only mode meant to be pointed at a production instance.
 *
 * Both modes: WARMUP (5 discarded calls, to exclude first-call connection /
 * cold-cache overhead from the reported distribution) then N (default 100)
 * TIMED calls cycling a fixed default query list (overridable via --queries
 * <path-to-json-array>), each timed over the FULL HTTP round-trip of
 * `POST /mcp` `tools/call` `memory_search` (default limit — no explicit
 * limit override, so the server's own default applies). Percentiles are
 * nearest-rank (house convention, matches eval/lib/stats.mjs's rankValue).
 *
 * RATE-LIMIT AWARENESS: the server's token-bucket limiter (lib/rate-limit.mjs,
 * default rpm:60/burst:10) applies whenever the loopback bypass is off (e.g.
 * the Pi's hardened config). `--pace-ms <ms>` sleeps between calls (the sleep
 * is OUTSIDE the timed window, so per-call latency is unaffected); a 429
 * response is retried after its Retry-After (retry attempts are never counted
 * as samples — the timer restarts on the retried call). Pacing changes only
 * the request ARRIVAL rate, never the measured round-trip.
 *
 * AUTH: optional. If UM_AUTH_TOKEN is set in the environment, every request
 * carries `Authorization: Bearer <UM_AUTH_TOKEN>` — /mcp uses the
 * Bearer-only extractor (lib/auth.mjs extractBearer; the `Token <key>`
 * scheme is accepted ONLY on mem0-compat routes, which this eval never
 * touches). The token value is NEVER logged or written into the result JSON
 * — only whether it was present (environment.authPresent: boolean).
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const FIXTURE_PROJECT = 'bench-recall-latency';
const DEFAULT_BASE = 'http://127.0.0.1:6335';
const DEFAULT_CORPUS_SIZE = 300;
const DEFAULT_N = 100;
const WARMUP_COUNT = 5;

// Fixed 10-query list cycled across both legs (dev + Pi): a mix of
// codename-targeted (matches the dev leg's synthetic seed entities) and
// generic topical/recall-shaped queries (matches production-corpus content
// domains: hardware, install paths, user rules/preferences, networking).
// Overridable via --queries <path> for either leg.
export const DEFAULT_QUERIES = [
  'what hardware does the server run on',
  'user rules about databases',
  'tailnet configuration',
  'install path for the memory server',
  'what embedding model is configured',
  'user preferences for code review',
  'how is authentication configured',
  'recent project decisions',
  'what does the codename Zephyr-9 refer to',
  'summary of the current project state',
];

// ---------------------------------------------------------------------------
// PURE aggregation (no I/O) — unit-tested directly in
// test/recall-latency-eval.test.mjs.
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentiles of a numeric sample, for each `p` (0-100) in
 * `ps`. Sorts a COPY ascending (never mutates `samples`) and computes
 * idx = clamp(ceil((p/100)*n) - 1, 0, n-1) per the house nearest-rank
 * convention (eval/lib/stats.mjs's rankValue). Throws on an empty sample —
 * there is no percentile of nothing, and a silently-empty result would
 * understate a latency regression rather than surfacing it (fail-loud, per
 * house convention).
 *
 * Returns a plain object keyed by each requested `p` (numeric keys become
 * string keys per JS object semantics, e.g. `result[50]` and `result['50']`
 * both work) — only the requested percentiles are present.
 *
 * @param {number[]} samples
 * @param {number[]} ps  percentiles to compute, each in [0, 100]
 * @returns {Record<number, number>}
 */
export function percentiles(samples, ps) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('percentiles: samples must be a non-empty array (empty sample has no percentile)');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const out = {};
  for (const p of ps) {
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
    out[p] = sorted[idx];
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI shim — live HTTP calls + qdrant cleanup. Guarded by IS_MAIN so
// importing this module for `percentiles` never opens a socket.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    mode: 'seed-and-measure',
    base: DEFAULT_BASE,
    corpus: DEFAULT_CORPUS_SIZE,
    n: DEFAULT_N,
    queries: null,
    hostLabel: null,
    paceMs: 0,
    out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') args.mode = argv[++i];
    else if (a === '--base') args.base = argv[++i];
    else if (a === '--corpus') args.corpus = Number.parseInt(argv[++i], 10);
    else if (a === '--n') args.n = Number.parseInt(argv[++i], 10);
    else if (a === '--queries') args.queries = argv[++i];
    else if (a === '--host-label') args.hostLabel = argv[++i];
    else if (a === '--pace-ms') args.paceMs = Number.parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

async function loadQueries(path) {
  if (!path) return DEFAULT_QUERIES;
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((q) => typeof q === 'string')) {
    throw new Error(`loadQueries: ${path} must be a non-empty JSON array of strings`);
  }
  return parsed;
}

/** Varied topic domains for synthetic seed facts — deliberately heterogeneous so search scores spread realistically instead of clustering. */
const SEED_TOPICS = [
  (codename) => `The database used by ${codename} is PostgreSQL 16.`,
  (codename) => `${codename}'s deploy pipeline runs on GitHub Actions with a self-hosted runner.`,
  (codename) => `The preferred code style for ${codename} is 2-space indentation, no semicolons.`,
  (codename) => `${codename} is hosted on a Raspberry Pi 5 behind a Tailscale tailnet.`,
  (codename) => `The default embedding model for ${codename} is text-embedding-3-small.`,
  (codename) => `${codename}'s test suite runs via node --test with no external test framework.`,
  (codename) => `Authentication for ${codename} uses a single bearer token, no OAuth.`,
  (codename) => `${codename} stores vectors in a qdrant collection named memories.`,
  (codename) => `The install path for ${codename} on the Pi is ~/um-build.`,
  (codename) => `${codename}'s backup cron runs nightly and writes to ~/um-backups.`,
];

/** Deterministic synthetic seed text for iteration i: unique codename entity + a rotating topic template. */
function seedFact(i) {
  const codename = `Codename-${i}`;
  const topicFn = SEED_TOPICS[i % SEED_TOPICS.length];
  return topicFn(codename);
}

async function preflightHealth(base) {
  let res;
  try {
    res = await fetch(`${base}/health`);
  } catch (err) {
    console.error(`[recall-latency-eval] server unreachable at ${base}/health: ${err.message}`);
    console.error(`[recall-latency-eval] start it first: node --env-file=.env mem0-mcp-http.mjs`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`[recall-latency-eval] ${base}/health returned HTTP ${res.status} — server is not healthy`);
    process.exit(2);
  }
  return res.json().catch(() => ({}));
}

function authHeaders() {
  const token = process.env.UM_AUTH_TOKEN;
  if (!token) return {};
  // Bearer scheme — /mcp and /api/* use extractBearer (Bearer-only; the
  // `Token <key>` scheme is compat-routes-only). Never logged.
  return { Authorization: `Bearer ${token}` };
}

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

/** Seed one synthetic fact into FIXTURE_PROJECT via /api/add. Fails loud on non-2xx (a dropped seed silently shrinks the measured corpus). */
async function seedOne(base, i) {
  const r = await postJson(base, '/api/add', {
    text: seedFact(i),
    metadata: { project: FIXTURE_PROJECT },
    surface: 'eval-recall-latency',
  });
  if (!r.ok) throw new Error(`seed ${i} failed: HTTP ${r.status} ${JSON.stringify(r.json)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One timed memory_search call over the FULL /mcp JSON-RPC round-trip. Returns elapsed ms. Fails loud on transport or JSON-RPC error — a swallowed error would silently drop a sample from the distribution. A 429 (rate-limited) is retried after Retry-After, up to MAX_429_RETRIES; the retry restarts the timer so throttle waits never inflate a sample. */
const MAX_429_RETRIES = 5;
async function timedSearch(base, query) {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query } },
      }),
    });
    const json = await res.json().catch(() => null);
    const elapsedMs = performance.now() - started;
    if (res.status === 429) {
      if (attempt >= MAX_429_RETRIES) {
        throw new Error(`memory_search still 429 after ${MAX_429_RETRIES} retries — raise --pace-ms (server token bucket: lib/rate-limit.mjs)`);
      }
      const retryAfterSec = Number.parseInt(res.headers.get('retry-after') ?? '2', 10);
      await sleep(Math.max(1, retryAfterSec) * 1000);
      continue; // retry attempt is NOT a sample; timer restarts above
    }
    if (!res.ok) throw new Error(`memory_search HTTP ${res.status}: ${JSON.stringify(json)}`);
    if (json?.error) throw new Error(`memory_search JSON-RPC error: ${JSON.stringify(json.error)}`);
    return elapsedMs;
  }
}

/** Shared timed-search core for both modes: WARMUP_COUNT discarded calls, then n timed calls cycling `queries`. `paceMs` sleeps between calls OUTSIDE the timed window (arrival-rate control only). Returns the raw ms samples (length n). */
async function runTimedSearches(base, queries, n, paceMs = 0) {
  console.log(`[recall-latency-eval] warmup: ${WARMUP_COUNT} discarded searches...`);
  for (let i = 0; i < WARMUP_COUNT; i++) {
    await timedSearch(base, queries[i % queries.length]);
    if (paceMs > 0) await sleep(paceMs);
  }
  console.log(`[recall-latency-eval] timing ${n} searches against ${base}${paceMs > 0 ? ` (pace=${paceMs}ms between calls)` : ''}...`);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const ms = await timedSearch(base, queries[i % queries.length]);
    samples.push(ms);
    if ((i + 1) % 20 === 0 || i === n - 1) {
      console.log(`[recall-latency-eval] ${i + 1}/${n} timed (last=${ms.toFixed(1)}ms)`);
    }
    if (paceMs > 0 && i < n - 1) await sleep(paceMs);
  }
  return samples;
}

/** Delete every qdrant point tagged FIXTURE_PROJECT from the live `memories` collection. Best-effort — logs and continues on failure. */
async function cleanupQdrant() {
  try {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const host = process.env.QDRANT_HOST ?? 'localhost';
    const port = Number.parseInt(process.env.QDRANT_PORT ?? '6333', 10);
    const client = new QdrantClient({ host, port });
    await client.delete('memories', {
      wait: true,
      filter: { must: [{ key: 'project', match: { value: FIXTURE_PROJECT } }] },
    });
    console.log(`[recall-latency-eval] cleanup: deleted qdrant points for project=${FIXTURE_PROJECT}`);
  } catch (err) {
    console.error(`[recall-latency-eval] cleanup: qdrant delete failed (non-fatal): ${err.message}`);
  }
}

async function countMemories() {
  try {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    const host = process.env.QDRANT_HOST ?? 'localhost';
    const port = Number.parseInt(process.env.QDRANT_PORT ?? '6333', 10);
    const client = new QdrantClient({ host, port });
    return await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  } catch {
    return null;
  }
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function buildResult({ mode, base, n, queries, samples, corpusSize, hostLabel }) {
  const stats = percentiles(samples, [50, 95, 99]);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    timestamp: new Date().toISOString(),
    protocol: 'full HTTP round-trip of POST /mcp JSON-RPC tools/call memory_search — the same path a real MCP caller pays. WARMUP (5 discarded) then N timed calls cycling a fixed query list. Percentiles nearest-rank.',
    mode,
    base,
    n_requested: n,
    n_measured: samples.length,
    latency_ms: {
      p50: stats[50],
      p95: stats[95],
      p99: stats[99],
      mean,
      min: Math.min(...samples),
      max: Math.max(...samples),
    },
    samples_ms: samples,
    queriesUsed: queries,
    environment: {
      host: hostLabel ?? 'dev-x86',
      cpuModel: os.cpus()?.[0]?.model ?? null,
      node: process.version,
      um_embedding_model: process.env.UM_EMBEDDING_MODEL ?? null,
      um_provider: process.env.UM_PROVIDER ?? process.env.UM_EMBEDDING_PROVIDER ?? 'openai',
      corpusSize,
      n: samples.length,
      authPresent: Boolean(process.env.UM_AUTH_TOKEN),
      date: new Date().toISOString().slice(0, 10),
    },
  };
}

async function runSeedAndMeasure(args) {
  if (!process.env.OPENAI_API_KEY) {
    try { process.loadEnvFile?.(); } catch { /* no ./.env — fall through */ }
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      '[recall-latency-eval] OPENAI_API_KEY not set — seeding calls the live LLM (facts extraction) + embedding provider.\n' +
      '  run: node --env-file=.env eval/recall-latency-eval.mjs --mode seed-and-measure --corpus 300 --n 100 --out <path>',
    );
    process.exit(2);
  }

  await preflightHealth(args.base);
  const queries = await loadQueries(args.queries);

  console.log(`[recall-latency-eval] seeding ${args.corpus} synthetic facts into project=${FIXTURE_PROJECT} at ${args.base}...`);
  let seeded = 0;
  const seedFailures = [];
  try {
    for (let i = 0; i < args.corpus; i++) {
      try {
        await seedOne(args.base, i);
        seeded++;
        if ((i + 1) % 50 === 0 || i === args.corpus - 1) {
          console.log(`[recall-latency-eval] seeded ${i + 1}/${args.corpus}`);
        }
      } catch (err) {
        seedFailures.push(err.message);
        console.error(`[recall-latency-eval] seed ${i} FAILED (continuing): ${err.message}`);
      }
    }
    if (seeded === 0) {
      throw new Error('every seed write failed — refusing to measure against an empty corpus');
    }

    const samples = await runTimedSearches(args.base, queries, args.n, args.paceMs);
    const result = buildResult({
      mode: args.mode,
      base: args.base,
      n: args.n,
      queries,
      samples,
      corpusSize: seeded,
      hostLabel: args.hostLabel,
    });
    result.n_seed_requested = args.corpus;
    result.n_seed_succeeded = seeded;
    result.seed_failures = seedFailures;

    if (!args.out) {
      console.error('Usage: recall-latency-eval.mjs --mode seed-and-measure [--base http://127.0.0.1:6335] [--corpus 300] [--n 100] --out <path>');
      process.exit(2);
    }
    await writeJson(args.out, result);
    console.log(`[recall-latency-eval] result -> ${args.out}`);
    console.log(
      `[recall-latency-eval] n=${result.n_measured} corpusSize=${seeded} ` +
      `p50=${result.latency_ms.p50.toFixed(1)}ms p95=${result.latency_ms.p95.toFixed(1)}ms p99=${result.latency_ms.p99.toFixed(1)}ms`,
    );
  } finally {
    await cleanupQdrant();
    const after = await countMemories();
    console.log(`[recall-latency-eval] cleanup verification: memories collection count after delete = ${after}`);
  }
}

async function runMeasureOnly(args) {
  const health = await preflightHealth(args.base);
  const queries = await loadQueries(args.queries);

  // measure-only is READ-ONLY by construction: no seedOne / cleanupQdrant
  // call exists on this path. corpusSize is read from /health (never
  // computed via a write-adjacent count call) so this leg never touches
  // qdrant directly against a production instance.
  const corpusSize = health?.memories ?? health?.memoryCount ?? health?.count ?? null;

  const samples = await runTimedSearches(args.base, queries, args.n, args.paceMs);
  const result = buildResult({
    mode: args.mode,
    base: args.base,
    n: args.n,
    queries,
    samples,
    corpusSize,
    hostLabel: args.hostLabel,
  });

  if (!args.out) {
    console.error('Usage: recall-latency-eval.mjs --mode measure-only [--base http://127.0.0.1:6337] --host-label <label> [--queries <path>] [--n 100] --out <path>');
    process.exit(2);
  }
  await writeJson(args.out, result);
  console.log(`[recall-latency-eval] result -> ${args.out}`);
  console.log(
    `[recall-latency-eval] n=${result.n_measured} corpusSize=${corpusSize} ` +
    `p50=${result.latency_ms.p50.toFixed(1)}ms p95=${result.latency_ms.p95.toFixed(1)}ms p99=${result.latency_ms.p99.toFixed(1)}ms`,
  );
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (args.mode !== 'seed-and-measure' && args.mode !== 'measure-only') {
    console.error(`[recall-latency-eval] --mode must be 'seed-and-measure' or 'measure-only' (got ${JSON.stringify(args.mode)})`);
    process.exit(2);
  }
  if (!Number.isInteger(args.n) || args.n < 1) {
    console.error('[recall-latency-eval] --n must be a positive integer');
    process.exit(2);
  }

  if (args.mode === 'seed-and-measure') {
    if (!Number.isInteger(args.corpus) || args.corpus < 1) {
      console.error('[recall-latency-eval] --corpus must be a positive integer');
      process.exit(2);
    }
    await runSeedAndMeasure(args);
  } else {
    await runMeasureOnly(args);
  }
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  cliMain().catch((e) => {
    console.error('[recall-latency-eval] FATAL:', e);
    process.exit(1);
  });
}
