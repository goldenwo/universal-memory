// server/eval/lib/rot.mjs
// Pure scorers for the memory-rot longitudinal eval (#15). No live calls — importing
// this stays fully offline. Status-level reads come from qdrant payload.status; the
// scorers here are pure functions over already-collected snapshots.

import { summarize } from './stats.mjs';

// --- Fixture-acceptance calibration band (§5.3) ------------------------------
// A contradiction pair supersedes the older fact via one of two production paths:
//   • write-time in-band: a dedup embedding hit in [0.84, 0.95] → judge → supersede.
//   • session-end detector: retrieves candidates at cosine >= 0.45 → judge → supersede.
// So the healthy firing range is [0.45, 0.95]. Above 0.95 a confident duplicate is
// kept-older (DEDUP_MERGED, no supersede); below 0.45 it is never retrieved. The
// keyed baseline (2026-06-26) confirmed these chains fire predominantly via the
// DETECTOR path (sub-0.84), so the lower bound is the detector retrieval floor, NOT
// the in-band dedup floor — calibrating against [0.84, 0.95] flagged every valid
// chain as out-of-band (a false alarm). Mirrors #14's keyed isInert recalibration.
export const CALIB_DETECTOR_FLOOR = 0.45;  // UM_AUTOSUPERSEDE_RETRIEVAL_THRESHOLD (D3.3)
export const CALIB_INBAND_FLOOR = 0.84;    // dedup embedding threshold (in-band path floor)
export const CALIB_DEDUP_CEILING = 0.95;   // contradictionBandCeiling (above → keep-older, no supersede)

/**
 * Classify a chain pair's adjacent cosine for the fixture-acceptance gate.
 * `fires` is true when the pair will supersede via EITHER path (in-band or detector);
 * only `dedup-risk` (> ceiling) and `no-fire` (< detector floor) are problematic.
 * @param {number} cos adjacent-pair cosine
 * @returns {{band:'dedup-risk'|'inband'|'detector'|'no-fire', fires:boolean}}
 */
export function calibrationBand(cos) {
  if (cos > CALIB_DEDUP_CEILING) return { band: 'dedup-risk', fires: false };
  if (cos >= CALIB_INBAND_FLOOR) return { band: 'inband', fires: true };
  if (cos >= CALIB_DETECTOR_FLOOR) return { band: 'detector', fires: true };
  return { band: 'no-fire', fires: false };
}

/**
 * Status-level chain purity at one depth.
 * @param {Record<number,'current'|'superseded'>} chainStatuses status per seeded factIdx (0..latestIdx)
 * @param {number} latestIdx the just-seeded fact's index (= depth-1)
 * @returns {{staleSurvivors:number, latestCurrent:boolean, latestOnly:boolean}}
 */
export function chainPurity(chainStatuses, latestIdx) {
  let staleSurvivors = 0;
  for (let i = 0; i < latestIdx; i++) if (chainStatuses[i] === 'current') staleSurvivors++;
  const latestCurrent = chainStatuses[latestIdx] === 'current';
  return { staleSurvivors, latestCurrent, latestOnly: staleSurvivors === 0 && latestCurrent };
}

/**
 * Retrieval-level purity at one depth — identical definition for UM and mem0.
 * @param {string[]} resultBodies normalized top-K result bodies, in rank order
 * @param {string[]} chainFacts normalized full chain facts
 * @param {number} depth facts[0..depth-1] are seeded; latest = chainFacts[depth-1]
 */
export function retrievalPurity(resultBodies, chainFacts, depth) {
  const latest = chainFacts[depth - 1];
  const present = new Set(resultBodies);
  let staleSurfaced = 0;
  for (let i = 0; i < depth - 1; i++) if (present.has(chainFacts[i])) staleSurfaced++;
  const latestSurfaced = present.has(latest);
  const latestTop1 = resultBodies[0] === latest;
  return { staleSurfaced, latestSurfaced, latestTop1, onlyCurrent: latestSurfaced && staleSurfaced === 0 };
}

