/**
 * server/eval/compare-rot-um-mem0.mjs — head-to-head MEMORY-ROT (longitudinal currency): UM pipeline vs RAW mem0.
 *
 * The staleness head-to-head (compare-staleness-um-mem0.mjs) measured a SINGLE contradiction cycle
 * (seed original → seed one update → does the stale original still surface?). This harness generalizes
 * that single cycle to an 8-cycle longitudinal chain: one attribute (employer, city, manager, …) is
 * revised 8 times in a row, and we snapshot purity AT EACH DEPTH for both arms. The UM↔mem0 gap as a
 * function of depth is the differentiator — UM's currency guarantee should hold flat while raw mem0
 * accumulates every stale version.
 *
 * Per chain (rot-set.jsonl: ≥12 chains × 8 mutually-contradicting facts + a neutral query):
 *   incrementally seed facts[0..7] into ONE growing scratch collection; after each seed (depth d=i+1)
 *   snapshot BOTH the status level (qdrant payload.status per seeded point) AND the retrieval level
 *   (neutral query → top-10 bodies). Feed the pure scorers in lib/rot.mjs.
 *
 *   UM arm   : umAdd(fact_i) per cycle. Supersession fires by EITHER production path — in-band at write
 *              (event SUPERSEDED_INBAND) OR the session-end detector (detectContradictionsInBatch →
 *              supersedePoint) for swaps below the in-band cosine band. doSearch (5-arg, full:true,
 *              scratch-routed) filters superseded points. Faithful to prod: the SAME functions the
 *              mq-eval staleness pass injects — decisions are never re-implemented.
 *   mem0 arm : Memory.add(fact_i, infer:false) per cycle → Memory.search. No currency layer → every
 *              version persists → stale accumulation grows with depth (the noise floor / contrast arm).
 *
 * Detection is exact NORMALIZED content-match (both arms store verbatim under infer:false → fair,
 * deterministic; the UM contradiction judge runs only inside supersession). Per-(chain,arm) ISOLATION:
 * a fresh `eval_rot_` scratch collection, dropped immediately after; a fail-loud scratch-name guard +
 * a `memories` point-count before/after assert keep the real vault untouched.
 *
 * Run: node --env-file=.env eval/compare-rot-um-mem0.mjs [--out <path>] [--arms "um,mem0"]   (from server/)
 *   --arms um   → skip the mem0 arm (no gap series produced).
 */

import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';
import { embed } from '../lib/embed.mjs';
import {
  chainPurity, retrievalPurity, effectiveDepth, engagedDepth,
  survivorIdentityViolations, resurrectionScan, aggregateRotByDepth,
  gapByDepth, rungValidity, judgeConfidenceByCycle, formatRotSweep,
} from './lib/rot.mjs';

const EVAL_USER = 'um-rot-cmp-eval';
const VECTOR_DIM = 1536;                  // text-embedding-3-small
const SCRATCH_PREFIX = 'eval_rot_';       // every scratch collection MUST start with this
const norm = (t) => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }; // unit-norm vectors → dot

/** Refuse any collection that is not an `eval_rot_` scratch collection — and never `memories`. */
function assertScratchSafe(name) {
  if (typeof name !== 'string' || !name.startsWith(SCRATCH_PREFIX) || name === 'memories') {
    throw new Error(`rot-compare: refusing non-scratch collection '${name}' — must start with '${SCRATCH_PREFIX}' and never be 'memories'`);
  }
}

function parseOut(argv) {
  for (let i = 2; i < argv.length; i++) if (argv[i] === '--out') return argv[i + 1];
  return null;
}

/** Parse `--arms "um,mem0"` (default both). Returns { armsUm: boolean } — true ⇒ mem0 arm skipped. */
function parseArms(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--arms') {
      const set = new Set((argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      return { armsUm: set.has('um') && !set.has('mem0') };
    }
  }
  return { armsUm: false };
}

/**
 * Pre-flight cosine calibration (§5.3 fixture-acceptance gate). For each chain, embed all 8 facts and
 * classify the 7 adjacent pairs against the in-band window [0.84, 0.95]; warn on any out-of-band pair so
 * the operator can rework the chain before trusting its supersession behavior.
 */
