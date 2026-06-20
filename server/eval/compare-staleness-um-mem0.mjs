/**
 * server/eval/compare-staleness-um-mem0.mjs — head-to-head STALENESS: UM pipeline vs RAW mem0.
 *
 * The recall head-to-head (compare-um-mem0.mjs) found UM ≡ mem0 on distinct-fact recall — they
 * share the retrieval core (mem0 + qdrant + OpenAI embeddings), so UM's pipeline adds ZERO recall
 * delta. UM's actual edge is CURRENCY: when a fact is updated by a contradiction, does the system
 * STOP returning the stale original? This arm measures exactly that — the contrast the recall test
 * cannot show. (The recall benchmark scoped currency out, spec §4; the user re-scoped it in as the
 * next arm — it is where UM is designed to win.)
 *
 * Per row (staleness-set.jsonl: 18 same-lane entity-swap contradictions + neutral queries):
 *   seed original_fact → seed updated_fact (the contradiction) → query neutrally → check whether the
 *   STALE original still surfaces in the top-10 (bad) vs only the current updated fact (good).
 *
 *   UM arm   : umAdd(orig) → umAdd(updated). Supersession can fire by EITHER production path —
 *              in-band at write time (event SUPERSEDED_INBAND) OR the session-end detector
 *              (detectContradictionsInBatch → supersedePoint) for entity-swaps below the in-band
 *              cosine band. Then doSearch (which filters superseded points). Faithful to prod: the
 *              SAME functions the mq-eval staleness pass injects — decisions are never re-implemented.
 *   mem0 arm : Memory.add(orig, infer:false) → Memory.add(updated, infer:false) → Memory.search.
 *              No currency layer → both facts persist → expect the stale original returned (≈1.0).
 *
 * Detection is exact NORMALIZED content-match (both arms store verbatim under infer:false → fair,
 * deterministic, no LLM judge — the same basis as compare-um-mem0.mjs). Per-row ISOLATION: a fresh
 * scratch collection PAIR per row (same-lane contradictions would otherwise cross-contaminate),
 * dropped immediately after. Fail-loud scratch-name guard + a `memories` point-count before/after
 * assert keep the real vault untouched.
 *
 * Run: node --env-file=.env eval/compare-staleness-um-mem0.mjs [--out <path>]   (from server/)
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

const EVAL_USER = 'um-stale-cmp-eval';
const VECTOR_DIM = 1536;                  // text-embedding-3-small
const SCRATCH_PREFIX = 'eval_stale_';     // every scratch collection MUST start with this
const norm = (t) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Refuse any collection that is not an `eval_stale_` scratch collection — and never `memories`. */
function assertScratchSafe(name) {
  if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX) || name === 'memories') {
    throw new Error(`staleness-compare: refusing non-scratch collection '${name}' — must start with '${SCRATCH_PREFIX}' and never be 'memories'`);
  }
}

/** Rate of a predicate over per-row records, rounded; null when there are no rows. */
function frac(rows, pred) {
  if (!rows.length) return null;
  return +(rows.filter(pred).length / rows.length).toFixed(3);
}

/** Stale/current presence rates shared by both arms (the head-to-head core). */
function scoreArm(perRow) {
  return {
    n: perRow.length,
    staleReturn: frac(perRow, (r) => r.surfacedOriginal),                          // BAD when high
    currentReturn: frac(perRow, (r) => r.surfacedUpdated),                         // want ≈1.0
    onlyCurrent: frac(perRow, (r) => r.surfacedUpdated && !r.surfacedOriginal),    // IDEAL
    bothReturned: frac(perRow, (r) => r.surfacedOriginal && r.surfacedUpdated),    // ambiguity failure
    neither: frac(perRow, (r) => !r.surfacedOriginal && !r.surfacedUpdated),       // lost both (edge)
  };
}

function parseOut(argv) {
  for (let i = 2; i < argv.length; i++) if (argv[i] === '--out') return argv[i + 1];
  return null;
}

