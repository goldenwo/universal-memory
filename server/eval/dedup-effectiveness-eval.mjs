/**
 * server/eval/dedup-effectiveness-eval.mjs — README-benchmarks Task B3: dedup-effectiveness eval.
 *
 * Sibling of checkpoint-cost-eval.mjs: PURE aggregation (computeDedupReport) exported
 * + unit-tested offline in test/dedup-effectiveness-eval.test.mjs; the CLI shim (arg
 * parsing, live HTTP calls against a running mem0-mcp-http server, qdrant count/delete
 * cleanup) is guarded by IS_MAIN so importing this module for its pure export never
 * opens a socket.
 *
 * Purpose: measure UM's dedup layer for a README figure —
 *   (a) merge rate on true duplicates (kind: exact, paraphrase)
 *   (b) false-merge count on distinct controls (kind: control)
 *   (c) store growth on a full re-write of every original text (must be 0 — the
 *       Layer-1 hash-dedup idempotency invariant)
 *
 * FIXTURE: eval/fixtures/dedup-set.jsonl, 50 rows {id, text, variant_text, kind}.
 * kind=exact: variant_text === text (exercises Layer-1 md5-hash dedup, lib/dedup.mjs
 *   checkContentHashDedup). kind=paraphrase: variant_text is a light reword of the
 *   same durable fact (same entity + predicate + value) — designed to land ABOVE the
 *   live UM_DEDUP_EMBEDDING_THRESHOLD default of 0.84 (server/lib/add.mjs
 *   dedupEmbeddingThreshold(), server/.env.example) so Layer-2 embedding dedup
 *   (checkEmbeddingDedup) catches it. kind=control: variant_text is a topically
 *   DIFFERENT durable fact (different entity, different predicate) that must stay
 *   BELOW threshold and NOT merge. Every row uses a unique codename-ish entity so
 *   cross-row merging cannot happen.
 *
 * VERBATIM-PATH FINDING (checked in server/mem0-mcp-http.mjs's /api/add handler):
 * the REST /api/add endpoint hardcodes `infer: true` — there is no request-level
 * flag to force the infer:false (verbatim-embed) path over HTTP. Every write here
 * therefore goes through umAdd's facts() LLM extraction before embedding. To keep
 * that extraction step from injecting its own variance into a DEDUP measurement,
 * every fixture text is a single, highly extraction-stable declarative sentence
 * ("The database used by <entity> is <value>.") — designed so facts() extracts
 * exactly one fact per write. A row whose write does not yield exactly one result
 * is treated as a per-row FAILURE (logged, counted, excluded from the report) rather
 * than silently guessed at — see runRow() below.
 *
 * MERGE-DETECTION SIGNAL: mirrors server/test/smoke.sh's D1 S2 probe — a dedup-merge
 * response carries `results[].event === 'DEDUP_MERGED'` (server/lib/dedup.mjs
 * mergeSurface's return shape) and reuses the EXISTING point's id (server/lib/add.mjs
 * umAdd: `mergeSurface` returns `{id: existingPoint.id, ...}` verbatim — no new id is
 * minted). A plain upsert instead carries `event === 'ADD'` with the deterministic
 * uuidv5(hash, userId) id (dedup-eligible writes) computed fresh per item. This eval
 * treats `event === 'DEDUP_MERGED'` as the primary merge signal and cross-checks it
 * against id-stability (originalId === variantId) for every row.
 *
 * All writes use metadata.project = FIXTURE_PROJECT ('bench-dedup-effectiveness') so
 * cleanup (qdrant delete by project filter, mirroring checkpoint-cost-eval.mjs /
 * compare-*.mjs conventions) is scoped and cannot sweep any other project's data.
 *
 * SAFETY GUARD: refuses to run if the `memories` collection already holds more than
 * MAX_COLLECTION_POINTS points — this rig is meant for a scratch dev qdrant, but the
 * guard defends against accidentally pointing --base/QDRANT_HOST at a populated store.
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const FIXTURE_PROJECT = 'bench-dedup-effectiveness';
const DEFAULT_BASE = 'http://127.0.0.1:6335';
const DEFAULT_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dedup-set.jsonl');
const MAX_COLLECTION_POINTS = 100;
const VALID_KINDS = new Set(['exact', 'paraphrase', 'control']);

// ---------------------------------------------------------------------------
// PURE aggregation (no I/O) — unit-tested directly in
// test/dedup-effectiveness-eval.test.mjs.
// ---------------------------------------------------------------------------

/**
 * Aggregate an array of per-row dedup outcomes into the reported summary shape.
 *
 * FAIL-LOUD (per feedback_test_integrity / house convention): an empty array, or
 * any row with a `kind` outside {exact, paraphrase, control}, throws immediately —
 * a silently-dropped or misclassified row would understate/inflate the reported
 * merge rate rather than surfacing the gap.
 *
 * duplicateMergeRate spans exact+paraphrase together (both are true-duplicate
 * kinds by construction); falseMergeRate is control-only. Rates for a kind with
 * zero rows report 0 (not NaN/undefined) so the JSON shape is stable regardless
 * of which kinds are present in a given run.
 *
 * @param {Array<{id:string, kind:'exact'|'paraphrase'|'control', mergedOnVariant:boolean, idStable:boolean}>} rows
 * @returns {{n:number, byKind:{exact:{n:number,mergeRate:number}, paraphrase:{n:number,mergeRate:number}, control:{n:number,falseMerges:number}}, overall:{duplicateMergeRate:number, falseMergeRate:number}}}
 */
