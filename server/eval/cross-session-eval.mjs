/**
 * cross-session-eval.mjs — Tier-2 #8 cross-session recall via a genuine TWO-PROCESS protocol.
 *
 * Phase A (--seed) seeds session summaries into a DURABLE scratch collection + writes a
 * manifest, then EXITS. Phase B (--recall) is a SEPARATE node invocation: connects fresh,
 * recalls each query, scores content-contains recall@k (pure crossSessionRecall, NO LLM
 * judge), writes the result, drops the collection. Two separate `node` runs = a true
 * fresh-process recall (not same-process retrieval). Sibling of compare-session-recall.mjs.
 *
 * Run (from server/):
 *   node --env-file=.env eval/cross-session-eval.mjs --seed eval/session-recall-set.jsonl --manifest eval/results/xs-manifest.json
 *   node --env-file=.env eval/cross-session-eval.mjs --recall eval/results/xs-manifest.json --out eval/results/<date>-tier2-cross-session-run1.json
 */
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { crossSessionRecall, loadFixtureJsonl } from './memory-quality-eval.mjs';

const EVAL_USER = 'um-xs-eval';
const VECTOR_DIM = 1536;
const SCRATCH_PREFIX = 'eval_xs_';
const KS = [1, 3, 5, 10];
const norm = (t) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function assertScratchSafe(name) {
  if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX) || name === 'memories') {
    throw new Error(`cross-session: refusing non-scratch collection '${name}' — must start with '${SCRATCH_PREFIX}' and never be 'memories'`);
  }
}

function pinEnvAndRequireKey(usage) {
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_TEMPORAL_DECAY = 'false';
  process.env.UM_DEDUP_ENABLED = 'true';
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'true';
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) {
    console.error(`[cross-session] OPENAI_API_KEY not set — run: node --env-file=.env eval/cross-session-eval.mjs ${usage}`);
    process.exit(2);
  }
}

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--seed') a.seed = argv[++i];
    else if (argv[i] === '--manifest') a.manifest = argv[++i];
    else if (argv[i] === '--recall') a.recall = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
  }
  return a;
}

async function connectQdrant() {
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.QDRANT_PORT ?? '6333', 10);
  return { client: new QdrantClient({ host, port }), host, port };
}

async function makeMemory(host, port, collectionName) {
  const { Memory } = await import('mem0ai/oss');
  const { getEmbedderConfig } = await import('../lib/embed.mjs');
  const { getFactsLlmConfig } = await import('../lib/facts.mjs');
  return new Memory({
    embedder: getEmbedderConfig(process.env),
    llm: getFactsLlmConfig(process.env),
    vectorStore: { provider: 'qdrant', config: { host, port, collectionName } },
  });
}

const countMemories = (client) => client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);

async function seedPhase({ fixturePath, manifestPath }) {
  pinEnvAndRequireKey(`--seed ${fixturePath} --manifest ${manifestPath}`);
  const rows = await loadFixtureJsonl(fixturePath);
  const { client, host, port } = await connectQdrant();
  const { umAdd } = await import('../lib/add.mjs');
  const collection = `${SCRATCH_PREFIX}${new Date().toISOString().slice(0, 10)}_${process.pid}`;
  assertScratchSafe(collection);
  const before = await countMemories(client);
  try { await client.deleteCollection(collection); } catch (e) { if (e?.status !== 404) throw e; }
  await client.createCollection(collection, { vectors: { size: VECTOR_DIM, distance: 'Cosine' } });
  const memory = await makeMemory(host, port, collection);
  for (const r of rows) {
    await umAdd({ memory, text: r.session_summary, userId: EVAL_USER, infer: false, surface: 'eval', metadata: { lane: r.lane }, _qdrantClient: client });
  }
  const after = await countMemories(client);
  if (before != null && after !== before) throw new Error(`cross-session SEED isolation violation: memories ${before} -> ${after}`);
  const manifest = {
    collection, dim: VECTOR_DIM, host, port,
    embedModel: process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small (provider default)',
    seededBy: process.pid, seededAt: new Date().toISOString(), n: rows.length,
    rows: rows.map((r) => ({ id: r.id, query: r.query, answer: r.answer })),
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[cross-session] PHASE A: seeded ${rows.length} rows into ${collection}; manifest -> ${manifestPath}`);
  console.log(`[cross-session] now run PHASE B in a FRESH process: node --env-file=.env eval/cross-session-eval.mjs --recall ${manifestPath} --out <result>`);
}

async function recallPhase({ manifestPath, outPath }) {
  pinEnvAndRequireKey(`--recall ${manifestPath}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assertScratchSafe(manifest.collection);
  const { client } = await connectQdrant();
  const { doSearch } = await import('../mem0-mcp-http.mjs');
  const memory = await makeMemory(manifest.host, manifest.port, manifest.collection);
  const before = await countMemories(client);
  let result;
  try {
    const perQuery = [];
    for (const r of manifest.rows) {
      const sr = await doSearch(r.query, 10, false, true, { memory });
      perQuery.push({ id: r.id, answerNorm: norm(r.answer), bodies: (sr.results ?? []).map((x) => norm(x.body)) });
    }
    result = {
      timestamp: new Date().toISOString(),
      metric: 'cross-session-recall (two-process, content-contains, distinctive verbatim answer span)',
      n: manifest.rows.length, collection: manifest.collection, twoProcess: true,
      seededAt: manifest.seededAt, recalledBy: process.pid,
      provider: process.env.UM_EMBEDDING_PROVIDER ?? 'openai', model: manifest.embedModel,
      crossSession: crossSessionRecall(perQuery, KS),
    };
  } finally {
    assertScratchSafe(manifest.collection);
    try { await client.deleteCollection(manifest.collection); } catch (e) { if (e?.status !== 404) console.error('[cross-session] teardown:', e?.message); }
  }
  const after = await countMemories(client);
  if (before != null && after !== before) throw new Error(`cross-session RECALL isolation violation: memories ${before} -> ${after}`);
  const finalOut = outPath ?? fileURLToPath(new URL('./results/cross-session-latest.json', import.meta.url));
  await mkdir(dirname(finalOut), { recursive: true });
  await writeFile(finalOut, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[cross-session] PHASE B: recall@k ${JSON.stringify(result.crossSession.aggregate)} MRR ${result.crossSession.mrr} (n=${result.n}); misses: ${result.crossSession.misses.join(',') || '(none)'}`);
  console.log(`[cross-session] result -> ${finalOut}; collection ${manifest.collection} dropped`);
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.seed) {
    if (!a.manifest) { console.error('--seed requires --manifest <path>'); process.exit(2); }
    await seedPhase({ fixturePath: a.seed, manifestPath: a.manifest });
  } else if (a.recall) {
    await recallPhase({ manifestPath: a.recall, outPath: a.out });
  } else {
    console.error('Usage: cross-session-eval.mjs (--seed <fixture> --manifest <path>) | (--recall <manifest> [--out <path>])');
    process.exit(2);
  }
}

main().catch((e) => { console.error('[cross-session] FATAL:', e?.message ?? e); process.exit(1); });
