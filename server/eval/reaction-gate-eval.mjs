/**
 * server/eval/reaction-gate-eval.mjs — #215: the pre-registered reaction-salience
 * gate measurement harness.
 *
 * Pre-registration: server/eval/reaction-gate-accept-rule.md (FROZEN v5, anchored
 * at server/eval/accept-rule-215.sha256, commit f49e62f). This harness implements
 * the frozen rule mechanically. H1 is REAL and fail-closed (#188 §10.5.5: the
 * claimed enforcement was never built there — here it runs before anything else
 * and is test-gated). Staged computation (rule R4) is structural: d is computed
 * without touching outcomes, q2 without q1, and every abort returns before the
 * next stage's quantities exist.
 *
 * Phase-1 posture: every function is injectable/pure and TDD'd against synthetic
 * fixtures (server/test/reaction-gate-eval.test.mjs). No live reads happen in
 * this file except through injected handles (sqlite path, qdrant client, probe
 * fn) — the phase-2 run wires real ones per the plan runbook.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// ─── Frozen constants (mirrors of rule R1-R5; the rule file is normative) ────
export const W_START = '2026-08-01T00:00:00.000Z';
export const MATURITY_DAYS = 7;
export const SCOPE_SURFACE = 'mem0-compat';
export const SEED_RUN1 = 20260801;
export const SEED_RUN2 = 20260802;
export const PERM_ITERATIONS = 10_000;
export const TRIGGER_TA = 20;
export const TRIGGER_TB_FLOOR = 10;
export const TB_DATE = '2026-11-01';
export const FACT_FLOOR = 30;
export const D_ABORT = 0.25;
export const Q2_CEILING = 0.75;
export const G1_HEADROOM = 0.25;
export const G2_ALPHA = 0.05;
export const H2_EXCL_CAP = 0.10;
export const H2_DIFF_CAP = 0.05;
export const STORE_WORTHY = new Set(['D', 'U']);
export const AUTHORED_EVENTS = new Set(['ADD', 'SUPERSEDED_INBAND']);

// ─── H1 — anchor check (fail-closed; runs before everything) ─────────────────
export function verifyAnchor({ rulePath, anchorPath }) {
  let anchorLine;
  try {
    anchorLine = readFileSync(anchorPath, 'utf8').trim();
  } catch {
    return { ok: false, reason: `anchor missing: ${anchorPath}` };
  }
  let ruleBytes;
  try {
    ruleBytes = readFileSync(rulePath);
  } catch {
    return { ok: false, reason: `rule file missing: ${rulePath}` };
  }
  const expected = anchorLine.split(/\s+/)[0];
  const actual = createHash('sha256').update(ruleBytes).digest('hex');
  if (actual !== expected) {
    return { ok: false, reason: `accept-rule hash mismatch: local ${actual} != anchored ${expected} — refusing to emit any verdict` };
  }
  return { ok: true };
}

// ─── Deterministic PRNG + helpers ────────────────────────────────────────────
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(arr, seed) {
  const rand = typeof seed === 'function' ? seed : mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** ISO-8601 week label 'YYYY-Www' for an ISO datetime string (UTC). */
