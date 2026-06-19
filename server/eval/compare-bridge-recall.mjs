/**
 * compare-bridge-recall.mjs — arm 4: does claude-mem content, routed through the REAL bridge
 * translation, stay recallable through UM (vs seeding the same summaries directly)?
 *
 * The bridge (`um-bridge-claude-mem`) translates a claude-mem session into a UM `session_summary`
 * markdown doc — frontmatter + the summary wrapped in `<external-summary source="claude-mem">` — and
 * the server's reindex path umAdds `title\n\nbody` (infer:false, _systemMigration:true). This arm
 * exercises the REAL translation (`translateRows` from the bridge) + the REAL UM indexing call
 * (umAdd, exactly as reindexDoc does), into a scratch collection, then queries with the SAME
 * session-recall gold set used by compare-session-recall.mjs. So the only difference vs the direct
 * UM arm is the bridge's wrapping/frontmatter — isolating whether bridging DEGRADES retrieval.
 *
 * (The SQLite read + HTTP /api/reindex transport + cursor/lock are covered by the bridge's own
 * tests — bridge-contract / bridge-drift-gate / um-bridge-claude-mem.test.sh — and are not re-run
 * here; this arm measures the recall-relevant transform: translate → index → retrieve.)
 *
 * Metric: content-contains recall@k (distinctive verbatim answer span), same as the direct arm,
 * so the two are directly comparable. Isolation: scratch collection eval_bridge_*, real `memories`
 * untouched. Run twice.
 *
 * Run: node --env-file=.env eval/compare-bridge-recall.mjs [--out <path>]   (from server/)
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

const EVAL_USER = 'um-bridge-eval';
const VECTOR_DIM = 1536;
const SCRATCH_PREFIX = 'eval_bridge_';
const KS = [1, 3, 5, 10];
const norm = (t) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
// Direct UM session-recall baseline (compare-session-recall.mjs, run-stable) for the delta column.
const DIRECT = { 1: 0.767, 3: 0.967, 5: 1.0, 10: 1.0, mrr: 0.868 };

function assertScratchSafe(name) {
  if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX) || name === 'memories') {
    throw new Error(`bridge-recall: refusing non-scratch collection '${name}' — must start with '${SCRATCH_PREFIX}' and never be 'memories'`);
  }
}

/** Minimal frontmatter split mirroring the server's parseFrontmatter for the translateRows output. */
function splitFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: content };
  const fm = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fm, body: m[2] };
}

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
  if (!process.env.OPENAI_API_KEY) { console.error('[bridge-recall] OPENAI_API_KEY not set — run: node --env-file=.env eval/compare-bridge-recall.mjs'); process.exit(2); }

  const { Memory } = await import('mem0ai/oss');
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const { umAdd } = await import('../lib/add.mjs');
  const { doSearch } = await import('../mem0-mcp-http.mjs');
  const { getEmbedderConfig } = await import('../lib/embed.mjs');
  const { getFactsLlmConfig } = await import('../lib/facts.mjs');
  const { translateRows } = await import('../../plugins/claude-code/universal-memory/bin/translate.mjs');

  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  const client = new QdrantClient({ host, port });
  const col = `${SCRATCH_PREFIX}${process.pid}`;
  const makeMem = (collectionName) => new Memory({
    embedder: getEmbedderConfig(process.env),
    llm: getFactsLlmConfig(process.env),
    vectorStore: { provider: 'qdrant', config: { host, port, collectionName } },
  });
  const ensure = async (c) => { assertScratchSafe(c); try { await client.deleteCollection(c); } catch (e) { if (e?.status !== 404) throw e; } await client.createCollection(c, { vectors: { size: VECTOR_DIM, distance: 'Cosine' } }); };
  const drop = async (c) => { assertScratchSafe(c); try { await client.deleteCollection(c); } catch { /* ignore */ } };

  const rows = await loadFixtureJsonl(fileURLToPath(new URL('./session-recall-set.jsonl', import.meta.url)));
  const baseEpoch = 1781000000; // fixed (avoid Date.now nondeterminism in provenance)

  const before = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  let bridge;
  try {
    await ensure(col);
    const mem = makeMem(col);
    // Seed via the REAL bridge translation + the REAL reindex umAdd call.
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const epoch = baseEpoch + i;
      const claudeMemRow = {
        session_id: `bench-${r.id}`,
        project_raw: 'benchmark',
        created_at: new Date(epoch * 1000).toISOString(),
        created_at_epoch: epoch,
        title: `claude-mem session ${i + 1}`, // neutral, non-answer-leaking (isolates the wrapping effect)
        summary: r.session_summary,
      };
      const { translated, skipped } = translateRows([claudeMemRow]);
      if (skipped.length || !translated.length) throw new Error(`translate skipped ${r.id}: ${JSON.stringify(skipped)}`);
      const { fm, body } = splitFrontmatter(translated[0].content);
      const docText = `${fm.title}\n\n${body.trim()}`; // exactly reindexDoc's docText
      await umAdd({ memory: mem, text: docText, userId: EVAL_USER, metadata: { schema_version: 1, ...fm }, infer: false, _systemMigration: true, _qdrantClient: client });
    }
    const per = [];
    for (const r of rows) {
      const sr = await doSearch(r.query, 10, false, true, { memory: mem });
      per.push({ id: r.id, answerNorm: norm(r.answer), bodies: (sr.results ?? []).map((x) => norm(x.body)) });
    }
    bridge = score(per);
  } finally {
    await drop(col);
  }
  const after = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  if (before != null && after !== before) throw new Error(`ISOLATION VIOLATION: memories ${before} -> ${after}`);

  const result = {
    timestamp: new Date().toISOString(), n: rows.length,
    mode: 'arm4 bridge-recall: real translateRows + real reindex umAdd (infer:false), content-contains recall@k; vs direct UM session-recall',
    provider: process.env.UM_EMBEDDING_PROVIDER ?? 'openai', model: process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    arms: { bridge, directUM: DIRECT }, memoriesUntouched: before === after,
  };
  const outPath = parseOut(process.argv) ?? fileURLToPath(new URL('./results/2026-06-19-bridge-recall-run1.json', import.meta.url));
  const latestPath = fileURLToPath(new URL('./results/bridge-recall-latest.json', import.meta.url));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await writeFile(latestPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`\n=== arm4 BRIDGE-recall — claude-mem content via real bridge translate -> UM (n=${rows.length}) ===`);
  console.log('metric     | bridge  | direct UM | delta');
  console.log('-----------+---------+-----------+-------');
  for (const k of KS) console.log(`recall@${String(k).padEnd(3)}| ${String(bridge[k]).padEnd(7)} | ${String(DIRECT[k]).padEnd(9)} | ${(bridge[k] - DIRECT[k]).toFixed(3)}`);
  console.log(`MRR        | ${String(bridge.mrr).padEnd(7)} | ${String(DIRECT.mrr).padEnd(9)} | ${(bridge.mrr - DIRECT.mrr).toFixed(3)}`);
  console.log(`\nbridge misses: ${bridge.misses.join(',') || '(none)'}`);
  console.log(`memories collection untouched: ${before === after}`);
  console.log(`result -> ${outPath}`);
}

main().catch((e) => { console.error('[bridge-recall] FATAL:', e); process.exit(1); });
