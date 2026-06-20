/**
 * compare-staleness-3way.mjs — 3-arm staleness: UM vs raw mem0 infer:false vs mem0 infer:TRUE.
 *
 * Closes the honest caveat from compare-staleness-um-mem0.mjs: that arm compared UM only to raw
 * mem0 with infer:false (literal store, NO currency). But mem0's OWN value-add is infer:TRUE — its
 * LLM extracts facts and issues ADD/UPDATE/DELETE against existing memories, i.e. mem0's native
 * currency path. Does that path match UM's supersession, or is UM only beating "mem0 with its brain
 * off"? This arm measures it — the comparison that decides whether "UM > mem0" is real.
 *
 * DETECTION. infer:true REPHRASES facts (mem0 stores LLM-extracted text, not verbatim), so exact
 * content-match breaks. Detection is VALUE-TOKEN presence: each row (staleness-set.jsonl) is
 * annotated with the distinctive stale_value / current_value entity that survives rephrasing
 * (Acme/Beta, PostgreSQL/MySQL, ...). A returned memory "surfaces the stale fact" iff its text
 * contains stale_value (case-insensitive substring).
 *
 * VALIDATION (why the infer:true number is trustworthy). The SAME token detector also runs on the
 * two VERBATIM arms (UM, mem0 infer:false), where we ALSO have exact-match truth. If token and
 * exact agree per-row on those arms (they must: stale_value is absent from the updated fact), the
 * detector is sound → the infer:true token number is credible. mem0:true's returned memories are
 * DUMPED per row for hand spot-check (a few rows use soft tokens: own/rent, black/milk, O-negative).
 *
 * ISOLATION + protocol identical to compare-staleness-um-mem0.mjs: per-row scratch collection
 * TRIPLES (eval_st3_*), dropped immediately; real `memories` untouched (before/after assert).
 * infer:true is LLM-driven → nondeterministic; run twice and report variance.
 *
 * Run: node --env-file=.env eval/compare-staleness-3way.mjs [--out <path>]   (from server/)
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

const EVAL_USER = 'um-stale3-eval';
const VECTOR_DIM = 1536;
const SCRATCH_PREFIX = 'eval_st3_';
const norm = (t) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const contains = (bodies, value) => { const v = norm(value); return v !== '' && bodies.some((b) => b.includes(v)); };

function assertScratchSafe(name) {
  if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX) || name === 'memories') {
    throw new Error(`staleness-3way: refusing non-scratch collection '${name}' — must start with '${SCRATCH_PREFIX}' and never be 'memories'`);
  }
}
function frac(rows, pred) { return rows.length ? +(rows.filter(pred).length / rows.length).toFixed(3) : null; }
function scoreArm(perRow) {
  return {
    n: perRow.length,
    staleReturn: frac(perRow, (r) => r.surfacedStale),
    currentReturn: frac(perRow, (r) => r.surfacedCurrent),
    onlyCurrent: frac(perRow, (r) => r.surfacedCurrent && !r.surfacedStale),
    bothReturned: frac(perRow, (r) => r.surfacedStale && r.surfacedCurrent),
    neither: frac(perRow, (r) => !r.surfacedStale && !r.surfacedCurrent),
  };
}
function parseOut(argv) { for (let i = 2; i < argv.length; i++) if (argv[i] === '--out') return argv[i + 1]; return null; }

async function main() {
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_TEMPORAL_DECAY = 'false';
  process.env.UM_DEDUP_ENABLED = 'true';
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'true';
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) { console.error('[staleness-3way] OPENAI_API_KEY not set — run: node --env-file=.env eval/compare-staleness-3way.mjs'); process.exit(2); }

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
  const umPerRow = []; const m0fPerRow = []; const m0tPerRow = [];
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const umCol = `${SCRATCH_PREFIX}um_${rid}_${i}`;
      const m0fCol = `${SCRATCH_PREFIX}m0f_${rid}_${i}`;
      const m0tCol = `${SCRATCH_PREFIX}m0t_${rid}_${i}`;

      // --- UM arm (full pipeline + real supersession) ---
      await ensure(umCol); created.add(umCol);
      const umMem = makeMem(umCol);
      const o = await umAdd({ memory: umMem, text: row.original_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client });
      const u = await umAdd({ memory: umMem, text: row.updated_fact, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client });
      const updatedEvent = u.results?.[0]?.event;
      let fired = false;
      if (updatedEvent === 'SUPERSEDED_INBAND') { fired = true; }
      else if (updatedEvent === 'ADD') {
        const detected = await detectContradictionsInBatch(row.updated_fact, { userId: EVAL_USER, lane: row.lane, collection: umCol, client, _facts: () => ({ facts: [row.updated_fact] }) });
        if (detected.length > 0) { fired = true; await supersedePoint({ client, collection: umCol, id: detected[0].targetId, supersededBy: detected[0].supersededBy }); }
      }
      const umBodies = (await doSearch(row.query, 10, false, true, { memory: umMem })).results?.map((r) => norm(r.body)) ?? [];
      umPerRow.push({ id: row.id, fired, updatedEvent,
        surfacedStale: contains(umBodies, row.stale_value), surfacedCurrent: contains(umBodies, row.current_value),
        exactStale: umBodies.includes(norm(row.original_fact)), exactCurrent: umBodies.includes(norm(row.updated_fact)) });
      await drop(umCol); created.delete(umCol);

      // --- mem0 arms (infer:false then infer:true) ---
      for (const [infer, col, sink] of [[false, m0fCol, m0fPerRow], [true, m0tCol, m0tPerRow]]) {
        await ensure(col); created.add(col);
        const m0 = makeMem(col);
        await m0.add(row.original_fact, { userId: EVAL_USER, infer });
        await m0.add(row.updated_fact, { userId: EVAL_USER, infer });
        const sr = await m0.search(row.query, { userId: EVAL_USER, limit: 10 });
        const arr = Array.isArray(sr) ? sr : (sr?.results ?? []);
        const rawBodies = arr.map((r) => r.memory ?? r.text ?? '');
        const bodies = rawBodies.map(norm);
        const rec = { id: row.id, surfacedStale: contains(bodies, row.stale_value), surfacedCurrent: contains(bodies, row.current_value) };
        if (!infer) { rec.exactStale = bodies.includes(norm(row.original_fact)); rec.exactCurrent = bodies.includes(norm(row.updated_fact)); }
        else { rec.memories = rawBodies; } // dump infer:true's rephrased store for hand spot-check
        sink.push(rec);
        await drop(col); created.delete(col);
      }

      console.log(`[staleness-3way] ${row.id} (${row.lane}): UM stale=${umPerRow[i].surfacedStale} | mem0:false stale=${m0fPerRow[i].surfacedStale} | mem0:true stale=${m0tPerRow[i].surfacedStale}cur=${m0tPerRow[i].surfacedCurrent}`);
    }
  } finally {
    for (const c of created) await drop(c);
  }
  const after = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  if (before != null && after !== before) throw new Error(`ISOLATION VIOLATION: memories ${before} -> ${after}`);

  // Validation: token detector must reproduce exact-match on the two VERBATIM arms.
  const tokenVsExact = (perRow) => perRow.filter((r) => r.surfacedStale !== r.exactStale || r.surfacedCurrent !== r.exactCurrent).map((r) => r.id);
  const validation = {
    umTokenVsExactMismatches: tokenVsExact(umPerRow),
    mem0FalseTokenVsExactMismatches: tokenVsExact(m0fPerRow),
    validated: tokenVsExact(umPerRow).length === 0 && tokenVsExact(m0fPerRow).length === 0,
  };

  const um = scoreArm(umPerRow); const mem0False = scoreArm(m0fPerRow); const mem0True = scoreArm(m0tPerRow);
  const provider = process.env.UM_EMBEDDING_PROVIDER ?? 'openai';
  const model = process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const result = {
    timestamp: new Date().toISOString(), n: rows.length,
    mode: 'staleness 3-way: UM vs mem0 infer:false vs mem0 infer:true; value-token detection (stale_value/current_value), validated vs exact-match on the verbatim arms',
    provider, model, evalUser: EVAL_USER,
    arms: { um, mem0False, mem0True },
    umFireRate: frac(umPerRow, (r) => r.fired),
    validation,
    perRow: { um: umPerRow, mem0False: m0fPerRow, mem0True: m0tPerRow },
    memoriesUntouched: before === after,
  };
  const outPath = parseOut(process.argv) ?? fileURLToPath(new URL('./results/2026-06-19-staleness-3way-run1.json', import.meta.url));
  const latestPath = fileURLToPath(new URL('./results/staleness-3way-latest.json', import.meta.url));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await writeFile(latestPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const p = (x) => (x == null ? ' n/a ' : x.toFixed(3));
  console.log(`\n=== UM vs mem0:false vs mem0:TRUE — STALENESS (n=${rows.length}, value-token detection) ===`);
  console.log('metric                       |   UM    | mem0:false | mem0:TRUE');
  console.log('-----------------------------+---------+------------+----------');
  console.log(`stale-return (lower=better)  | ${p(um.staleReturn).padEnd(7)} | ${p(mem0False.staleReturn).padEnd(10)} | ${p(mem0True.staleReturn)}`);
  console.log(`current-return (want ~1.0)   | ${p(um.currentReturn).padEnd(7)} | ${p(mem0False.currentReturn).padEnd(10)} | ${p(mem0True.currentReturn)}`);
  console.log(`only-current (IDEAL)         | ${p(um.onlyCurrent).padEnd(7)} | ${p(mem0False.onlyCurrent).padEnd(10)} | ${p(mem0True.onlyCurrent)}`);
  console.log(`both-returned (ambiguous)    | ${p(um.bothReturned).padEnd(7)} | ${p(mem0False.bothReturned).padEnd(10)} | ${p(mem0True.bothReturned)}`);
  console.log(`neither (lost both)          | ${p(um.neither).padEnd(7)} | ${p(mem0False.neither).padEnd(10)} | ${p(mem0True.neither)}`);
  console.log(`\nUM supersession fire-rate: ${p(result.umFireRate)} | token-detector validated vs exact-match: ${validation.validated}` + (validation.validated ? '' : ` (mismatches UM:[${validation.umTokenVsExactMismatches}] mem0:false:[${validation.mem0FalseTokenVsExactMismatches}])`));
  console.log(`memories collection untouched: ${before === after}`);
  console.log(`result -> ${outPath}`);
}

main().catch((e) => { console.error('[staleness-3way] FATAL:', e); process.exit(1); });