export function isoWeek(iso) {
  const d = new Date(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;            // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day);    // nearest Thursday
  const year = t.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ─── Snapshot reader (readonly) ──────────────────────────────────────────────
export function readSnapshot(dbPath) {
  const Database = require('better-sqlite3');
  const d = new Database(dbPath, { readonly: true });
  try {
    const table = (name, sql) => {
      try { return d.prepare(sql).all(); }
      catch (err) { if (/no such table/.test(String(err?.message))) return []; throw err; }
    };
    return {
      ledger: table('capture_ledger', 'SELECT * FROM capture_ledger ORDER BY created_at ASC'),
      reactions: table('reaction_state', 'SELECT * FROM reaction_state'),
      tally: table('exchange_tally', 'SELECT * FROM exchange_tally'),
    };
  } finally {
    d.close();
  }
}

// ─── Frame + predictor + strata (rule R1) ────────────────────────────────────
function inFrame(createdAt, wStart, frameEnd) {
  return createdAt >= wStart && createdAt <= frameEnd;
}

export function frameEndOf(tFreeze, maturityDays = MATURITY_DAYS) {
  return new Date(Date.parse(tFreeze) - maturityDays * 86400000).toISOString();
}

export function classifyStrata({ ledger, reactions, tFreeze, wStart = W_START, maturityDays = MATURITY_DAYS, surface = SCOPE_SURFACE, userId }) {
  const frameEnd = frameEndOf(tFreeze, maturityDays);
  const sumByCapture = new Map();
  for (const r of reactions) {
    sumByCapture.set(r.capture_id, (sumByCapture.get(r.capture_id) ?? 0) + r.count);
  }
  const predictorOf = (row) => {
    if (!sumByCapture.has(row.capture_id)) return 'unreacted';
    return sumByCapture.get(row.capture_id) >= 1 ? 'reacted' : 'zeroed';
  };

  const s1 = []; const s2Pool = []; const s3 = [];
  let s4Count = 0; let nZeroed = 0; let unscopedReactedCount = 0;
  for (const row of ledger) {
    if (!inFrame(row.created_at, wStart, frameEnd)) continue;
    const p = predictorOf(row);
    if (p === 'reacted') unscopedReactedCount += 1;
    const scoped = row.surface === surface && row.user_id === userId;
    if (!scoped) continue;
    if (p === 'zeroed') { nZeroed += 1; continue; }   // unreacted for base rates; never a control
    if (row.verdict === 'stored') {
      if (p === 'reacted') s1.push(row); else s2Pool.push(row);
    } else if (row.verdict === 'abstained') {
      if (p === 'reacted') s3.push(row); else s4Count += 1;
    }
  }
  return { s1, s2Pool, s3, s4Count, nZeroed, frameEnd, unscopedReactedCount, scopedReactedCount: s1.length + s3.length };
}

// ─── R1 scope guard + R2 trigger ─────────────────────────────────────────────
export function evaluateTrigger({ scopedReacted, scopedS1, pool, unscopedReacted, checkDate }) {
  const tb = checkDate.slice(0, 10) >= TB_DATE;
  const arm = tb ? TRIGGER_TB_FLOOR : TRIGGER_TA;
  if (unscopedReacted >= arm && scopedReacted < arm) {
    return { decision: 'SCOPING-ARTIFACT', detail: `unscoped ${unscopedReacted} meets the arm (${arm}) while scoped ${scopedReacted} does not — pre-outcome abort, never PARK-SPARSE` };
  }
  if (scopedS1 >= TRIGGER_TA && pool >= scopedS1) return { decision: 'RUN', arm: 'T-A' };
  if (tb) {
    if (scopedS1 >= TRIGGER_TB_FLOOR && pool >= scopedS1) return { decision: 'RUN', arm: 'T-B' };
    if (scopedS1 < TRIGGER_TB_FLOOR && unscopedReacted < TRIGGER_TB_FLOOR) return { decision: 'PARK-SPARSE' };
    return { decision: 'WAIT', detail: 'T-B volume met but pool condition failed — stage-2-abort-equivalent, re-arm as T-B' };
  }
  return { decision: 'WAIT' };
}

// ─── Denominators (H4 by construction: ledger + tally rows are the ONLY data
//     inputs — no counters table is ever read; the negative-control test pins it)
export function denominators({ ledger, tally, reactions, tFreeze, wStart = W_START, maturityDays = MATURITY_DAYS, surface = SCOPE_SURFACE, userId }) {
  const frameEnd = frameEndOf(tFreeze, maturityDays);
  const frameEndDay = frameEnd.slice(0, 10);
  const wStartDay = wStart.slice(0, 10);
  const reacted = new Set();
  const sums = new Map();
  for (const r of reactions) sums.set(r.capture_id, (sums.get(r.capture_id) ?? 0) + r.count);
  for (const [cid, s] of sums) if (s >= 1) reacted.add(cid);

  const out = { stored: { reacted: 0, unreacted: 0 }, abstained: { reacted: 0, unreacted: 0 } };
  for (const row of ledger) {
    if (row.surface !== surface || row.user_id !== userId) continue;
    if (!inFrame(row.created_at, wStart, frameEnd)) continue;
    const bucket = out[row.verdict];
    if (!bucket) continue;
    if (reacted.has(row.capture_id)) bucket.reacted += 1; else bucket.unreacted += 1;
  }
  for (const t of tally) {
    if (t.surface !== surface || t.user_id !== userId) continue;
    if (t.day < wStartDay || t.day > frameEndDay) continue;
    if (out[t.verdict]) out[t.verdict].unreacted += t.count;   // pruned rows are unreacted by construction
  }
  return out;
}

// ─── H5 — retention detector + mechanical frame excision ─────────────────────
export function retentionDetector({ tally, tFreeze, wStart = W_START, maturityDays = MATURITY_DAYS, surface = SCOPE_SURFACE, userId }) {
  const frameEndDay = frameEndOf(tFreeze, maturityDays).slice(0, 10);
  const wStartDay = wStart.slice(0, 10);
  const inFrameTally = tally.filter((t) =>
    t.surface === surface && t.user_id === userId &&
    t.day >= wStartDay && t.day <= frameEndDay &&
    (t.verdict === 'stored' || t.verdict === 'abstained'));
  if (inFrameTally.length === 0) return { ok: true };
  const lastDay = inFrameTally.map((t) => t.day).sort().at(-1);
  const wStartPrime = `${lastDay}T00:00:00.000Z`;
  return {
    ok: false,
    lastInFrameTallyDay: lastDay,
    wStartPrime: new Date(Date.parse(wStartPrime) + 86400000).toISOString(),
  };
}

// ─── Attribution (rule R1: event-based; heuristic fallback for eventless rows) ─
export function buildEarliestRefIndex(ledger) {
  const earliest = new Map();  // pointId → capture_id of the EARLIEST row referencing it
  const sorted = ledger.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  for (const row of sorted) {
    let refs;
    try { refs = JSON.parse(row.point_refs); } catch { continue; }
    for (const ref of refs) {
      if (!earliest.has(ref.id)) earliest.set(ref.id, row.capture_id);
    }
  }
  return earliest;
}

const HOUR_MS = 3_600_000;

export function attributeRefs({ row, pointsById, earliestRefIndex }) {
  let refs;
  try { refs = JSON.parse(row.point_refs); } catch { refs = []; }
  return refs.map((ref) => {
    if (typeof ref.event === 'string') {
      return { ...ref, mode: 'event', cls: AUTHORED_EVENTS.has(ref.event) ? 'authored' : 'inherited' };
    }
    // Heuristic (pre-v1.13.2 rows): earliest-referencing-row AND payload
    // createdAt within ±1h of the exchange.
    const point = pointsById.get(ref.id);
    const earliestOk = earliestRefIndex.get(ref.id) === row.capture_id;
    const createdAt = point?.payload?.createdAt;
    const windowOk = typeof createdAt === 'string' &&
      Math.abs(Date.parse(createdAt) - Date.parse(row.created_at)) <= HOUR_MS;
    return { ...ref, mode: 'heuristic', cls: earliestOk && windowOk ? 'authored' : 'inherited' };
  });
}

// ─── Control draw (rule R3: seeded, ISO-week stratified 2×) ─────────────────
export function drawControls({ s1, s2Pool, seed = SEED_RUN1 }) {
  const byWeek = new Map();
  for (const row of s1) {
    const w = isoWeek(row.created_at);
    byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
  }
  const s2 = []; const perWeek = [];
  // Deterministic iteration: weeks sorted; pool sorted by created_at then id
  // before the seeded shuffle so the draw is a pure function of (data, seed).
  for (const week of [...byWeek.keys()].sort()) {
    const n1w = byWeek.get(week);
    const pool = s2Pool
      .filter((r) => isoWeek(r.created_at) === week)
      .sort((a, b) => (a.created_at + a.capture_id < b.created_at + b.capture_id ? -1 : 1));
    const want = Math.round(2 * n1w);
    const drawn = seededShuffle(pool, seed + hashWeek(week)).slice(0, Math.min(want, pool.length));
    s2.push(...drawn);
    perWeek.push({ week, n1w, poolW: pool.length, drawn: drawn.length });
  }
  return { s2, perWeek };
}

function hashWeek(week) {
  let h = 0;
  for (const c of week) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h >>> 0;
}

// ─── Point resolution (H2/H2b) — read-only; never persists ids back ──────────
export async function resolvePoints({ refsByExchange, client, collection, userId, md5Fn }) {
  const md5 = md5Fn ?? ((s) => createHash('md5').update(s).digest('hex'));
  const allIds = [...new Set([...refsByExchange.values()].flat().map((r) => r.id))];
  const found = new Map((await client.retrieve(collection, { ids: allIds, with_payload: true }))
    .map((p) => [p.id, p]));

  const resolved = new Map();   // exchange capture_id → [{ref, point}]
  let excluded = 0; let total = 0; const h2bViolations = [];
  for (const [captureId, refs] of refsByExchange) {
    const out = [];
    for (const ref of refs) {
      total += 1;
      let point = found.get(ref.id);
      if (!point) {
        // Read-only (userId, hash) re-resolution — reindex repair path.
        const res = await client.scroll(collection, {
          filter: { must: [{ key: 'userId', match: { value: userId } }, { key: 'hash', match: { value: ref.hash } }] },
          limit: 2, with_payload: true,
        });
        point = res?.points?.[0];
      }
      if (!point) { excluded += 1; continue; }
      const p = point.payload ?? {};
      if (p.hash !== ref.hash || md5(String(p.data ?? '')) !== p.hash) {
        h2bViolations.push({ captureId, id: ref.id });
        continue;
      }
      out.push({ ref, point });
    }
    resolved.set(captureId, out);
  }
  return { resolved, excludedFraction: total === 0 ? 0 : excluded / total, h2bViolations, totalRefs: total };
}

export function h2Gate({ exclS1, exclS2 }) {
  const ok = exclS1 <= H2_EXCL_CAP && exclS2 <= H2_EXCL_CAP && Math.abs(exclS1 - exclS2) <= H2_DIFF_CAP;
  return { ok, exclS1, exclS2, differential: Math.abs(exclS1 - exclS2) };
}

// ─── H3 — id-space precondition + stratified read-path probes ────────────────
export function h3aPrecondition(points) {
  const violations = points.filter((p) => (p.payload ?? {}).id !== undefined).map((p) => p.id);
  return { ok: violations.length === 0, violations };
}

export async function h3bProbes({ strata, probeFn, seed = SEED_RUN1 }) {
  const results = {};
  let ok = true;
  for (const [name, points] of Object.entries(strata)) {
    if (points.length === 0) {                      // empty stratum = FAIL, never a silent pass
      results[name] = { ok: false, reason: 'empty probe stratum' };
      ok = false;
      continue;
    }
    const picks = seededShuffle(points, seed).slice(0, Math.min(10, points.length));
    let misses = 0;
    for (const p of picks) {
      const hits = await probeFn(String(p.payload?.data ?? ''));
      const top3 = hits.slice(0, 3).map((h) => h.id);
      if (!top3.includes(p.id)) misses += 1;
    }
    const pass = misses <= 1;                       // at most 1 miss per stratum (rule R7)
    results[name] = { ok: pass, probed: picks.length, misses };
    if (!pass) ok = false;
  }
  return { ok, results };
}

// ─── G2 — within-week permutation test (rule R5) ─────────────────────────────
function pooledDiff(exchanges) {
  let k1 = 0; let n1 = 0; let k2 = 0; let n2 = 0;
  for (const e of exchanges) {
    for (const sw of e.facts) {
      if (e.arm === 'S1') { n1 += 1; if (sw) k1 += 1; }
      else { n2 += 1; if (sw) k2 += 1; }
    }
  }
  if (n1 === 0 || n2 === 0) return 0;               // defensive convention (unreachable under R3 floors)
  return k1 / n1 - k2 / n2;
}

export function permutationTest({ exchanges, iterations = PERM_ITERATIONS, seed = SEED_RUN1 }) {
  const observed = pooledDiff(exchanges);
  const byWeek = new Map();
  for (const e of exchanges) {
    if (!byWeek.has(e.week)) byWeek.set(e.week, []);
    byWeek.get(e.week).push(e);
  }
  const rand = mulberry32(seed);
  let atLeast = 0;
  for (let i = 0; i < iterations; i++) {
    const replicate = [];
    for (const group of byWeek.values()) {
      const arms = seededShuffle(group.map((e) => e.arm), rand);   // within-week label shuffle, counts preserved
      group.forEach((e, idx) => replicate.push({ ...e, arm: arms[idx] }));
    }
    if (pooledDiff(replicate) >= observed) atLeast += 1;
  }
  return { observed, p: (1 + atLeast) / (iterations + 1) };
}

// ─── Small stats ─────────────────────────────────────────────────────────────
export function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n; const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export function g1Pass(q1, q2) {
  return q1 - q2 >= G1_HEADROOM * (1 - q2) - 1e-12;
}

// ─── R4 stages 5-7 + R5 ordered mapping — structural staging ─────────────────
/**
 * items: [{ item_id, arm: 'S1'|'S2' }]; pass1/pass2/adjudicated: Map item_id →
 * label (enum). permThunk() → { p } computed ONLY if stage 7 is reached.
 * repairUsed: true on the second (post-G3-repair) labeling.
 * Structural staging: each stage's quantities are computed only after every
 * earlier stage passed; aborts return with later-stage fields ABSENT.
 */
export function evaluateStaged({ items, pass1, pass2, adjudicated, permThunk, repairUsed = false }) {
  // Stage 5 — d alone.
  let disagree = 0;
  for (const it of items) {
    const b1 = STORE_WORTHY.has(pass1.get(it.item_id));
    const b2 = STORE_WORTHY.has(pass2.get(it.item_id));
    if (b1 !== b2) disagree += 1;
  }
  const d = items.length === 0 ? 0 : disagree / items.length;
  if (d > D_ABORT) {
    return repairUsed
      ? { stage: 5, outcome: 'PARK-INSTRUMENT', d, terminal: true }
      : { stage: 5, outcome: 'G3_ABORT_REPAIR_PERMITTED', d, terminal: false };
  }

  // Stage 6 — q2 alone.
  const armFacts = (arm) => items.filter((it) => it.arm === arm);
  const rate = (rows) => {
    if (rows.length === 0) return 0;
    return rows.filter((it) => STORE_WORTHY.has(adjudicated.get(it.item_id))).length / rows.length;
  };
  const q2 = rate(armFacts('S2'));
  if (q2 >= Q2_CEILING) {
    return { stage: 6, outcome: 'ABORT-INSTRUMENT', d, q2, terminal: true };
  }

  // Stage 7 — contrast + gates + ordered mapping (R5).
  const q1 = rate(armFacts('S1'));
  const diff = q1 - q2;
  const { p, observed } = permThunk();
  const g1 = g1Pass(q1, q2);
  const g2 = p <= G2_ALPHA;
  let outcome;
  if (g1 && g2) outcome = 'FLIP-SPEC';
  else if (diff <= 0) outcome = 'PARK-NEGATIVE';
  else outcome = 'PARK-INCONCLUSIVE';
  return { stage: 7, outcome, d, q1, q2, diff, p, observed, g1, g2, capConsumed: true };
}

// ─── Blind item emission (rule R6) ───────────────────────────────────────────
const FORBIDDEN_ITEM_FIELDS = ['reaction', 'verdict', 'capture', 'created', 'arm', 'stratum', 'surface', 'week'];

export function emitItems({ facts, seed = SEED_RUN1 }) {
  // facts: [{ item_id, text }] — the caller derives item_id from the point id
  // via a keyed hash so items cannot be joined back to strata by eye. The
  // forbidden-field check runs on the INPUT (a caller smuggling predictor or
  // stratum context must fail loudly, not be silently stripped).
  for (const fact of facts) {
    for (const k of Object.keys(fact)) {
      if (FORBIDDEN_ITEM_FIELDS.some((f) => k.toLowerCase().includes(f))) {
        throw new Error(`emitItems: forbidden field ${k} — item files must be predictor/stratum-blind`);
      }
    }
  }
  return seededShuffle(facts.map(({ item_id, text }) => ({ item_id, text })), seed);
}

export function blindItemId(pointId, salt) {
  return createHash('sha256').update(`${salt}:${pointId}`).digest('hex').slice(0, 12);
}

// ─── CLI (phase 2 wiring; H1 first, always) ──────────────────────────────────
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };

async function main() {
  const rulePath = arg('rule', fileURLToPath(new URL('./reaction-gate-accept-rule.md', import.meta.url)));
  const anchorPath = arg('anchor', fileURLToPath(new URL('./accept-rule-215.sha256', import.meta.url)));
  const h1 = verifyAnchor({ rulePath, anchorPath });
  if (!h1.ok) {
    console.error(`H1 REFUSE: ${h1.reason}`);
    process.exit(2);
  }
  console.log('H1 ok — accept-rule hash matches the committed anchor.');
  console.log('Phase-2 wiring (snapshot/qdrant/probe handles) runs per the plan runbook; this CLI intentionally does nothing further in phase 1.');
}

if (process.argv[1] && process.argv[1].endsWith('reaction-gate-eval.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
