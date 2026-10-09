// server/eval/lib/exact-token-203-score.mjs — #203 (spec D5, D6, D8; plan T6):
// the scoring pieces of server/eval/exact-token-203.mjs — recall over projected
// ids, the controls (C1 scramble, C2 derangement, C3 seed hold-out), the paired
// bootstrap, the verdict with its downgrades and required controls, and the
// allowlisted aggregate writer. Pure except the writer; every parameter comes
// from the loaded rule.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record):
//
// • ORDER (D6, D8): every input to decideVerdict — Δ, its CI, C1, C2, C3, the
//   thinning and floor inputs — is computed before it runs, so nothing `score`
//   executes before its final write depends on the outcome. decideVerdict then
//   applies, in order: rule 1 (VOID guards), rules 2–5 (candidate), rules 6–7
//   (thinning / discrimination floor → INCONCLUSIVE, NO-GAP and REVERSE only),
//   the C3 label (GAP → GAP (seed-carried)), and last the controls the FINAL
//   label requires (GAP / seed-carried → C2; REVERSE → C1; NO-GAP and
//   INCONCLUSIVE → both). A failing required control is VOID.
//
// • THE WRITER IS AN ALLOWLIST: every key must be named by the schema and every
//   string must come from a fixed vocabulary or a fixed pattern (hashes, ISO
//   times, the rule's model ids). No identifier, gloss, doc id or prompt text
//   can be written through it, whatever a caller passes. Its errors name the
//   schema path only, never the offending value.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { prng, seededShuffle } from './exact-token-203-random.mjs';
import { IDENTIFIER_CLASSES } from './exact-token-203-build.mjs';
import { D10_BRANCHES, PREVALENCE_SIDES } from './query-shape-census.mjs';

export { prng, seededShuffle };

export const VERDICTS = Object.freeze(['GAP', 'GAP (seed-carried)', 'NO-GAP', 'REVERSE', 'INCONCLUSIVE', 'VOID']);
export const DOWNGRADES = Object.freeze(['class-thinning', 'discrimination-floor', 'seed-carried']);
export const RESULT_SCHEMA_ID = 'exact-token-203-result/1';

/** Order-preserving distinct ids (recall is over distinct projected ids). */
export function dedupe(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/** 1 when any of the first k (distinct) ranked ids is relevant, else 0. */
export const recallAt = (ranked, relevant, k) => (ranked.slice(0, k).some((id) => relevant.includes(id)) ? 1 : 0);
export const reciprocalRank = (ranked, relevant) => {
  const i = ranked.findIndex((id) => relevant.includes(id));
  return i < 0 ? 0 : 1 / (i + 1);
};
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

/**
 * C1's shape-preserving scramble: letters → letters (case kept), digits →
 * digits, everything else kept; seeded per identifier; never the original.
 */
export function scramble(identifier, seedHex) {
  if (!/[A-Za-z0-9]/.test(identifier)) return identifier;
  const r = prng(seedHex, `scramble:${identifier}`);
  const pick = (alphabet) => alphabet[Math.floor(r() * alphabet.length)];
  for (;;) {
    let out = '';
    for (const ch of identifier) {
      if (ch >= 'A' && ch <= 'Z') out += pick(UPPER);
      else if (ch >= 'a' && ch <= 'z') out += pick(LOWER);
      else if (ch >= '0' && ch <= '9') out += pick(DIGITS);
      else out += ch;
    }
    if (out !== identifier) return out;
  }
}

/**
 * C2's seeded derangement: a permutation p with p[i] !== i and disjoint
 * relevant sets for every pair (randomised greedy with seeded restarts).
 * @returns {number[] | null} null when none was found within maxAttempts
 */
export function derange(relevantSets, seedHex, maxAttempts) {
  const n = relevantSets.length;
  if (n < 2) return null;
  const sets = relevantSets.map((s) => new Set(s));
  const disjoint = (i, j) => ![...sets[i]].some((x) => sets[j].has(x));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const r = prng(seedHex, `derangement:${attempt}`);
    const order = seededShuffle([...Array(n).keys()], seedHex, `derangement-order:${attempt}`);
    const free = new Set(order);
    const p = new Array(n);
    let ok = true;
    for (const i of order) {
      const cands = [...free].filter((j) => j !== i && disjoint(i, j));
      if (!cands.length) { ok = false; break; }
      const j = cands[Math.floor(r() * cands.length)];
      p[i] = j;
      free.delete(j);
    }
    if (ok) return p;
  }
  return null;
}

function bootstrapMeans(values, resamples, seedHex, label) {
  const n = values.length;
  const r = prng(seedHex, `bootstrap:${label}`);
  const means = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(r() * n)];
    means[b] = s / n;
  }
  return means.sort();
}

