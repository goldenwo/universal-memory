/**
 * server/eval/compare-um-mem0.mjs — head-to-head: UM pipeline vs RAW mem0 engine,
 * fact-recall on the existing recall-set.jsonl. Part of the memory-systems comparison
 * (docs/plans/2026-06-18-memory-comparison-{spec,plan}.md), scoped this pass to the
 * single cleanest contrast: "does UM's pipeline change recall vs the engine it wraps?"
 *
 * Both arms seed infer:false (store the literal fact → isolates RETRIEVAL) under one
 * eval userId, into separate SCRATCH qdrant collections (eval_cmp_*), then query and
 * score by exact normalized content-match (both store verbatim → fair, deterministic,
 * no LLM judge). Real `memories` collection untouched; scratch collections dropped in
 * a finally. EXPECTATION: near-parity — UM and mem0 share the retrieval core (mem0 +
 * qdrant + OpenAI embeddings); UM's edge (currency/dedup/lanes) is NOT exercised by a
 * distinct-fact recall test (that's the separate staleness eval). This run confirms UM
 * does not DEGRADE raw recall.
 *
 * Run: node --env-file=.env eval/compare-um-mem0.mjs   (from server/)
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

const EVAL_USER = 'um-cmp-eval';
const VECTOR_DIM = 1536;
const KS = [1, 3, 5, 10];
const norm = (t) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function score(perQuery) {
  const agg = {}; for (const k of KS) agg[k] = 0;
  const rrs = [];
  for (const q of perQuery) {
    let rank = 0;
    for (let i = 0; i < q.resultNorms.length; i++) { if (q.resultNorms[i] === q.targetNorm) { rank = i + 1; break; } }
    for (const k of KS) if (rank > 0 && rank <= k) agg[k]++;
    rrs.push(rank > 0 ? 1 / rank : 0);
  }
  const n = perQuery.length || 1;
  const out = {};
  for (const k of KS) out[k] = +(agg[k] / n).toFixed(3);
  out.mrr = +(rrs.reduce((a, b) => a + b, 0) / n).toFixed(3);
  out.misses = perQuery.filter((q) => !q.resultNorms.includes(q.targetNorm)).map((q) => q.id);
  return out;
}

async function main() {
  // Pin MEM0_USER_ID BEFORE importing mem0-mcp-http (USER_ID captured at import).
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_TEMPORAL_DECAY = 'false';
  process.env.UM_DEDUP_ENABLED = 'true';
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'true';
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) { console.error('[compare] OPENAI_API_KEY not set — run: node --env-file=.env eval/compare-um-mem0.mjs'); process.exit(2); }

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
  const umCol = `eval_cmp_um_${rid}`;
  const mem0Col = `eval_cmp_mem0_${rid}`;
  const makeMem = (collectionName) => new Memory({
    embedder: getEmbedderConfig(process.env),
    llm: getFactsLlmConfig(process.env),
    vectorStore: { provider: 'qdrant', config: { host, port, collectionName } },
  });
  const ensure = async (c) => { try { await client.deleteCollection(c); } catch (e) { if (e?.status !== 404) throw e; } await client.createCollection(c, { vectors: { size: VECTOR_DIM, distance: 'Cosine' } }); };
  const drop = async (c) => { try { await client.deleteCollection(c); } catch { /* ignore */ } };

  const fixturePath = fileURLToPath(new URL('./recall-set.jsonl', import.meta.url));
  const rows = await loadFixtureJsonl(fixturePath);
  const facts = rows.map((r) => ({ id: r.id, text: r.seed_facts[0].text, lane: r.seed_facts[0].lane, query: r.query }));

  const before = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  let um, mem0;
  try {
    // --- UM arm (full pipeline, infer:false) ---
    await ensure(umCol);
    const umMem = makeMem(umCol);
    for (const f of facts) await umAdd({ memory: umMem, text: f.text, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: f.lane }, _qdrantClient: client });
    const umPer = [];
    for (const f of facts) {
      const sr = await doSearch(f.query, 10, false, true, { memory: umMem });
      umPer.push({ id: f.id, targetNorm: norm(f.text), resultNorms: (sr.results ?? []).map((r) => norm(r.body)) });
    }
    um = score(umPer);

    // --- raw mem0 arm (native Memory.add/search, infer:false) ---
    await ensure(mem0Col);
    const m0 = makeMem(mem0Col);
    for (const f of facts) await m0.add(f.text, { userId: EVAL_USER, infer: false });
    const m0Per = [];
    for (const f of facts) {
      const sr = await m0.search(f.query, { userId: EVAL_USER, limit: 10 });
      const arr = Array.isArray(sr) ? sr : (sr?.results ?? []);
      m0Per.push({ id: f.id, targetNorm: norm(f.text), resultNorms: arr.map((r) => norm(r.memory ?? r.text ?? '')) });
    }
    mem0 = score(m0Per);
  } finally {
    await drop(umCol); await drop(mem0Col);
  }
  const after = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  if (before != null && after !== before) throw new Error(`ISOLATION VIOLATION: memories ${before} -> ${after}`);

  const result = { timestamp: new Date().toISOString(), n: facts.length, mode: 'fact-recall, infer:false, exact content-match', provider: 'openai', model: 'text-embedding-3-small', arms: { um, mem0 }, memoriesUntouched: before === after };
  const outPath = fileURLToPath(new URL('./results/2026-06-18-compare-um-mem0.json', import.meta.url));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`\n=== UM vs raw mem0 — fact-recall (n=${facts.length}, infer:false, exact content-match) ===`);
  console.log('metric     |   UM    |  mem0');
  console.log('-----------+---------+--------');
  for (const k of KS) console.log(`recall@${String(k).padEnd(3)}| ${String(um[k]).padEnd(7)} | ${mem0[k]}`);
  console.log(`MRR        | ${String(um.mrr).padEnd(7)} | ${mem0.mrr}`);
  console.log(`\nUM misses: ${um.misses.join(',') || '(none)'}`);
  console.log(`mem0 misses: ${mem0.misses.join(',') || '(none)'}`);
  console.log(`memories collection untouched: ${before === after}`);
  console.log(`result -> ${outPath}`);
}

main().catch((e) => { console.error('[compare] FATAL:', e); process.exit(1); });