/** Store-growth depth: cycles that actually added a distinct point. */
export function effectiveDepth(perCycleEvents) {
  return perCycleEvents.length - perCycleEvents.filter((c) => c.event === 'DEDUP_MERGED').length;
}

/** Engagement depth: cycles that actually exercised supersession (a per-chain scalar). */
export function engagedDepth(perCycleEvents) {
  return perCycleEvents.filter((c) => c.fired === true).length;
}

/**
 * §5.7 identity: expected stale survivors at depth d = #non-firing cycles in [2..d].
 * @param {boolean[]} perCycleFired 0-based by cycle (cycle i → perCycleFired[i-1]); cycle 1 never fires
 * @param {number} depth
 */
export function expectedStaleSurvivors(perCycleFired, depth) {
  let n = 0;
  for (let cycle = 2; cycle <= depth; cycle++) if (perCycleFired[cycle - 1] !== true) n++;
  return n;
}

/** Identity violations: where measured staleSurvivors ≠ the §5.7 expectation. */
export function survivorIdentityViolations(perCycleFired, snapshots) {
  const out = [];
  for (const s of snapshots) {
    const expected = expectedStaleSurvivors(perCycleFired, s.depth);
    if (s.staleSurvivors !== expected) out.push({ depth: s.depth, expected, actual: s.staleSurvivors });
  }
  return out;
}

/**
 * Count points that transition superseded → current as depth increases (sticky-tombstone
 * violation; architecturally expected 0). Needs the full per-depth status vector per chain.
 * @param {Array<{depth:number, pointStatuses:Record<number,'current'|'superseded'>}>} perDepthStatusVectors
 */
export function resurrectionScan(perDepthStatusVectors) {
  const ordered = [...perDepthStatusVectors].sort((a, b) => a.depth - b.depth);
  const everSuperseded = new Set();
  let resurrections = 0;
  for (const { pointStatuses } of ordered) {
    for (const [idx, status] of Object.entries(pointStatuses)) {
      if (status === 'superseded') everSuperseded.add(idx);
      else if (status === 'current' && everSuperseded.has(idx)) { resurrections++; everSuperseded.delete(idx); }
    }
  }
  return resurrections;
}

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const rate = (xs) => mean(xs.map((b) => (b ? 1 : 0)));

/**
 * Per-depth aggregate across chains. Retrieval-level for both arms; UM adds status-level.
 * @param {Array<{snapshots:Array<object>}>} perChainSnapshots
 * @param {'um'|'mem0'} arm
 */
export function aggregateRotByDepth(perChainSnapshots, arm) {
  const byDepth = new Map();
  for (const chain of perChainSnapshots) {
    for (const s of chain.snapshots) {
      if (!byDepth.has(s.depth)) byDepth.set(s.depth, []);
      byDepth.get(s.depth).push(s);
    }
  }
  const out = [];
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const ss = byDepth.get(depth);
    const row = {
      depth,
      onlyCurrentRate: rate(ss.map((s) => s.retrieval.onlyCurrent)),
      meanStaleSurfaced: mean(ss.map((s) => s.retrieval.staleSurfaced)),
      latestTop1Rate: rate(ss.map((s) => s.retrieval.latestTop1)), // mem0: noise-floor (caller excludes from gap)
    };
    if (arm === 'um') {
      row.statusLatestOnlyRate = rate(ss.map((s) => s.staleSurvivors === 0 && s.latestCurrent));
      row.meanStaleSurvivors = mean(ss.map((s) => s.staleSurvivors));
    }
    out.push(row);
  }
  return out;
}

