/**
 * compare-session-recall.mjs — UM vs raw mem0 on SESSION-shaped recall (claude-mem's home turf).
 *
 * The fact-recall arm (compare-um-mem0.mjs) used atomic one-line facts. This arm uses realistic
 * multi-fact SESSION SUMMARIES (session-recall-set.jsonl) — the shape claude-mem produces — and a
 * de-leaked oblique query that asks about ONE fact buried in a summary. It extends the UM-vs-mem0
 * comparison to session-grain content, so the benchmark covers both turfs (fact + session).
 *
 * METRIC — content-contains recall@k. Each row's `answer` is a DISTINCTIVE VERBATIM span of exactly
 * one summary (validated offline), so "a retrieved summary contains the answer (case-insensitive)"
 * is true iff the target summary was retrieved — deterministic, no LLM judge needed. Report
 * recall@1/3/5/10 + MRR per arm. Both arms seed infer:false (verbatim → isolates RETRIEVAL).
 *
 * Isolation: one scratch collection per arm (eval_sr_*), dropped in finally; real `memories`
 * untouched (before/after assert). Run twice for stability.
 *
 * Run: node --env-file=.env eval/compare-session-recall.mjs [--out <path>]   (from server/)
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

const EVAL_USER = 'um-sr-eval';
const VECTOR_DIM = 1536;
const SCRATCH_PREFIX = 'eval_sr_';
const KS = [1, 3, 5, 10];
const norm = (t) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function assertScratchSafe(name) {
  if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX) || name === 'memories') {
    throw new Error(`session-recall: refusing non-scratch collection '${name}' — must start with '${SCRATCH_PREFIX}' and never be 'memories'`);
  }
}

/** content-contains recall@k + MRR: rank of the first retrieved body containing the answer span. */
function score(perQuery) {
  const agg = {}; for (const k of KS) agg[k] = 0;
  const rrs = [];
  for (const q of perQuery) {
    let rank = 0;
    for (let i = 0; i < q.bodies.length; i++) { if (q.bodies[i].includes(q.answerNorm)) { rank = i + 1; break; } }
    for (const k of KS) if (rank > 0 && rank <= k) agg[k]++;
    rrs.push(rank > 0 ? 1 / rank : 0);
  }
  const n = perQuery.length || 1;
  const out = {};
  for (const k of KS) out[k] = +(agg[k] / n).toFixed(3);
  out.mrr = +(rrs.reduce((a, b) => a + b, 0) / n).toFixed(3);
  out.misses = perQuery.filter((q) => !q.bodies.some((b) => b.includes(q.answerNorm))).map((q) => q.id);
  return out;
}
function parseOut(argv) { for (let i = 2; i < argv.length; i++) if (argv[i] === '--out') return argv[i + 1]; return null; }

async function main() {
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_TEMPORAL_DECAY = 'false';
  process.env.UM_DEDUP_ENABLED = 'true';
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'true';
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) { console.error('[session-recall] OPENAI_API_KEY not set — run: node --env-file=.env eval/compare-session-recall.mjs'); process.exit(2); }

  const { Memory } = await import('mem0ai/oss');
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const { umAdd } = await import('../lib/add.mjs');
  const { doSearch } = await import('../mem0-mcp-http.mjs');
  const { getEmbedderConfig } = await import('../lib/embed.mjs');
  const { getFactsLlmConfig } = await import('../lib/facts.mjs');

  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  const client = new QdrantClient({ host, port });
  const rid = `${process.pid}`;
  const umCol = `${SCRATCH_PREFIX}um_${rid}`;
  const mem0Col = `${SCRATCH_PREFIX}mem0_${rid}`;
  const makeMem = (collectionName) => new Memory({
    embedder: getEmbedderConfig(process.env),
    llm: getFactsLlmConfig(process.env),
    vectorStore: { provider: 'qdrant', config: { host, port, collectionName } },
  });
  const ensure = async (c) => { assertScratchSafe(c); try { await client.deleteCollection(c); } catch (e) { if (e?.status !== 404) throw e; } await client.createCollection(c, { vectors: { size: VECTOR_DIM, distance: 'Cosine' } }); };
  const drop = async (c) => { assertScratchSafe(c); try { await client.deleteCollection(c); } catch { /* ignore */ } };

  const fixturePath = fileURLToPath(new URL('./session-recall-set.jsonl', import.meta.url));
  const rows = await loadFixtureJsonl(fixturePath);

  const before = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  let um, mem0;
  try {
    // --- UM arm ---
    await ensure(umCol);
    const umMem = makeMem(umCol);
    for (const r of rows) await umAdd({ memory: umMem, text: r.session_summary, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: r.lane }, _qdrantClient: client });
    const umPer = [];
    for (const r of rows) {
      const sr = await doSearch(r.query, 10, false, true, { memory: umMem });
      umPer.push({ id: r.id, answerNorm: norm(r.answer), bodies: (sr.results ?? []).map((x) => norm(x.body)) });
    }
    um = score(umPer);

    // --- raw mem0 arm (infer:false) ---
    await ensure(mem0Col);
    const m0 = makeMem(mem0Col);
    for (const r of rows) await m0.add(r.session_summary, { userId: EVAL_USER, infer: false });
    const m0Per = [];
    for (const r of rows) {
      const sr = await m0.search(r.query, { userId: EVAL_USER, limit: 10 });
      const arr = Array.isArray(sr) ? sr : (sr?.results ?? []);
      m0Per.push({ id: r.id, answerNorm: norm(r.answer), bodies: arr.map((x) => norm(x.memory ?? x.text ?? '')) });
    }
    mem0 = score(m0Per);
  } finally {
    await drop(umCol); await drop(mem0Col);
  }
  const after = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  if (before != null && after !== before) throw new Error(`ISOLATION VIOLATION: memories ${before} -> ${after}`);

  const result = {
    timestamp: new Date().toISOString(), n: rows.length,
    mode: 'session-recall, multi-fact summaries, infer:false, content-contains recall@k (distinctive verbatim answer span)',
    provider: process.env.UM_EMBEDDING_PROVIDER ?? 'openai', model: process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    arms: { um, mem0 }, memoriesUntouched: before === after,
  };
  const outPath = parseOut(process.argv) ?? fileURLToPath(new URL('./results/2026-06-19-session-recall-run1.json', import.meta.url));
  const latestPath = fileURLToPath(new URL('./results/session-recall-latest.json', import.meta.url));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await writeFile(latestPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`\n=== UM vs raw mem0 — SESSION-recall (n=${rows.length}, multi-fact summaries, content-contains recall@k) ===`);
  console.log('metric     |   UM    |  mem0');
  console.log('-----------+---------+--------');
  for (const k of KS) console.log(`recall@${String(k).padEnd(3)}| ${String(um[k]).padEnd(7)} | ${mem0[k]}`);
  console.log(`MRR        | ${String(um.mrr).padEnd(7)} | ${mem0.mrr}`);
  console.log(`\nUM misses: ${um.misses.join(',') || '(none)'}`);
  console.log(`mem0 misses: ${mem0.misses.join(',') || '(none)'}`);
  console.log(`memories collection untouched: ${before === after}`);
  console.log(`result -> ${outPath}`);
}

main().catch((e) => { console.error('[session-recall] FATAL:', e); process.exit(1); });
