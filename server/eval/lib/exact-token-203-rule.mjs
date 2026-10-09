// server/eval/lib/exact-token-203-rule.mjs — #203 (spec D7; plan T7b, K1): the
// ONE startup loader for server/eval/exact-token-203-accept-rule.json.
//
// `build`, `calibrate`, `freeze-check`, `score` and the census read every
// parameter from the rule through this loader, which refuses a missing,
// mistyped or unknown key (code `rule-invalid` plus the key path — a schema
// string, never a value from the rule). Harness code carries no threshold of
// its own; the schema below states TYPES and RANGES only.
//
// The rule's verdict parameters are pre-registered: they merge in PR 2, before
// any corpus dump or build. The freeze PR may change only the `prompts` block.
// K1 (test/exact-token-203-harness.test.mjs) loads the tracked rule through
// this function in the suite, so a defect in a non-`prompts` key surfaces
// before the freeze rather than as a post-freeze VOID.

import { createHash } from 'node:crypto';

/** Codes the harness and census can emit; the rule's vocabulary must hold each. */
export const EMITTED_VOID_CODES = Object.freeze([
  'probe-below-floor', 'id-space-violation',
  'plant-j1-accuracy', 'plant-j1-too-few', 'plant-j2-accuracy', 'plant-j2-too-few',
  'plant-j2-donor-type-accuracy', 'plant-j2-donor-type-too-few', 'plant-j3-accuracy', 'plant-j3-too-few',
  'exclusions-over-cap', 'control-c1-failed', 'control-c2-failed', 'pass-disagreement',
  'format-failures-over-cap', 'post-verdict-error',
]);
export const EMITTED_REFUSAL_CODES = Object.freeze([
  'usage', 'rule-invalid', 'input-missing', 'anchor-missing', 'anchor-malformed', 'rule-mismatch',
  'query-set-mismatch', 'corpus-mismatch', 'transcripts-mismatch', 'counters-mismatch',
  'server-tree-mismatch', 'server-tree-dirty', 'query-set-rule-binding', 'query-set-corpus-binding',
  'provenance-fetch-failed', 'provenance-not-merged', 'provenance-check-failed', 'git-failed',
  'transcripts-unreadable', 'env-temporal-flag', 'embedder-mismatch', 'corpus-malformed',
  'corpus-user-id-mismatch', 'corpus-cutoff-violated', 'query-set-malformed', 'clone-integrity',
  'qdrant-version-mismatch', 'index-open-failed', 'search-failed', 'llm-failed',
  'census-input-missing', 'census-counters-malformed', 'census-no-first-prompts', 'census-no-volume',
  'result-exists', 'calibrate-primary-row', 'internal-error',
]);
export const EXCLUSION_CHANNELS = Object.freeze(['generator-error', 'unglossable', 'g-shape', 'j1', 'j2', 'j3']);

// ── schema DSL ───────────────────────────────────────────────────────────────
const isInt = (v) => Number.isInteger(v);
const T = {
  posInt: (v) => isInt(v) && v > 0,
  prob: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
  openProb: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1,
  str: (v) => typeof v === 'string' && v.length > 0,
  hex: (v) => typeof v === 'string' && /^[0-9a-f]{16,}$/.test(v),
  date: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)),
  iso: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v)),
  strs: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0) && new Set(v).size === v.length,
  numOrNull: (v) => v === null || (typeof v === 'number' && Number.isFinite(v)),
  bands: (v) => Array.isArray(v) && v.length > 0 && v.every((b) => Array.isArray(b) && b.length === 2 && isInt(b[0]) && isInt(b[1]) && b[0] >= 1 && b[0] <= b[1]),
  version: (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v),
};
const is = (value) => (v) => v === value;
const oneOf = (...values) => (v) => values.includes(v);
const superset = (required) => (v) => T.strs(v) && required.every((c) => v.includes(c));
/** A prompt template that carries each named placeholder. */
const prompt = (...names) => (v) => T.str(v) && names.every((n) => v.includes(`{{${n}}}`));