/** Paired-bootstrap percentile CI of the mean (two-sided, `level`). */
export function bootstrapCI(values, { resamples, level, seedHex, label }) {
  if (!values.length) return { lower: null, upper: null, mean: null };
  const means = bootstrapMeans(values, resamples, seedHex, label);
  const tail = (1 - level) / 2;
  const lo = Math.min(resamples - 1, Math.floor(tail * resamples + 1e-9));
  const hi = Math.max(0, Math.ceil((1 - tail) * resamples - 1e-9) - 1);
  return { lower: means[lo], upper: means[hi], mean: mean(values) };
}

/** One-sided lower bound of the mean at `level` (C3). */
export function bootstrapLowerBound(values, { resamples, level, seedHex, label }) {
  if (!values.length) return null;
  const means = bootstrapMeans(values, resamples, seedHex, label);
  return means[Math.min(resamples - 1, Math.floor((1 - level) * resamples + 1e-9))];
}

/**
 * C3 (D6): on rows whose relevant set holds an isDoc doc other than the seed,
 * remove the seed from both ranked lists BEFORE the top-k cut and from the
 * relevant set, then score both arms again. Ineligible rows are skipped.
 * @param {{ seed_id, relevant, c3_eligible, ranked: { exact: string[], words: string[] } }[]} rows
 */
export function heldOutDeltas(rows, k) {
  const deltas = [];
  for (const r of rows) {
    if (!r.c3_eligible) continue;
    const rel = r.relevant.filter((id) => id !== r.seed_id);
    const drop = (ids) => ids.filter((id) => id !== r.seed_id);
    deltas.push(recallAt(drop(r.ranked.words), rel, k) - recallAt(drop(r.ranked.exact), rel, k));
  }
  return { eligible: deltas.length, deltas };
}

/**
 * D8 rule 6: on doc rows with df ≤ max_df, counted BEFORE the single-project
 * filter, a class with ≥ min_class_rows rows that keeps fewer than
 * min_kept_fraction of them (as non-excluded primary rows) triggers thinning.
 */
export function classThinning(rows, rule) {
  const t = rule.verdict.class_thinning;
  const by = {};
  for (const r of rows) {
    if (r.stratum !== 'doc' || r.df > rule.population.max_df) continue;
    const b = (by[r.class] ??= { n: 0, kept: 0 });
    b.n++;
    if (r.role === 'primary' && !r.exclusion) b.kept++;
  }
  const classes = Object.keys(by).filter((c) => by[c].n >= t.min_class_rows && by[c].kept / by[c].n < t.min_kept_fraction).sort();
  return { triggered: classes.length > 0, classes };
}

/** D6: the controls a final label relies on. */
export function requiredControlsFor(verdict) {
  switch (verdict) {
    case 'GAP':
    case 'GAP (seed-carried)':
      return ['c2'];
    case 'REVERSE':
      return ['c1'];
    case 'NO-GAP':
    case 'INCONCLUSIVE':
      return ['c1', 'c2'];
    default:
      return [];
  }
}

/**
 * The verdict (D8 with D6's controls and C3 label). Every input is computed
 * before this runs.
 * @param {{ guards: { probeOk, idSpaceOk, plantCodes: string[], exclusionFraction: number,
 *   passDisagreement: { exact: number, words: number } | null },
 *   delta, ci: { lower, upper }, recall5: { exact, words }, thinning: { triggered },
 *   controls: { c1: { pass }, c2: { pass }, c3: { eligible, lowerBound } } }} input
 */
