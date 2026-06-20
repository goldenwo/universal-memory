/**
 * band-ceiling-study.mjs — pin the confident-duplicate floor τ_dupfloor for the supersession
 * ceiling widening (spec docs/plans/2026-06-15-supersession-ceiling-repin-spec.md §3).
 *
 * The review refuted a contradiction/duplicate SEPARATION (they overlap). So this study does NOT
 * look for a separating line — it measures four cosine distributions and finds τ_dupfloor: the
 * cosine above which we're confident a hit is a true DUPLICATE (re-ingest) so the judge can be
 * skipped, while everything below it is judged.
 *
 *   - DUPLICATES (D1 dedup-labels.json, merge-positive labels) — cosine(a,b). Where re-ingests live.
 *   - CONTRADICTIONS d3 (d3-contradiction-set.jsonl, same-lane) — cosine(older,newer). The pin tail.
 *   - CONTRADICTIONS held-out (held-out-contradiction-set.jsonl) — NEW, disjoint from d3+staleness,
 *     so capture validation is non-circular (review A-B2/A-B3). Also flags which reach ≥0.84.
 *   - OVER-SUPERSESSION (over-supersession-set.jsonl) — high-cosine same-lane NON-contradictions
 *     the judge must DECLINE; flags which reach ≥0.84 (else they never exercise the band, review B-B2).
 *
 * Pure embed + cosine — NO qdrant, NO collections, real `memories` never opened. Needs OPENAI only.
 * Run: node --env-file=.env eval/band-ceiling-study.mjs   (from server/)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';

const FLOOR = 0.84;          // dedup floor — below this no dedup hit fires, so no in-band judge
const CUR_CEILING = 0.87;    // current contradictionBandCeiling default (what we're widening)
const MERGE_POSITIVE = new Set(['identical', 'duplicate', 'paraphrase', 'near-duplicate', 'near_dup']);

function pct(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return +(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)).toFixed(4);
}
function dist(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: pct(s, 0), p5: pct(s, 0.05), p25: pct(s, 0.25), median: pct(s, 0.5),
    p75: pct(s, 0.75), p95: pct(s, 0.95), max: pct(s, 1),
    mean: s.length ? +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(4) : null,
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) { try { process.loadEnvFile?.(); } catch { /* no ./.env */ } }
  if (!process.env.OPENAI_API_KEY) { console.error('[band-study] OPENAI_API_KEY not set — run: node --env-file=.env eval/band-ceiling-study.mjs'); process.exit(2); }

  const { embed } = await import('../lib/embed.mjs');
  const { cosineStrict } = await import('../lib/vector.mjs');
  const { NOOP_METRICS } = await import('../lib/metrics.mjs');

  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const dedup = JSON.parse(await readFile(here('../test/fixtures/dedup-labels.json'), 'utf8'));
  const d3 = await loadFixtureJsonl(here('./d3-contradiction-set.jsonl'));
  const heldout = await loadFixtureJsonl(here('./held-out-contradiction-set.jsonl'));
  const oversup = await loadFixtureJsonl(here('./over-supersession-set.jsonl'));

  // Embed every distinct text once.
  const cache = new Map();
  const need = new Set();
  const add = (t) => { if (t) need.add(t); };
  for (const r of dedup) { add(r.a); add(r.b); }
  for (const r of d3) { add(r.olderFact); add(r.newerFact); }
  for (const r of heldout) { add(r.original_fact); add(r.updated_fact); }
  for (const r of oversup) { add(r.fact_a); add(r.fact_b); }
  process.stderr.write(`[band-study] embedding ${need.size} distinct texts...\n`);
  for (const t of need) { const r = await embed(t, { metrics: NOOP_METRICS }); cache.set(t, r.vector); }
  const cos = (a, b) => +cosineStrict(cache.get(a), cache.get(b)).toFixed(4);

  // Pairs.
  const dupPairs = dedup.filter((r) => MERGE_POSITIVE.has(r.label)).map((r) => ({ label: r.label, cosine: cos(r.a, r.b) }));
  const dupLabels = [...new Set(dedup.map((r) => r.label))];
  const d3Pairs = d3.filter((r) => r.label === 'contradiction' && r.category === 'same-lane-contradiction').map((r) => ({ cosine: cos(r.olderFact, r.newerFact) }));
  const hoPairs = heldout.map((r) => ({ id: r.id, lane: r.lane, cosine: cos(r.original_fact, r.updated_fact) }));
  const osPairs = oversup.map((r) => ({ id: r.id, relation: r.relation, expected: r.expected, cosine: cos(r.fact_a, r.fact_b) }));

  const dupDist = dist(dupPairs.map((p) => p.cosine));
  const d3Dist = dist(d3Pairs.map((p) => p.cosine));
  const hoDist = dist(hoPairs.map((p) => p.cosine));
  const osDeclineDist = dist(osPairs.filter((p) => p.expected === 'decline').map((p) => p.cosine));

  // Contradiction tail = d3 + held-out (the pin reference). τ_dupfloor must sit ABOVE it so every
  // measured contradiction reaches the judge; cost-skip only above it.
  const contradCosines = [...d3Pairs, ...hoPairs].map((p) => p.cosine);
  const contradMax = Math.max(...contradCosines);
  const recommend = +(Math.ceil((contradMax + 0.005) * 100) / 100).toFixed(2); // just above the tail, rounded up to 0.01
  // Cost proxy: fraction of merge-positive dup pairs that land in the NEWLY-judged window.
  const dupInWidened = dupPairs.filter((p) => p.cosine > CUR_CEILING && p.cosine <= recommend).length;
  const costProxy = dupPairs.length ? +(dupInWidened / dupPairs.length).toFixed(3) : null;

  const hoBelowFloor = hoPairs.filter((p) => p.cosine < FLOOR).map((p) => p.id);
  const hoAboveCeiling = hoPairs.filter((p) => p.cosine > CUR_CEILING).map((p) => p.id);
  const osDeclineBelowFloor = osPairs.filter((p) => p.expected === 'decline' && p.cosine < FLOOR).map((p) => p.id);

  const result = {
    timestamp: new Date().toISOString(),
    model: process.env.UM_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    floor: FLOOR, currentCeiling: CUR_CEILING,
    distributions: { duplicates: dupDist, d3Contradictions: d3Dist, heldOutContradictions: hoDist, overSupersessionDecline: osDeclineDist },
    dupLabelsSeen: dupLabels, dupLabelsUsed: [...MERGE_POSITIVE].filter((l) => dupLabels.includes(l)),
    contradictionTailMax: +contradMax.toFixed(4),
    recommendedTauDupFloor: recommend,
    costProxy: { note: 'fraction of merge-positive D1 dup pairs landing in (0.87, τ_dupfloor] — a PROXY for newly-judged re-ingest writes, not the real write distribution', dupPairsInWidenedWindow: dupInWidened, ofTotalDupPairs: dupPairs.length, fraction: costProxy, preRegisteredAbort: 0.30 },
    coverage: {
      heldOutReachBand: hoPairs.length - hoBelowFloor.length, heldOutTotal: hoPairs.length, heldOutBelowFloor: hoBelowFloor,
      heldOutAboveCurrentCeiling: hoAboveCeiling,
      overSupersessionDeclineReachBand: osPairs.filter((p) => p.expected === 'decline').length - osDeclineBelowFloor.length,
      overSupersessionDeclineBelowFloor: osDeclineBelowFloor,
    },
    perPair: { heldOut: hoPairs, overSupersession: osPairs, duplicates: dupPairs },
  };
  const outPath = here('./results/2026-06-19-band-ceiling-study.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const fmt = (d) => `n=${String(d.n).padStart(2)}  min ${d.min}  p25 ${d.p25}  med ${d.median}  p75 ${d.p75}  p95 ${d.p95}  max ${d.max}`;
  console.log(`\n=== band-ceiling study — confident-duplicate floor (model ${result.model}) ===`);
  console.log(`dup labels seen: ${dupLabels.join(', ')}  | used as duplicates: ${result.dupLabelsUsed.join(', ')}`);
  console.log(`DUPLICATES (D1)            ${fmt(dupDist)}`);
  console.log(`CONTRADICTIONS d3         ${fmt(d3Dist)}`);
  console.log(`CONTRADICTIONS held-out   ${fmt(hoDist)}`);
  console.log(`OVER-SUPERSESSION decline ${fmt(osDeclineDist)}`);
  console.log(`\ncontradiction tail max (d3+held-out): ${result.contradictionTailMax}`);
  console.log(`RECOMMENDED τ_dupfloor: ${recommend}  (just above the contradiction tail → every measured contradiction is judged; skip only confident dups above)`);
  console.log(`cost proxy: ${dupInWidened}/${dupPairs.length} dup pairs in (0.87, ${recommend}] = ${costProxy} (abort if > 0.30)`);
  console.log(`\nheld-out reaching band (≥${FLOOR}): ${result.coverage.heldOutReachBand}/${hoPairs.length}` + (hoBelowFloor.length ? ` — BELOW floor: ${hoBelowFloor.join(',')}` : ' — all clear'));
  console.log(`held-out above current 0.87 ceiling (need the widening): ${hoAboveCeiling.length} [${hoAboveCeiling.join(',')}]`);
  console.log(`over-supersession DECLINE reaching band (≥${FLOOR}): ${result.coverage.overSupersessionDeclineReachBand}/${osPairs.filter((p) => p.expected === 'decline').length}` + (osDeclineBelowFloor.length ? ` — BELOW floor (won't exercise band): ${osDeclineBelowFloor.join(',')}` : ' — all clear'));
  console.log(`result -> ${outPath}`);
}

main().catch((e) => { console.error('[band-study] FATAL:', e); process.exit(1); });