const SCHEMA = {
  schema: is('exact-token-203-accept-rule/1'),
  issue: is(203),
  population: { max_df: T.posInt, corpus_cutoff: T.iso, missing_project_value: T.str },
  corpus: {
    pinned_user_id: T.str,
    system_user_id: T.str,
    embedder: { provider: T.str, model: T.str, dims: T.posInt },
  },
  read_path: { fail_closed_env: T.strs, qdrant_version: T.version, k: T.posInt, fetch_depth: T.posInt },
  gloss: {
    window_chars: T.posInt, min_words: T.posInt, max_words: T.posInt, min_descriptive_words: T.posInt,
    generic_words: T.strs, retries: (v) => isInt(v) && v >= 0,
    max_in_window_candidates: T.posInt, cross_doc_neighbours: (v) => isInt(v) && v >= 0,
  },
  plants: { accuracy_floor: T.prob, min_rows: T.posInt, min_rows_per_donor_type: T.posInt, retries: (v) => isInt(v) && v >= 0 },
  build: { max_format_failure_fraction: T.prob, max_rebuilds: (v) => isInt(v) && v >= 0, llm_concurrency: T.posInt },
  verdict: {
    margin: T.openProb, ci_level: T.openProb, bootstrap_resamples: T.posInt, exclusion_cap: T.prob,
    pass_disagreement_cap: T.prob, class_thinning: { min_class_rows: T.posInt, min_kept_fraction: T.prob },
    discrimination_floor: T.prob,
  },
  probe: { per_stratum_n: T.posInt, rank1_floor: T.prob },
  calibration: { determinism_floor: T.prob },
  c3: { min_eligible_rows: T.posInt, one_sided_level: T.openProb },
  controls: { derangement_max_attempts: T.posInt },
  report: { df_bands: T.bands },
  salts: {
    representative: T.hex, seed_doc: T.hex, neighbour_tiebreak: T.hex,
    donor_type: T.hex, candidate_order: T.hex, split_referent: T.hex,
  },
  seeds: { scramble: T.hex, derangement: T.hex, bootstrap: T.hex },
  models: {
    generator: { provider: is('openai'), model: T.str, temperature: T.numOrNull, max_tokens: T.posInt },
    judge: {
      provider: is('anthropic'), model: T.str, temperature: T.numOrNull,
      thinking: oneOf('disabled', 'adaptive'), effort: oneOf('low', 'medium', 'high'), max_tokens: T.posInt,
    },
  },
  census: {
    census_from: T.date, census_until: T.date, counters_export_sql: T.str, prevalence_threshold: T.prob,
    source_mapping: { first_prompt: T.str, agent_memory_search: T.str, excluded: T.strs },
    min_prompt_chars: T.posInt, prompt_max_chars: T.posInt, tool_name_suffix: T.str, non_prompt_prefixes: T.strs,
  },
  codes: {
    void_reasons: superset(EMITTED_VOID_CODES),
    refusals: superset(EMITTED_REFUSAL_CODES),
    exclusion_channels: (v) => T.strs(v) && v.length === EXCLUSION_CHANNELS.length && EXCLUSION_CHANNELS.every((c) => v.includes(c)),
  },
  prompts: {
    fence_open: prompt('NONCE'),
    fence_close: prompt('NONCE'),
    generator: prompt('NONCE', 'WINDOW', 'IDENTIFIER'),
    leaky_plant: prompt('NONCE', 'WINDOW', 'IDENTIFIER'),
    generator_retry: prompt('PROMPT', 'REASON'),
    generator_retry_reasons: { digit: T.str, identifier: T.str, 'word-count': T.str, 'descriptive-words': T.str },
    j1: prompt('NONCE', 'WINDOW', 'IDENTIFIER', 'PHRASE'),
    j2: prompt('NONCE', 'CANDIDATES', 'PHRASE'),
    j2_candidate: prompt('NUMBER', 'IDENTIFIER', 'WINDOW'),
    j3: prompt('NONCE', 'IDENTIFIER', 'PASSAGES'),
    j3_passage: prompt('NUMBER', 'WINDOW'),
  },
};

function check(schema, value, path) {
  if (typeof schema === 'function') return schema(value) ? null : path;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return path || '(root)';
  for (const k of Object.keys(schema)) {
    const p = path ? `${path}.${k}` : k;
    if (!Object.hasOwn(value, k)) return p;
    const bad = check(schema[k], value[k], p);
    if (bad) return bad;
  }
  for (const k of Object.keys(value)) if (!Object.hasOwn(schema, k)) return path ? `${path}.${k}` : k;
  return null;
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * Load and validate the rule from its raw bytes.
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {{ ok: true, rule: object, sha256: string } | { ok: false, code: 'rule-invalid', key: string }}
 */
export function loadRule(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let rule;
  try {
    rule = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, code: 'rule-invalid', key: '(json)' };
  }
  const bad = check(SCHEMA, rule, '');
  if (bad) return { ok: false, code: 'rule-invalid', key: bad };
  // Cross-key relations the per-key types cannot state.
  if (rule.gloss.min_words > rule.gloss.max_words) return { ok: false, code: 'rule-invalid', key: 'gloss.min_words' };
  if (rule.census.census_from > rule.census.census_until) return { ok: false, code: 'rule-invalid', key: 'census.census_from' };
  if (rule.read_path.k > rule.read_path.fetch_depth) return { ok: false, code: 'rule-invalid', key: 'read_path.k' };
  return { ok: true, rule: deepFreeze(rule), sha256: createHash('sha256').update(buf).digest('hex') };
}