async function calibrate(rows) {
  const report = [];
  for (const r of rows) {
    const vecs = [];
    for (const f of r.facts) vecs.push((await embed(f)).vector);
    const pairs = [];
    for (let i = 1; i < vecs.length; i++) {
      const c = cosine(vecs[i - 1], vecs[i]);
      pairs.push({ i, cos: +c.toFixed(4), band: c > 0.95 ? 'above' : c < 0.84 ? 'below' : 'in' });
    }
    const outOfBand = pairs.filter((p) => p.band !== 'in');
    report.push({ id: r.id, pairs, outOfBand: outOfBand.length });
    if (outOfBand.length) console.warn(`[rot-calib] ${r.id}: ${outOfBand.length}/7 pairs out of band`, outOfBand);
  }
  return report;
}

async function main() {
  // Pin MEM0_USER_ID + flags BEFORE importing mem0-mcp-http (USER_ID captured at import time).
  process.env.MEM0_USER_ID = EVAL_USER;
  process.env.UM_TEMPORAL_DECAY = 'false';
  process.env.UM_DEDUP_ENABLED = 'true';
  process.env.UM_AUTOSUPERSEDE_ENABLED = 'true';   // under test — autosupersede must be ON
  process.env.UM_LANE_CLASSIFIER_ENABLED = 'true';
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) { console.error('[rot-compare] OPENAI_API_KEY not set — run: node --env-file=.env eval/compare-rot-um-mem0.mjs'); process.exit(2); }

  const { armsUm } = parseArms(process.argv);

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

  const fixturePath = fileURLToPath(new URL('./rot-set.jsonl', import.meta.url));
  const rows = await loadFixtureJsonl(fixturePath);

  // §5.3 calibration FIRST — embed each chain's 8 facts, classify the 7 adjacent cosines, warn out-of-band.
  const calibration = await calibrate(rows);

  /**
   * UM-arm chain seeding: incrementally seed facts[0..7] into ONE growing collection; supersession per
   * cycle (in-band OR session-end detector); snapshot status-level + retrieval-level purity at each depth.
   */
  async function umChain(row, idx) {
    const col = `${SCRATCH_PREFIX}um_${rid}_${idx}`;
    await ensure(col); created.add(col);
    const mem = makeMem(col);
    const ids = [];                 // factIdx → qdrant point id
    const perCycle = [];            // {cycle, event, firedPath, fired, confidence|null}
    const snapshots = [];           // {depth, pointStatuses, staleSurvivors, latestCurrent, retrieval}
    for (let i = 0; i < row.facts.length; i++) {
      const res = await umAdd({ memory: mem, text: row.facts[i], userId: EVAL_USER, infer: false,
        surface: 'eval', metadata: { lane: row.lane }, _qdrantClient: client });
      ids[i] = res.results?.[0]?.id;
      const event = res.results?.[0]?.event;          // ADD | SUPERSEDED_INBAND | DEDUP_MERGED
      let fired = false, firedPath = null, confidence = null;
      if (event === 'SUPERSEDED_INBAND') {
        fired = true; firedPath = 'inband'; // confidence not returned by the in-band path (logged only) → null
      } else if (event === 'ADD') {
        const hit = await detectContradictionsInBatch(row.facts[i], {
          userId: EVAL_USER, lane: row.lane, collection: col, client,
          _facts: () => ({ facts: [row.facts[i]] }),
        });
        if (hit.length) {
          fired = true; firedPath = 'detector'; confidence = hit[0].confidence ?? null;
          await supersedePoint({ client, collection: col, id: hit[0].targetId, supersededBy: hit[0].supersededBy });
        }
      } // DEDUP_MERGED → the cycle merged away (no distinct point) → fired stays false
      perCycle.push({ cycle: i + 1, event, firedPath, fired, confidence });

      // --- snapshot at depth d = i+1 ---
      const depth = i + 1;
      const live = await client.retrieve(col, { ids: ids.slice(0, depth), with_payload: true, with_vector: false });
      const recs = Array.isArray(live) ? live : (live?.points ?? []); // retrieve→bare array; tolerate a {points} wrapper
      const statusById = new Map(recs.map((p) => [p.id, p.payload?.status ?? 'current'])); // TOP-LEVEL payload.status
      const pointStatuses = {}; for (let k = 0; k < depth; k++) pointStatuses[k] = statusById.get(ids[k]) ?? 'current';
      const cp = chainPurity(pointStatuses, depth - 1);
      const sr = await doSearch(row.query, 10, false, true, { memory: mem }); // 5-arg form — scratch-routed, full bodies
      const bodies = (sr.results ?? []).map((x) => norm(x.body));
      const rp = retrievalPurity(bodies, row.facts.map(norm), depth);
      snapshots.push({ depth, pointStatuses, staleSurvivors: cp.staleSurvivors, latestCurrent: cp.latestCurrent, retrieval: rp });
    }
    await drop(col); created.delete(col);
    return { id: row.id, lane: row.lane, anchor: row.anchor ?? null,
             effectiveDepth: effectiveDepth(perCycle), engagedDepth: engagedDepth(perCycle), perCycle, snapshots };
  }

  /** mem0-arm chain seeding: native add/search, infer:false, NO currency layer → retrieval-only snapshots. */
  async function mem0Chain(row, idx) {
    const col = `${SCRATCH_PREFIX}mem0_${rid}_${idx}`;
    await ensure(col); created.add(col);
    const mem = makeMem(col);
    const snapshots = [];
    for (let i = 0; i < row.facts.length; i++) {
      await mem.add(row.facts[i], { userId: EVAL_USER, infer: false });
      const depth = i + 1;
      const raw = await mem.search(row.query, { userId: EVAL_USER, limit: 10 });
      const arr = Array.isArray(raw) ? raw : (raw?.results ?? []);
      const bodies = arr.map((x) => norm(x.memory ?? x.text ?? ''));
      snapshots.push({ depth, retrieval: retrievalPurity(bodies, row.facts.map(norm), depth) });
    }
    await drop(col); created.delete(col);
    return { id: row.id, snapshots };
  }

  const before = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);
  const created = new Set();
  let umChains = [];
  let mem0Chains = [];
  try {
    for (let i = 0; i < rows.length; i++) {
      const ch = await umChain(rows[i], i);
      umChains.push(ch);
      console.log(`[rot-compare] ${ch.id} (${ch.lane}): UM engagedDepth=${ch.engagedDepth} effectiveDepth=${ch.effectiveDepth}`);
    }
    if (!armsUm) {
      for (let i = 0; i < rows.length; i++) mem0Chains.push(await mem0Chain(rows[i], i));
    }
  } finally {
    for (const c of created) await drop(c); // sweep any collection left by a mid-chain throw
  }
  const after = await client.count('memories', { exact: true }).then((r) => r.count).catch(() => null);

  const maxDepth = 8;
  // Per-cycle fired rate across chains: cycle d → fraction of chains whose cycle d fired (cycle-indexed: d → [d-1]).
  const fireRateByCycle = Array.from({ length: maxDepth }, (_, c) => {
    const seen = umChains.filter((ch) => ch.perCycle[c]);
    const fired = seen.filter((ch) => ch.perCycle[c].fired);
    return seen.length ? fired.length / seen.length : 0;
  });
  // Detector-path confidences per cycle (in-band / no-fire cycles contribute nothing).
  const perCycleJudge = Array.from({ length: maxDepth }, (_, c) =>
    umChains.map((ch) => ch.perCycle[c]).filter((x) => x && x.firedPath === 'detector' && x.confidence != null).map((x) => x.confidence));

  const umAgg = aggregateRotByDepth(umChains, 'um');
  const mem0Agg = armsUm ? [] : aggregateRotByDepth(mem0Chains, 'mem0');
  const validity = rungValidity(fireRateByCycle);
  // §5.7 identity violations across chains (a non-empty list = a real supersession bug).
  const identityViolations = umChains.flatMap((ch) =>
    survivorIdentityViolations(ch.perCycle.map((x) => x.fired), ch.snapshots).map((v) => ({ id: ch.id, ...v })));
  const resurrectionCount = umChains.reduce((s, ch) => s + resurrectionScan(ch.snapshots), 0);

  const provider = process.env.UM_EMBEDDING_PROVIDER ?? 'openai';
  const model = process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  const result = {
    timestamp: new Date().toISOString(), provider, model, evalUser: EVAL_USER,
    mode: 'memory-rot longitudinal: incrementally seed 8 contradicting facts → snapshot status+retrieval purity per depth; UM vs raw mem0',
    flags: { UM_AUTOSUPERSEDE_ENABLED: 'true', UM_DEDUP_ENABLED: 'true', UM_LANE_CLASSIFIER_ENABLED: 'true', UM_TEMPORAL_DECAY: 'false' },
    env: { node: process.version, platform: process.platform },
    calibration,
    rotSweep: {
      depths: Array.from({ length: maxDepth }, (_, i) => i + 1), chainCount: rows.length,
      arms: { um: { byDepth: umAgg }, mem0: { byDepth: mem0Agg } },
      gapByDepth: armsUm ? [] : gapByDepth(umAgg, mem0Agg),
      diagnostics: {
        resurrectionCount,
        fireRateByCycle, judgeConfByCycle: judgeConfidenceByCycle(perCycleJudge),
        validity, identityViolations,
        effectiveDepthByChain: Object.fromEntries(umChains.map((ch) => [ch.id, ch.effectiveDepth])),
        engagedDepthByChain: Object.fromEntries(umChains.map((ch) => [ch.id, ch.engagedDepth])),
      },
      perChain: { um: umChains, mem0: mem0Chains },
    },
    memoriesUntouched: before === after,
  };

  // --- Live depth-2 anchor assertion (keyed): this run's depth-2 must match the recorded staleness-compare row. ---
  const refPath = fileURLToPath(new URL('./results/staleness-compare-latest.json', import.meta.url));
  if (existsSync(refPath)) {
    const ref = JSON.parse(readFileSync(refPath, 'utf8'));
    const byId = new Map((ref.perRow?.um ?? []).map((r) => [r.id, r]));
    for (const ch of umChains.filter((c) => c.anchor)) {
      const refRow = byId.get(ch.anchor); if (!refRow) continue;
      const c2 = ch.perCycle[1]; const snap2 = ch.snapshots.find((s) => s.depth === 2);
      const surfacedOriginal = snap2 ? snap2.retrieval.staleSurfaced > 0 : null; // facts[0] still surfaced at depth 2
      if (c2.fired !== refRow.fired || c2.firedPath !== refRow.firedPath || surfacedOriginal !== refRow.surfacedOriginal) {
        console.error(`[rot-compare] ANCHOR MISMATCH ${ch.id}/${ch.anchor}: this={fired:${c2.fired},path:${c2.firedPath},stale:${surfacedOriginal}} ref={fired:${refRow.fired},path:${refRow.firedPath},stale:${refRow.surfacedOriginal}}`);
      }
    }
  } else {
    console.warn('[rot-compare] no results/staleness-compare-latest.json — skipping live depth-2 anchor check (run compare-staleness first)');
  }

  // --- Write results + render ---
  const date = new Date().toISOString().slice(0, 10);
  const outPath = parseOut(process.argv) ?? fileURLToPath(new URL(`./results/mq-rot-sweep-${date}.json`, import.meta.url));
  const latestPath = fileURLToPath(new URL('./results/mq-rot-sweep-latest.json', import.meta.url));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  await mkdir(dirname(latestPath), { recursive: true });
  await writeFile(latestPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log('\n' + formatRotSweep(result));

  // Calibration summary + prominent flags for the operator (the keyed run is the decisive reviewer).
  const calibOutOfBand = calibration.filter((c) => c.outOfBand > 0);
  console.log(`\ncalibration: ${calibration.length} chains; ${calibOutOfBand.length} with out-of-band pairs` +
    (calibOutOfBand.length ? ` -> ${calibOutOfBand.map((c) => `${c.id}(${c.outOfBand})`).join(', ')}` : ''));
  if (identityViolations.length) {
    console.error(`\n[rot-compare] §5.7 IDENTITY VIOLATIONS (${identityViolations.length}) — real supersession bug:`);
    for (const v of identityViolations) console.error(`  ${v.id} depth=${v.depth} expected=${v.expected} actual=${v.actual}`);
  } else {
    console.log('§5.7 identity: clean (0 violations)');
  }
  if (resurrectionCount > 0) {
    console.error(`\n[rot-compare] RESURRECTIONS=${resurrectionCount} — superseded→current durability bug (architecturally expected 0)`);
  } else {
    console.log('resurrections: 0 (sticky tombstones hold)');
  }
  console.log(`\nmemories collection untouched: ${before === after}`);
  console.log(`result -> ${outPath}`);

  if (before != null && after !== before) throw new Error(`ISOLATION VIOLATION: memories ${before} -> ${after}`);
}

main().catch((e) => { console.error('[rot-compare] FATAL:', e); process.exit(1); });