export function decideVerdict(input, rule) {
  const V = rule.verdict;
  const g = input.guards;
  const voids = [];
  if (!g.probeOk) voids.push('probe-below-floor');
  if (!g.idSpaceOk) voids.push('id-space-violation');
  voids.push(...(g.plantCodes ?? []));
  if (!(g.exclusionFraction <= V.exclusion_cap)) voids.push('exclusions-over-cap');
  const pd = g.passDisagreement;
  if (g.idSpaceOk && (!pd || pd.exact > V.pass_disagreement_cap || pd.words > V.pass_disagreement_cap)) voids.push('pass-disagreement');
  if (voids.length) return { verdict: 'VOID', voidReasons: [...new Set(voids)], requiredControls: [], downgrades: [] };

  const { delta, ci } = input;
  let verdict;
  if (delta >= V.margin && ci.lower > 0) verdict = 'GAP';
  else if (delta <= -V.margin && ci.upper < 0) verdict = 'REVERSE';
  else if (ci.lower > -V.margin && ci.upper < V.margin) verdict = 'NO-GAP';
  else verdict = 'INCONCLUSIVE';

  const downgrades = [];
  if (verdict === 'NO-GAP' || verdict === 'REVERSE') {
    if (input.thinning.triggered) downgrades.push('class-thinning');
    if (Math.max(input.recall5.exact, input.recall5.words) < V.discrimination_floor) downgrades.push('discrimination-floor');
    if (downgrades.length) verdict = 'INCONCLUSIVE';
  }
  if (verdict === 'GAP') {
    const c3 = input.controls.c3;
    if (c3.eligible < rule.c3.min_eligible_rows || !(c3.lowerBound > 0)) {
      verdict = 'GAP (seed-carried)';
      downgrades.push('seed-carried');
    }
  }
  const requiredControls = requiredControlsFor(verdict);
  const failed = requiredControls.filter((c) => !input.controls[c].pass).map((c) => `control-${c}-failed`);
  if (failed.length) return { verdict: 'VOID', voidReasons: failed, requiredControls, downgrades };
  return { verdict, voidReasons: [], requiredControls, downgrades };
}