export function computeDedupReport(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('computeDedupReport: rows must be a non-empty array (empty sample has no report)');
  }
  const byKindRows = { exact: [], paraphrase: [], control: [] };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!VALID_KINDS.has(r?.kind)) {
      throw new Error(`computeDedupReport: row[${i}] has unrecognized kind (got ${JSON.stringify(r?.kind)}; expected one of exact/paraphrase/control)`);
    }
    if (typeof r.mergedOnVariant !== 'boolean') {
      throw new Error(`computeDedupReport: row[${i}] (kind=${r.kind}) missing/invalid mergedOnVariant (got ${JSON.stringify(r.mergedOnVariant)})`);
    }
    byKindRows[r.kind].push(r);
  }

  const mergeRate = (list) => (list.length === 0 ? 0 : list.filter((r) => r.mergedOnVariant).length / list.length);
  const falseMerges = (list) => list.filter((r) => r.mergedOnVariant).length;

  const exactMerged = byKindRows.exact.filter((r) => r.mergedOnVariant).length;
  const paraphraseMerged = byKindRows.paraphrase.filter((r) => r.mergedOnVariant).length;
  const duplicateN = byKindRows.exact.length + byKindRows.paraphrase.length;

  return {
    n: rows.length,
    byKind: {
      exact: { n: byKindRows.exact.length, mergeRate: mergeRate(byKindRows.exact) },
      paraphrase: { n: byKindRows.paraphrase.length, mergeRate: mergeRate(byKindRows.paraphrase) },
      control: { n: byKindRows.control.length, falseMerges: falseMerges(byKindRows.control) },
    },
    overall: {
      duplicateMergeRate: duplicateN === 0 ? 0 : (exactMerged + paraphraseMerged) / duplicateN,
      falseMergeRate: byKindRows.control.length === 0 ? 0 : falseMerges(byKindRows.control) / byKindRows.control.length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI shim — live HTTP calls + qdrant guard/cleanup. Guarded by IS_MAIN so
// importing this module for computeDedupReport never opens a socket.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { base: DEFAULT_BASE, fixture: DEFAULT_FIXTURE, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--fixture') args.fixture = argv[++i];
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

async function loadFixture(path) {
  const raw = await readFile(path, 'utf8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows = lines.map((l, i) => {
    let parsed;
    try { parsed = JSON.parse(l); } catch (err) {
      throw new Error(`loadFixture: line ${i + 1} is not valid JSON: ${err.message}`);
    }
    if (!parsed.id || typeof parsed.text !== 'string' || typeof parsed.variant_text !== 'string' || !VALID_KINDS.has(parsed.kind)) {
      throw new Error(`loadFixture: line ${i + 1} missing required fields or invalid kind (got ${JSON.stringify(parsed)})`);
    }
    return parsed;
  });
  if (rows.length === 0) throw new Error(`loadFixture: ${path} contained no rows`);
  return rows;
}

async function preflightHealth(base) {
  let res;
  try {
    res = await fetch(`${base}/health`);
  } catch (err) {
    console.error(`[dedup-effectiveness-eval] server unreachable at ${base}/health: ${err.message}`);
    console.error(`[dedup-effectiveness-eval] start it first: node --env-file=.env mem0-mcp-http.mjs`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`[dedup-effectiveness-eval] ${base}/health returned HTTP ${res.status} — server is not healthy`);
    process.exit(2);
  }
}

/** Guard: refuse to run against a populated collection. This rig targets a scratch dev qdrant. */
async function preflightScratchGuard() {
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = Number.parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  const client = new QdrantClient({ host, port });
  const count = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  if (count === null) return { client, count: 0 }; // collection doesn't exist yet — nothing to guard against
  if (count > MAX_COLLECTION_POINTS) {
    console.error(
      `[dedup-effectiveness-eval] REFUSING TO RUN: 'memories' collection already holds ${count} points ` +
      `(> ${MAX_COLLECTION_POINTS}). This eval targets a scratch dev qdrant — point QDRANT_HOST/QDRANT_PORT ` +
      `at an empty instance, or clear it, before running.`,
    );
    process.exit(2);
  }
  return { client, count };
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

/** POST one text through /api/add; require exactly one extracted-fact result (see VERBATIM-PATH FINDING above). */
async function addOne(base, text) {
  const r = await postJson(base, '/api/add', { text, metadata: { project: FIXTURE_PROJECT }, surface: 'eval-dedup' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.json)}`);
  const results = r.json?.results;
  if (!Array.isArray(results) || results.length !== 1) {
    throw new Error(`expected exactly 1 extracted fact, got ${Array.isArray(results) ? results.length : 'non-array'} (${JSON.stringify(r.json)})`);
  }
  return results[0]; // { id, memory, event }
}

/** Run one fixture row: write text, then variant_text; determine merge + id-stability. Returns the row outcome + every id it created (for cleanup accounting). */
async function runRow(base, row) {
  const original = await addOne(base, row.text);
  const variant = await addOne(base, row.variant_text);
  const mergedOnVariant = variant.event === 'DEDUP_MERGED';
  const idStable = original.id === variant.id;
  return {
    outcome: { id: row.id, kind: row.kind, mergedOnVariant, idStable },
    detail: { id: row.id, kind: row.kind, originalId: original.id, originalEvent: original.event, variantId: variant.id, variantEvent: variant.event, mergedOnVariant, idStable },
    createdIds: [original.id, variant.id],
  };
}

/** Full re-write pass: re-POST every original text once. Every write is now a hash-dedup hit on an existing point, so no new points should be created. */
async function rewriteOriginals(base, rows) {
  for (const row of rows) {
    await addOne(base, row.text);
  }
}

async function countMemories(client) {
  return client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
}

/** Delete every point this eval wrote, scoped to FIXTURE_PROJECT — mirrors checkpoint-cost-eval.mjs / compare-*.mjs cleanup convention. Best-effort. */
async function cleanupQdrant(client) {
  try {
    await client.delete('memories', {
      wait: true,
      filter: { must: [{ key: 'project', match: { value: FIXTURE_PROJECT } }] },
    });
    console.log(`[dedup-effectiveness-eval] cleanup: deleted qdrant points for project=${FIXTURE_PROJECT}`);
  } catch (err) {
    console.error(`[dedup-effectiveness-eval] cleanup: qdrant delete failed (non-fatal): ${err.message}`);
  }
}

async function writeJson(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (!args.out) {
    console.error('Usage: dedup-effectiveness-eval.mjs [--base http://127.0.0.1:6335] [--fixture <path>] --out <path>');
    process.exit(2);
  }

  // Preflight: writes go through umAdd's facts()+embed() pipeline, which needs
  // an API key. --env-file=.env is the documented invocation; also try loading
  // ./.env directly in case the caller forgot the flag (mirrors checkpoint-cost-eval).
  if (!process.env.OPENAI_API_KEY) {
    try { process.loadEnvFile?.(); } catch { /* no ./.env — fall through */ }
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      '[dedup-effectiveness-eval] OPENAI_API_KEY not set — /api/add calls the live LLM (facts extraction) + embedding provider.\n' +
      '  run: node --env-file=.env eval/dedup-effectiveness-eval.mjs --out eval/results/<date>-dedup-effectiveness.json',
    );
    process.exit(2);
  }

  await preflightHealth(args.base);
  const { client, count: preCount } = await preflightScratchGuard();

  const rows = await loadFixture(args.fixture);
  console.log(`[dedup-effectiveness-eval] running ${rows.length} rows against ${args.base} (fixture=${args.fixture}, project=${FIXTURE_PROJECT})...`);

  const outcomes = [];
  const details = [];
  const createdIds = [];
  let failures = 0;
  const failureMessages = [];

  try {
    for (const row of rows) {
      try {
        const { outcome, detail, createdIds: ids } = await runRow(args.base, row);
        outcomes.push(outcome);
        details.push(detail);
        createdIds.push(...ids);
        console.log(`[dedup-effectiveness-eval] ${row.id} (${row.kind}): merged=${outcome.mergedOnVariant} idStable=${outcome.idStable}`);
      } catch (err) {
        failures++;
        failureMessages.push(`${row.id} (${row.kind}): ${err.message}`);
        console.error(`[dedup-effectiveness-eval] row ${row.id} (${row.kind}) FAILED (continuing): ${err.message}`);
      }
    }

    if (outcomes.length === 0) {
      console.error('[dedup-effectiveness-eval] every row failed — refusing to emit a report.\n' + failureMessages.map((m) => `  - ${m}`).join('\n'));
      process.exit(1);
    }

    const afterWritesCount = await countMemories(client);

    // Full re-write: re-assert every ORIGINAL text once. Every one of these is
    // an exact hash-dedup hit on an already-existing point (D1 Layer 1), so no
    // new qdrant points should be created — the idempotency invariant this
    // step exists to check. Only re-writes rows whose first write succeeded
    // (a failed row never created an "original" id to re-assert against).
    const succeededRowIds = new Set(outcomes.map((o) => o.id));
    await rewriteOriginals(args.base, rows.filter((r) => succeededRowIds.has(r.id)));

    const afterRewriteCount = await countMemories(client);
    const storeGrowthOnRewrite = (afterWritesCount === null || afterRewriteCount === null)
      ? null
      : afterRewriteCount - afterWritesCount;

    const report = computeDedupReport(outcomes);

    const result = {
      timestamp: new Date().toISOString(),
      protocol: 'per-row: POST text, then POST variant_text via live /api/add (infer:true — see VERBATIM-PATH FINDING); merge detected via results[].event===DEDUP_MERGED + id-stability; final full-rewrite pass of every original text asserts store growth == 0 (Layer-1 hash-dedup idempotency)',
      n_requested: rows.length,
      n_succeeded: outcomes.length,
      n_failed: failures,
      failures: failureMessages,
      report,
      rows: details,
      storeGrowthOnRewrite,
      storeGrowthOk: storeGrowthOnRewrite === 0,
      environment: {
        node: process.version,
        um_dedup_enabled: process.env.UM_DEDUP_ENABLED ?? 'true (default)',
        um_dedup_embedding_threshold: process.env.UM_DEDUP_EMBEDDING_THRESHOLD ?? '0.84 (default)',
        um_autosupersede_enabled: process.env.UM_AUTOSUPERSEDE_ENABLED ?? 'true (default)',
        um_facts_model: process.env.UM_FACTS_MODEL ?? null,
        um_provider: process.env.UM_PROVIDER ?? process.env.UM_EMBEDDING_PROVIDER ?? 'openai',
        date: new Date().toISOString().slice(0, 10),
      },
    };

    await writeJson(args.out, result);
    console.log(`[dedup-effectiveness-eval] result -> ${args.out}`);
    console.log(
      `[dedup-effectiveness-eval] exact mergeRate=${report.byKind.exact.mergeRate} ` +
      `paraphrase mergeRate=${report.byKind.paraphrase.mergeRate} ` +
      `control falseMerges=${report.byKind.control.falseMerges} ` +
      `storeGrowthOnRewrite=${storeGrowthOnRewrite} (failures=${failures})`,
    );

    if (!result.storeGrowthOk) {
      console.error(`[dedup-effectiveness-eval] FAIL: store growth on full re-write was ${storeGrowthOnRewrite}, expected 0 (Layer-1 hash-dedup idempotency invariant violated)`);
      process.exitCode = 1;
    }
    if (report.overall.falseMergeRate > 0) {
      console.error(`[dedup-effectiveness-eval] WARNING: control false-merge rate is ${report.overall.falseMergeRate} (expected 0) — see rows[] with kind=control, mergedOnVariant=true for detail`);
    }
  } finally {
    await cleanupQdrant(client);
  }
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  cliMain().catch((e) => {
    console.error('[dedup-effectiveness-eval] FATAL:', e);
    process.exit(1);
  });
}