/** Differentiator series: UM advantage per depth (retrieval-level, apples-to-apples). */
export function gapByDepth(umAgg, mem0Agg) {
  const m = new Map(mem0Agg.map((r) => [r.depth, r]));
  return umAgg.map((u) => {
    const mm = m.get(u.depth) ?? { onlyCurrentRate: 0, meanStaleSurfaced: 0 };
    return {
      depth: u.depth,
      onlyCurrentGap: u.onlyCurrentRate - mm.onlyCurrentRate,
      staleSurfacedGap: mm.meanStaleSurfaced - u.meanStaleSurfaced,
    };
  });
}

/**
 * Per-rung trust gate: depth d (≥2) is VALID only if the cycle-d fired rate ≥ threshold.
 * Depth 1 is always valid (no contradiction yet). Keys on the per-depth rate, never engagedDepth.
 * @param {number[]} fireRateByCycle cycle d → fireRateByCycle[d-1]
 */
export function rungValidity(fireRateByCycle, threshold = 0.8) {
  return fireRateByCycle.map((fr, i) => {
    const depth = i + 1;
    if (depth === 1) return { depth, fireRate: null, valid: true };
    return { depth, fireRate: fr, valid: fr >= threshold };
  });
}

/**
 * Per-cycle judge-confidence distribution (DETECTOR-PATH cycles only — the in-band path
 * does not return its confidence). Cycle index → summarize(p50, p95).
 * @param {number[][]} perCycleJudge perCycleJudge[i] = confidences observed at cycle i+1
 */
export function judgeConfidenceByCycle(perCycleJudge) {
  return perCycleJudge.map((samples, i) => ({
    cycle: i + 1,
    ...summarize(samples, [['p50', 0.5], ['p95', 0.95]]),
  }));
}

const f2 = (x) => (x == null ? ' n/a' : Number(x).toFixed(2));

/**
 * Pure render of result.rotSweep: one row per depth. fired@d / judgeConf read cycle d = depth d
 * (fireRateByCycle[d-1] / judgeConfByCycle[d-1]). Back-compat-guarded + null-tolerant.
 */
export function formatRotSweep(result) {
  const rs = result?.rotSweep;
  if (!rs) return '';
  const um = new Map((rs.arms?.um?.byDepth ?? []).map((r) => [r.depth, r]));
  const mem0 = new Map((rs.arms?.mem0?.byDepth ?? []).map((r) => [r.depth, r]));
  const gap = new Map((rs.gapByDepth ?? []).map((r) => [r.depth, r]));
  const valid = new Map((rs.diagnostics?.validity ?? []).map((r) => [r.depth, r.valid]));
  const fire = rs.diagnostics?.fireRateByCycle ?? [];
  const conf = rs.diagnostics?.judgeConfByCycle ?? [];
  const lines = [];
  lines.push('=== memory rot — purity vs depth (UM vs raw mem0) ===');
  lines.push('depth | UM onlyCur UM staleSurf UM rec@1 UM statusOnly | mem0 onlyCur mem0 staleSurf mem0 rec@1(noise) | gap | fired@d judgeConf-p50 | rung');
  for (const depth of rs.depths) {
    const u = um.get(depth) ?? {}; const m = mem0.get(depth) ?? {}; const g = gap.get(depth) ?? {};
    const firedD = depth >= 2 ? fire[depth - 1] : null;
    const confD = conf[depth - 1]?.p50 ?? null;
    const rung = depth === 1 ? '-' : (valid.get(depth) === false ? 'INVALID' : 'ok');
    lines.push([
      String(depth),
      f2(u.onlyCurrentRate), f2(u.meanStaleSurfaced), f2(u.latestTop1Rate), f2(u.statusLatestOnlyRate),
      '|', f2(m.onlyCurrentRate), f2(m.meanStaleSurfaced), f2(m.latestTop1Rate),
      '|', f2(g.onlyCurrentGap),
      '|', f2(firedD), f2(confD), '|', rung,
    ].join(' '));
  }
  lines.push(`resurrections=${rs.diagnostics?.resurrectionCount ?? 'n/a'} | chains=${rs.chainCount}`);
  return lines.join('\n');
}