/** Two-sided exact McNemar p from the discordant counts (descriptive only). */
export function mcnemarExactP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  let pmf = 2 ** -n;
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i++) {
    tail += pmf;
    pmf = (pmf * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

// ── the allowlisted writer ───────────────────────────────────────────────────

const S = {
  num: { t: 'num' }, numN: { t: 'num', nullable: true }, int: { t: 'int' }, bool: { t: 'bool' },
  hex64: { t: 'pattern', rx: /^[0-9a-f]{64}$/ }, hex40: { t: 'pattern', rx: /^[0-9a-f]{40}$/ },
  iso: { t: 'pattern', rx: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/ },
  date: { t: 'pattern', rx: /^\d{4}-\d{2}-\d{2}$/ }, version: { t: 'pattern', rx: /^\d+\.\d+\.\d+$/ },
  enum: (values) => ({ t: 'enum', values: [...values] }),
  arr: (items) => ({ t: 'arr', items }),
  obj: (keys) => ({ t: 'obj', keys }),
  map: (keys, value) => ({ t: 'map', keys: [...keys], value }),
};

export class AllowlistError extends Error {}

/** Throw unless every key and value of `value` is allowed by `schema`. */
export function assertAllowlisted(value, schema, path = '$') {
  const bad = () => { throw new AllowlistError(`allowlist: rejected at ${path}`); };
  if (value === null) { if (!schema.nullable) bad(); return; }
  switch (schema.t) {
    case 'num': if (typeof value !== 'number' || !Number.isFinite(value)) bad(); return;
    case 'int': if (!Number.isInteger(value)) bad(); return;
    case 'bool': if (typeof value !== 'boolean') bad(); return;
    case 'pattern': if (typeof value !== 'string' || !schema.rx.test(value)) bad(); return;
    case 'enum': if (!schema.values.includes(value)) bad(); return;
    case 'arr':
      if (!Array.isArray(value)) bad();
      value.forEach((v, i) => assertAllowlisted(v, schema.items, `${path}[${i}]`));
      return;
    case 'obj':
    case 'map': {
      if (typeof value !== 'object' || Array.isArray(value)) bad();
      for (const [k, v] of Object.entries(value)) {
        const sub = schema.t === 'obj' ? (Object.hasOwn(schema.keys, k) ? schema.keys[k] : null) : (schema.keys.includes(k) ? schema.value : null);
        if (!sub) throw new AllowlistError(`allowlist: unexpected key under ${path}`);
        assertAllowlisted(v, sub, schema.t === 'obj' ? `${path}.${k}` : `${path}.<key>`);
      }
      return;
    }
    default: bad();
  }
}

export const dfBandKey = ([lo, hi]) => `df_${lo}_${hi}`;

function sharedSchemas(rule) {
  const channels = rule.codes.exclusion_channels;
  const shapes = S.obj({ total: S.int, none: S.int, embedded: S.int, dominant: S.int });
  const acc = S.obj({ rows: S.int, correct: S.int, accuracy: S.numN });
  const byClass = S.map(IDENTIFIER_CLASSES, S.obj({
    doc_rows_df_le_max: S.int, multi_project: S.int, eligible: S.int, kept: S.int,
    by_channel: S.map(channels, S.int), j3_checked: S.int, j3_same: S.int,
    in_window_candidates: S.int, cross_neighbours: S.int,
  }));
  const plants = S.obj({
    leaky: acc, split: acc,
    near_miss: S.obj({ rows: S.int, correct: S.int, accuracy: S.numN, structural: S.bool, by_type: S.map(['in-window', 'cross'], acc) }),
  });
  return { channels, shapes, acc, byClass, plants };
}

/** The tracked result's allowlist (also what `score` prints). */
export function resultSchema(rule) {
  const { channels, shapes, byClass, plants } = sharedSchemas(rule);
  const census = S.obj({
    window: S.obj({ from: S.date, until: S.date }), files_read: S.int, lines_read: S.int, malformed_lines: S.int,
    undated_items: S.int, sessions_command_first: S.int, first_prompts: shapes, agent_calls: shapes,
    volume: S.obj({ plugin: S.int, unknown: S.int, excluded: S.int, other: S.int }),
    s_first: S.num, s_agent: S.num, p_dom: S.num, threshold: S.num, prevalence: S.enum(PREVALENCE_SIDES),
  });
  const stratum = S.obj({ n: S.int, rank1: S.int, rate: S.num, ok: S.bool });
  const arms = S.obj({ exact: S.numN, words: S.numN });
  const stats = S.obj({
    n: S.int, recall5: arms, recall1: arms, mrr: arms, delta: S.numN,
    ci: S.obj({ lower: S.numN, upper: S.numN, level: S.num }),
    mcnemar: S.obj({ b: S.int, c: S.int, p: S.num }),
  });
  const control = S.obj({ lower: S.numN, upper: S.numN, pass: S.bool });
  const cell = S.obj({ n: S.int, recall5_exact: S.num, recall5_words: S.num, delta: S.num });
  return S.obj({
    schema: S.enum([RESULT_SCHEMA_ID]),
    verdict: S.enum(VERDICTS),
    void_reasons: S.arr(S.enum(rule.codes.void_reasons)),
    d10_branch: S.enum(D10_BRANCHES),
    downgrades: S.arr(S.enum(DOWNGRADES)),
    timestamps: S.obj({ started_at: S.iso, finished_at: S.iso }),
    freeze: S.obj({ head_commit: S.hex40, anchor_blob: S.hex40 }),
    hashes: S.obj({ rule: S.hex64, query_set: S.hex64, corpus: S.hex64, transcripts: S.hex64, counters: S.hex64, server_tree: S.hex64 }),
    models: S.obj({
      generator: S.enum([rule.models.generator.model]), judge: S.enum([rule.models.judge.model]), embedder: S.enum([rule.corpus.embedder.model]),
    }),
    qdrant_version: S.version,
    census,
    guards: S.obj({
      probe: { ...S.obj({ fact: stratum, doc: stratum, floor: S.num, ok: S.bool }), nullable: true },
      id_space_ok: S.bool,
      plants,
      exclusion: S.obj({ eligible: S.int, excluded: S.int, fraction: S.num, by_channel: S.map(channels, S.int) }),
      pass_disagreement: { ...S.obj({ exact: S.num, words: S.num }), nullable: true },
    }),
    primary: stats,
    fact_control: stats,
    controls: S.obj({
      required: S.arr(S.enum(['c1', 'c2'])), c1: control, c2: control,
      c3: S.obj({ eligible: S.int, delta_held: S.numN, lower_one_sided: S.numN, applied: S.bool }),
    }),
    per_class: S.map(IDENTIFIER_CLASSES, cell),
    per_df_band: S.map(rule.report.df_bands.map(dfBandKey), cell),
    exclusions_by_class: byClass,
    thinning: S.obj({ triggered: S.bool, classes: S.arr(S.enum(IDENTIFIER_CLASSES)) }),
  });
}

/** The allowlist for `build`'s printed summary (counts and fixed labels only). */
export function buildSummarySchema(rule) {
  const { channels, byClass, plants } = sharedSchemas(rule);
  return S.obj({
    subcommand: S.enum(['build']), status: S.enum(['ok']), build_number: S.int, E: S.int,
    rows: S.obj({ total: S.int, primary: S.int, fact_control: S.int, nonprimary: S.int, c3_eligible: S.int, smallest_non_void_n: S.int }),
    exclusions: S.obj({ excluded: S.int, fraction: S.num, by_channel: S.map(channels, S.int) }),
    by_class: byClass,
    plants,
    format_failures: S.obj({ rows: S.int, fraction: S.num }),
    checks: S.obj({ plants: S.enum(['PASS', 'FAIL']), format_failures: S.enum(['PASS', 'FAIL']) }),
    void_codes: S.arr(S.enum(rule.codes.void_reasons)),
  });
}

/** Validate against the allowlist, then write (never overwriting). */
export function writeAllowlisted(path, value, schema, { overwrite = false } = {}) {
  assertAllowlisted(value, schema);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: overwrite ? 'w' : 'wx' });
}