async function main() {
  // Pin MEM0_USER_ID + flags BEFORE importing mem0-mcp-http (USER_ID captured at import time).
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_TEMPORAL_DECAY = 'false';
  process.env.UM_DEDUP_ENABLED = 'true';
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'true';
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) { console.error('[staleness-compare] OPENAI_API_KEY not set — run: node --env-file=.env eval/compare-staleness-um-mem0.mjs'); process.exit(2); }

  const { Memory } = await import('mem0ai/oss');
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const { umAdd } = await import('../lib/add.mjs');
  const { doSearch } = await import('../mem0-mcp-http.mjs');
  const { detectContradictionsInBatch } = await import('../lib/contradiction-batch.mjs');
  const { supersedePoint } = await import('../lib/supersede.mjs');
  const { getEmbedderConfig } = await import('../lib/embed.mjs');
  const { getFactsLlmConfig } = await import('../lib/facts.mjs');

  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  const client = new QdrantClient({ host, port });
  const rid = `${process.pid}`;

  const makeMem = (collectionName) => new Memory({
    embedder: getEmbedderConfig(process.env),
    llm: getFactsLlmConfig(process.env),
    vectorStore: { provider: 'qdrant', config: { host, port, collectionName } },
  });
  const ensure = async (c) => { assertScratchSafe(c); try { await client.deleteCollection(c); } catch (e) { if (e?.status !== 404) throw e; } await client.createCollection(c, { vectors: { size: VECTOR_DIM, distance: 'Cosine' } }); };
  const drop = async (c) => { assertScratchSafe(c); try { await client.deleteCollection(c); } catch { /* ignore */ } };

  const fixturePath = fileURLToPath(new URL('./staleness-set.jsonl', import.meta.url));
  const rows = await loadFixtureJsonl(fixturePath);

  const before = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  const created = new Set();
  const umPerRow = [];
  const mem0PerRow = [];
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const umCol = `${SCRATCH_PREFIX}um_${rid}_${i}`;
      const mem0Col = `${SCRATCH_PREFIX}mem0_${rid}_${i}`;

      // --- UM arm: full pipeline, real supersession (in-band OR session-end detector) ---
      await ensure(umCol); created.add(umCol);
      const umMem = makeMem(umCol);
      const o = await umAdd({ memory: umMem, text: row.original_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client });
      const u = await umAdd({ memory: umMem, text: row.updated_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client });
      const updatedEvent = u.results?.[0]?.event; // ADD | SUPERSEDED_INBAND | DEDUP_MERGED
      let fired = false; let firedPath = null;
      if (updatedEvent === 'SUPERSEDED_INBAND') {
        fired = true; firedPath = 'inband';
      } else if (updatedEvent === 'ADD') {
        const detected = await detectContradictionsInBatch(row.updated_fact, {
          userId: EVAL_USER, lane: row.lane, collection: umCol, client,
          _facts: () => ({ facts: [row.updated_fact] }),
        });
        if (detected.length > 0) {
          fired = true; firedPath = 'detector';
          await supersedePoint({ client, collection: umCol, id: detected[0].targetId, supersededBy: detected[0].supersededBy });
        }
      } // DEDUP_MERGED → the update was merged away (a supersession-recall miss) → fired stays false

      const umSr = await doSearch(row.query, 10, false, true, { memory: umMem });
      const umBodies = (umSr.results ?? []).map((r) => norm(r.body));
      umPerRow.push({
        id: row.id, lane: row.lane, updatedEvent, fired, firedPath,
        surfacedOriginal: umBodies.includes(norm(row.original_fact)),
        surfacedUpdated: umBodies.includes(norm(row.updated_fact)),
        originalRank: umBodies.indexOf(norm(row.original_fact)) + 1,   // 0 = absent
        updatedRank: umBodies.indexOf(norm(row.updated_fact)) + 1,
      });
      await drop(umCol); created.delete(umCol);

      // --- raw mem0 arm: native add/search, infer:false, NO currency layer ---
      await ensure(mem0Col); created.add(mem0Col);
      const m0 = makeMem(mem0Col);
      await m0.add(row.original_fact, { userId: EVAL_USER, infer: false });
      await m0.add(row.updated_fact, { userId: EVAL_USER, infer: false });
      const m0Sr = await m0.search(row.query, { userId: EVAL_USER, limit: 10 });
      const m0Arr = Array.isArray(m0Sr) ? m0Sr : (m0Sr?.results ?? []);
      const m0Bodies = m0Arr.map((r) => norm(r.memory ?? r.text ?? ''));
      mem0PerRow.push({
        id: row.id, lane: row.lane,
        surfacedOriginal: m0Bodies.includes(norm(row.original_fact)),
        surfacedUpdated: m0Bodies.includes(norm(row.updated_fact)),
        originalRank: m0Bodies.indexOf(norm(row.original_fact)) + 1,
        updatedRank: m0Bodies.indexOf(norm(row.updated_fact)) + 1,
      });
      await drop(mem0Col); created.delete(mem0Col);

      console.log(`[staleness-compare] ${row.id} (${row.lane}): UM ${fired ? `superseded(${firedPath})` : `NOT-fired(${updatedEvent})`} stale=${umPerRow[i].surfacedOriginal} | mem0 stale=${mem0PerRow[i].surfacedOriginal}`);
    }
  } finally {
    for (const c of created) await drop(c); // sweep any collection left by a mid-row throw
  }
  const after = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  if (before != null && after !== before) throw new Error(`ISOLATION VIOLATION: memories ${before} -> ${after}`);

  const um = scoreArm(umPerRow);
  const mem0 = scoreArm(mem0PerRow);
  const firedRows = umPerRow.filter((r) => r.fired);
  const umSupersession = {
    total: umPerRow.length,
    fired: firedRows.length,
    fireRate: frac(umPerRow, (r) => r.fired),
    staleReturnOverFired: frac(firedRows, (r) => r.surfacedOriginal), // reconciles with mq baseline (0.0)
    notFired: umPerRow.filter((r) => !r.fired).map((r) => ({ id: r.id, event: r.updatedEvent })),
  };

  const provider = process.env.UM_EMBEDDING_PROVIDER ?? 'openai';
  const model = process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const result = {
    timestamp: new Date().toISOString(),
    n: rows.length,
    mode: 'staleness head-to-head: seed original → contradicting update → neutral query → stale-return (exact content-match, infer:false)',
    provider, model, evalUser: EVAL_USER,
    flags: { UM_DEDUP_ENABLED: 'true', UM_AUTOSUPERSEDE_ENABLED: 'true', UM_LANE_CLASSIFIER_ENABLED: 'true', UM_TEMPORAL_DECAY: 'false' },
    env: { node: process.version, platform: process.platform },
    arms: { um, mem0 },
    umSupersession,
    perRow: { um: umPerRow, mem0: mem0PerRow },
    memoriesUntouched: before === after,
  };
  const outPath = parseOut(process.argv) ?? fileURLToPath(new URL('./results/2026-06-19-staleness-compare-run1.json', import.meta.url));
  const latestPath = fileURLToPath(new URL('./results/staleness-compare-latest.json', import.meta.url));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await mkdir(dirname(latestPath), { recursive: true });
  await writeFile(latestPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const pct = (x) => (x == null ? ' n/a ' : x.toFixed(3));
  console.log(`\n=== UM vs raw mem0 — STALENESS (n=${rows.length}, seed orig → contradiction → neutral query; exact content-match, infer:false) ===`);
  console.log('metric                        |   UM    |  mem0');
  console.log('------------------------------+---------+--------');
  console.log(`stale-return  (lower=better)  | ${pct(um.staleReturn).padEnd(7)} | ${pct(mem0.staleReturn)}`);
  console.log(`current-return (want ≈1.0)    | ${pct(um.currentReturn).padEnd(7)} | ${pct(mem0.currentReturn)}`);
  console.log(`only-current  (IDEAL)         | ${pct(um.onlyCurrent).padEnd(7)} | ${pct(mem0.onlyCurrent)}`);
  console.log(`both-returned (ambiguous)     | ${pct(um.bothReturned).padEnd(7)} | ${pct(mem0.bothReturned)}`);
  console.log(`neither       (lost both)     | ${pct(um.neither).padEnd(7)} | ${pct(mem0.neither)}`);
  console.log('------------------------------+---------+--------');
  console.log(`supersession fire-rate        | ${pct(umSupersession.fireRate).padEnd(7)} |  n/a`);
  console.log(`stale-return over fired rows  | ${pct(umSupersession.staleReturnOverFired).padEnd(7)} |  n/a`);
  console.log(`\nUM supersession: ${umSupersession.fired}/${umSupersession.total} fired` + (umSupersession.notFired.length ? `; not-fired: ${umSupersession.notFired.map((x) => `${x.id}(${x.event})`).join(', ')}` : ''));
  console.log(`memories collection untouched: ${before === after}`);
  console.log(`result -> ${outPath}`);
}

main().catch((e) => { console.error('[staleness-compare] FATAL:', e); process.exit(1); });
