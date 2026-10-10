/**
 * exact-token-203-harness.test.mjs — #203 PR 2 (spec D1–D8, §4.2.3, §4.2.5,
 * §4.2.8; plan T6, T7, T7b): the harness's pure pieces, its subcommands driven
 * through run(argv, deps), and the tracked rule.
 *
 * Registered cases:
 *   G1–G5  G-shape (spec D2)
 *   K1     the tracked rule passes the harness's own startup loader, which
 *          refuses a missing, mistyped or unknown key
 *   H1–H10 (the spec lists eleven pure pieces under H1–H10; numbered in its order,
 *          the last item split as H10a/H10b):
 *     H1  substring-then-hash representative, isDoc seed-doc choice
 *     H2  scramble preserves shape and is seeded
 *     H3  derangement has no fixed points and pairs only disjoint relevant sets
 *     H4  bootstrap CI is seeded and reproducible
 *     H5  the verdict function covers all five outcomes at their boundaries
 *     H6  D6's required-control table, incl. GAP (seed-carried), after downgrades
 *     H7  the class-thinning and discrimination-floor downgrades
 *     H8  C3: seed removed before the top-5 cut; rows with no other isDoc doc
 *         skipped; one-sided bound; < 30 eligible rows (incl. none) → seed-carried
 *         without a throw
 *     H9  a throw after the verdict function → VOID post-verdict-error
 *     H10a score exits non-zero before any clone with UM_TEMPORAL_QUERY /
 *          UM_TEMPORAL_DECAY = 'true', or a different embedder config
 *     H10b on a forced VOID, score's stdout and files hold no Δ, CI or class table
 *   H11 calibrate never scores a primary row; no recall figure in its output
 *   H12 cross-document neighbours: same class, not in the row's relevant docs,
 *       top 3 by Jaccard with a salted-hash tie-break, identical across builds
 *   H13 nested candidates and J2 answers: nested matches excluded; the in-window
 *       donor is the nearest non-nested candidate; SEVERAL and NONE exclude; donor
 *       types split by seeded hash, accuracy per type; a multi-project row is
 *       ineligible
 *   H14 J3: one window per relevant doc on df ≥ 2 rows; anything but SAME
 *       excludes; the split-referent plant swaps one non-seed window and the
 *       identifier string; df = 1 rows skip J3
 *   P1  the aggregate writer rejects any key outside its allowlist
 *   P2  build + score end to end on the synthetic fixture: the tracked output
 *       holds none of the fixture's identifier, gloss or doc-id strings
 *   P3  a forced VOID with an injected id-space violation writes codes only
 * Plus the exact-token-eval.mjs seams (§4.2.3) and the prompt fences (D2).
 *
 * Revision 1 (spec §8.3, plan R1-T2) — plant validation:
 *   H15 only validator-confirmed attempts count toward accuracy and row floors
 *       (all three kinds); a not-confirmed attempt is recorded and excluded from
 *       both; an out-of-vocabulary answer does not confirm and is counted; the
 *       2×2 covers every judged attempt
 *   H16 near-miss fallback within the assigned type, in its order, ≤ 3 attempts,
 *       rank recorded, no nested twin; availability fallback unchanged; the split
 *       donor shares the row's project, excludes identifiers in its docs (X ⊃ Y
 *       and X ⊂ Y by substring), Jaccard order, ≤ 3 attempts, first confirmed
 *       stops; a mixed-project donor is refused; a catch-all-project row carries
 *       no split plant; an UNKNOWN / G-shape-failed donor gloss uses up an
 *       attempt; a first confirmed attempt that the judge misses ends the plant
 *   H17 structural shortfalls are decided on availability before generation; a
 *       validation shortfall is never structural; plant-j3-too-few (either
 *       cause) is marked non-rebuildable
 *   H18 V2's A/B order: salted over row, donor and rank, independent of the
 *       donor-type parity, and an A/B swap maps back to donor / target
 *   H19 score refuses before the verdict function when a pre-verdict aggregate
 *       fails the allowlist; guards.plants is the build summary's projection
 *   K1  the revised rule (validator, salts, plants keys; provider rule; the
 *       catch-all list holds the missing-project value)
 *   K2  the plant-only frozen keys hash to the pinned value
 *
 * Everything is synthetic: stubbed LLMs and a stubbed retrieval, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/tmpdir.mjs';
import { makeGitSandbox } from './helpers/git-sandbox.mjs';
import { materializeCensusFixture } from './fixtures/exact-token-203-census.fixture.mjs';
import { POPULATION_FIXTURE_POINTS } from './fixtures/exact-token-population.fixture.mjs';
import {
  CORPUS_POINTS, STUB_GLOSSES, leakyPhrase, makeStubIndex, makeStubLlm,
} from './fixtures/exact-token-203-corpus.fixture.mjs';
import { buildPopulation, verbatimProbe, assertIdSpace, projectedId } from '../eval/exact-token-eval.mjs';
import { IDENTIFIER_RX } from '../lib/query-shape.mjs';
import {
  ANCHOR_CODES, ANCHOR_REL_PATH, RULE_REL_PATH, canonicalJson, computeAnchorLines, formatAnchor,
} from '../eval/lib/accept-rule.mjs';
import { loadRule } from '../eval/lib/exact-token-203-rule.mjs';
import {
  IDENTIFIER_CLASSES, buildPopulationRows, chooseRepresentative, chooseSeedDoc, classOf,
  gShape, indexCorpus, jaccard, plantSummary, runBuild, saltedHash, validatorOrder,
} from '../eval/lib/exact-token-203-build.mjs';
import {
  assertAllowlisted, bootstrapCI, bootstrapLowerBound, classThinning, decideVerdict, derange,
  heldOutDeltas, requiredControlsFor, resultSchema, scramble,
} from '../eval/lib/exact-token-203-score.mjs';
import { calibrationQueries, run } from '../eval/exact-token-203.mjs';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED_RULE_PATH = join(SERVER_DIR, 'eval', 'exact-token-203-accept-rule.json');
const TRACKED = JSON.parse(readFileSync(TRACKED_RULE_PATH, 'utf8'));
const RULE = loadRule(readFileSync(TRACKED_RULE_PATH)).rule;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const NOW = () => new Date('2026-10-12T00:00:00.000Z');

/** The tracked rule with small floors so a 12-point fixture can reach a verdict. */
function fixtureRule(mut = (r) => r) {
  const r = structuredClone(TRACKED);
  r.plants.min_rows = 1;
  r.plants.min_rows_per_donor_type = 1;
  r.verdict.bootstrap_resamples = 200;
  r.verdict.exclusion_cap = 0.9;
  r.c3.min_eligible_rows = 1;
  return mut(r);
}
const ruleBytes = (r) => Buffer.from(`${JSON.stringify(r, null, 2)}\n`);
const loaded = (r) => {
  const l = loadRule(ruleBytes(r));
  assert.equal(l.ok, true, JSON.stringify(l));
  return l.rule;
};

function cleanEnv(env) {
  const e = { ...env };
  for (const k of ['UM_TEMPORAL_QUERY', 'UM_TEMPORAL_DECAY', 'UM_EMBEDDING_PROVIDER', 'UM_EMBEDDING_MODEL']) delete e[k];
  return e;
}

function listAll(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listAll(p));
    else out.push(relative(dir, p).replace(/\\/g, '/'));
  }
  return out.sort();
}

/**
 * A merged sandbox repo + arc dir holding a real `build` output and its anchor.
 * `tamper(arc)` edits the arc dir between the build and the anchor (so the
 * anchor still binds what score reads).
 */
async function e2e({ ruleMut, llm, points = CORPUS_POINTS, anchor = true, tamper } = {}) {
  const sb = makeGitSandbox();
  const env = cleanEnv(sb.env);
  sb.write(RULE_REL_PATH, ruleBytes(fixtureRule(ruleMut)));
  sb.write('server/lib/sample.mjs', 'export const a = 1;\n');
  sb.commitAll('base');
  const arc = join(sb.root, 'arc');
  mkdirSync(arc);
  writeFileSync(join(arc, 'corpus.json'), JSON.stringify(points));
  await materializeCensusFixture(arc);
  const stub = llm ?? makeStubLlm();
  const buildOut = [];
  const code = await run(['build', '--arc-dir', arc], { repoDir: sb.repo, env, out: (l) => buildOut.push(String(l)), llm: stub, now: NOW });
  assert.equal(code, 0, buildOut.join('\n'));
  if (tamper) tamper(arc);
  if (anchor) {
    const entries = {
      rule: join(sb.repo, ...RULE_REL_PATH.split('/')), 'query-set': join(arc, 'query-set.jsonl'),
      corpus: join(arc, 'corpus.json'), transcripts: join(arc, 'transcripts'), counters: join(arc, 'counters-export.json'),
    };
    sb.write(ANCHOR_REL_PATH, formatAnchor(await computeAnchorLines(entries, { repoDir: sb.repo, env })));
    sb.commitAll('freeze');
  }
  sb.push();
  return { sb, env, arc, llm: stub, buildOut };
}

async function score(ctx, { index, faults, env, resultsDir } = {}) {
  const outLines = [];
  const idx = index ?? makeStubIndex(CORPUS_POINTS);
  let opened = 0;
  const code = await run(['score', '--arc-dir', ctx.arc], {
    repoDir: ctx.sb.repo, env: env ?? ctx.env, now: NOW, faults, ...(resultsDir ? { resultsDir } : {}),
    out: (l) => outLines.push(String(l)),
    openIndex: async () => { opened++; return idx; },
  });
  const dir = resultsDir ?? join(ctx.sb.repo, 'server', 'eval', 'results');
  return { code, outLines, idx, opened, resultsDir: dir, files: listAll(dir) };
}

function readQuerySet(arc) {
  const lines = readFileSync(join(arc, 'query-set.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { header: lines[0], rows: lines.slice(1) };
}

/** Every corpus-derived string the tracked output must never carry. */
function fixtureStrings(arc) {
  const { rows } = readQuerySet(arc);
  const s = new Set();
  for (const r of rows) {
    s.add(r.identifier);
    if (r.gloss) s.add(r.gloss);
    for (const id of r.relevant) s.add(id);
  }
  for (const p of CORPUS_POINTS) { s.add(String(p.id)); if (p.payload.id) s.add(p.payload.id); }
  for (const g of Object.values(STUB_GLOSSES)) if (g !== 'UNKNOWN') s.add(g);
  for (const k of Object.keys(STUB_GLOSSES)) { const l = leakyPhrase(k); if (l !== 'UNKNOWN') s.add(l); }
  return [...s].filter((x) => x.length >= 4);
}

// ── exact-token-eval.mjs seams (§4.2.3) ──────────────────────────────────────

test('exact-token-eval: verbatimProbe and assertIdSpace are exported; buildPopulation groups mode', async () => {
  assert.equal(typeof verbatimProbe, 'function');
  assert.equal(typeof assertIdSpace, 'function');
  assert.throws(() => assertIdSpace(['x'], new Set(['y']), 'arm', 'FAKE'), /ID-SPACE VIOLATION/);
  assert.doesNotThrow(() => assertIdSpace(['y'], new Set(['y']), 'arm', 'FAKE'));
  const pts = POPULATION_FIXTURE_POINTS.map((p) => structuredClone(p));
  const groups = buildPopulation(pts, { groups: true });
  const flat = buildPopulation(pts.map((p) => structuredClone(p)));
  // Same partition: one group per default row, same relevant sets, df and strata.
  assert.equal(groups.length, flat.length);
  const byKey = new Map(groups.map((g) => [g.relevant.join('|'), g]));
  for (const r of flat) {
    const g = byKey.get(r.relevant.join('|'));
    assert.ok(g, r.identifier);
    assert.ok(g.identifiers.includes(r.identifier));
    assert.equal(g.df, r.df);
    assert.equal(g.stratum, r.stratum);
  }
  // The v1.2.3 / 1.2.3 group keeps both members (the harness picks the representative).
  assert.ok(groups.some((g) => g.identifiers.includes('v1.2.3') && g.identifiers.includes('1.2.3')));
  // verbatimProbe takes an injected floor; an empty stratum fails.
  const idx = makeStubIndex(CORPUS_POINTS);
  const probe = await verbatimProbe(idx.doSearch, idx.memory, CORPUS_POINTS, 20, 0.9);
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.per.fact.n, 2);
  const docsOnly = await verbatimProbe(idx.doSearch, idx.memory, CORPUS_POINTS.filter((p) => !p.id.startsWith('pt-f')), 20, 0.9);
  assert.equal(docsOnly.ok, false, 'an empty fact stratum fails');
  assert.equal(projectedId(CORPUS_POINTS[0]), 'd01');
});

// ── G1–G5 ───────────────────────────────────────────────────────────────────

test('G1 v1.26.1 / "the 1.26.1 release" rejected (a digit)', () => {
  assert.deepEqual(gShape('the 1.26.1 release', 'v1.26.1', RULE), { ok: false, reason: 'digit' });
});

test('G2 #351 / "issue 351 reindex fix" rejected (a digit)', () => {
  assert.deepEqual(gShape('issue 351 reindex fix', '#351', RULE), { ok: false, reason: 'digit' });
});

test('G3 a gloss carrying another identifier is rejected', () => {
  assert.deepEqual(gShape('UM_OTHER_FLAG toggle behaviour', 'UM_TEMPORAL_DECAY', RULE), { ok: false, reason: 'identifier' });
  assert.deepEqual(gShape('widget pipeline --dry-run mode', 'FAKE_FLAG', RULE), { ok: false, reason: 'identifier' });
  // The target itself in disguise (lowercased) is rejected too.
  assert.deepEqual(gShape('um_temporal_decay ranking switch', 'UM_TEMPORAL_DECAY', RULE), { ok: false, reason: 'identifier' });
});

test('G4 "the issue" rejected (no descriptive word); word limits enforced', () => {
  assert.deepEqual(gShape('the issue', '#351', RULE), { ok: false, reason: 'descriptive-words' });
  assert.deepEqual(gShape('the config file setting', 'FAKE_FLAG', RULE), { ok: false, reason: 'descriptive-words' });
  // Plurals of the generic words are generic too (ruling, PR 2 review): an explicit list, no stemming.
  assert.deepEqual(gShape('the flags', '#351', RULE), { ok: false, reason: 'descriptive-words' });
  assert.deepEqual(gShape('config files and settings', 'FAKE_FLAG', RULE), { ok: false, reason: 'descriptive-words' });
  assert.deepEqual(gShape('the reindex flags', '#351', RULE), { ok: false, reason: 'descriptive-words' }, 'one descriptive word is not enough');
  assert.deepEqual(gShape('reindex', '#351', RULE), { ok: false, reason: 'word-count' });
  assert.deepEqual(gShape('one two three four five six seven', '#351', RULE), { ok: false, reason: 'word-count' });
});

test('G5 UM_TEMPORAL_DECAY / "temporal decay feature flag" accepted', () => {
  assert.deepEqual(gShape('temporal decay feature flag', 'UM_TEMPORAL_DECAY', RULE), { ok: true });
  assert.deepEqual(gShape('reindex warning noise', '#351', RULE), { ok: true });
});

// ── K1 ───────────────────────────────────────────────────────────────────────

test('K1 the tracked rule passes the startup loader; a missing, mistyped or unknown key is refused', () => {
  const ok = loadRule(readFileSync(TRACKED_RULE_PATH));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.sha256, sha(readFileSync(TRACKED_RULE_PATH)));
  assert.ok(Object.isFrozen(ok.rule) && Object.isFrozen(ok.rule.verdict), 'deep-frozen');
  const without = structuredClone(TRACKED); delete without.verdict.margin;
  assert.deepEqual(loadRule(ruleBytes(without)), { ok: false, code: 'rule-invalid', key: 'verdict.margin' });
  const mistyped = structuredClone(TRACKED); mistyped.verdict.bootstrap_resamples = '10000';
  assert.deepEqual(loadRule(ruleBytes(mistyped)), { ok: false, code: 'rule-invalid', key: 'verdict.bootstrap_resamples' });
  const extra = structuredClone(TRACKED); extra.verdict.margn = 0.1;
  assert.deepEqual(loadRule(ruleBytes(extra)), { ok: false, code: 'rule-invalid', key: 'verdict.margn' });
  const badSalt = structuredClone(TRACKED); badSalt.salts.representative = 'not-hex';
  assert.equal(loadRule(ruleBytes(badSalt)).key, 'salts.representative');
  const badPrompt = structuredClone(TRACKED); badPrompt.prompts.j1 = badPrompt.prompts.j1.replaceAll('{{NONCE}}', '');
  assert.equal(loadRule(ruleBytes(badPrompt)).ok, false, 'a prompt that drops its nonce fence is refused');
  const badCodes = structuredClone(TRACKED); badCodes.codes.void_reasons = badCodes.codes.void_reasons.filter((c) => c !== 'post-verdict-error');
  assert.equal(loadRule(ruleBytes(badCodes)).ok, false, 'the vocabulary must hold every code the harness emits');
  assert.equal(loadRule(Buffer.from('{ not json')).code, 'rule-invalid');
});

test('K1 (revision 1) the validator, its salt and the plants keys: missing or mistyped refused; same-family validator refused', () => {
  const noValidator = structuredClone(TRACKED); delete noValidator.models.validator;
  assert.deepEqual(loadRule(ruleBytes(noValidator)), { ok: false, code: 'rule-invalid', key: 'models.validator' });
  // The validator must come from a different model family from the judge (spec §8.2 R1).
  const sameFamily = structuredClone(TRACKED); sameFamily.models.validator.provider = sameFamily.models.judge.provider;
  assert.deepEqual(loadRule(ruleBytes(sameFamily)), { ok: false, code: 'rule-invalid', key: 'models.validator.provider' });
  const badTokens = structuredClone(TRACKED); badTokens.models.validator.max_tokens = 0;
  assert.equal(loadRule(ruleBytes(badTokens)).key, 'models.validator.max_tokens');
  const noSalt = structuredClone(TRACKED); delete noSalt.salts.validator_order;
  assert.equal(loadRule(ruleBytes(noSalt)).key, 'salts.validator_order');
  for (const k of ['near_miss_donor_attempts', 'split_donor_attempts']) {
    const bad = structuredClone(TRACKED); bad.plants[k] = 0;
    assert.equal(loadRule(ruleBytes(bad)).key, `plants.${k}`, k);
  }
  const badList = structuredClone(TRACKED); badList.plants.split_project_excluded = [];
  assert.equal(loadRule(ruleBytes(badList)).key, 'plants.split_project_excluded');
  // The catch-all list must hold the value a point without a project gets.
  const noNone = structuredClone(TRACKED);
  noNone.plants.split_project_excluded = noNone.plants.split_project_excluded.filter((p) => p !== noNone.population.missing_project_value);
  assert.equal(loadRule(ruleBytes(noNone)).key, 'plants.split_project_excluded');
  // Each validator prompt must carry its placeholders (the nonce fence included).
  for (const [k, ph] of [['validator_leaky', 'PHRASE'], ['validator_near_miss', 'WINDOW_B'], ['validator_split', 'NONCE'], ['validator_split', 'WINDOW_A']]) {
    const bad = structuredClone(TRACKED); bad.prompts[k] = bad.prompts[k].replaceAll(`{{${ph}}}`, '');
    assert.equal(loadRule(ruleBytes(bad)).key, `prompts.${k}`, `${k} without ${ph}`);
  }
});

test('K1 the tracked rule carries the spec\'s pre-registered values', () => {
  assert.equal(RULE.verdict.margin, 0.1);
  assert.equal(RULE.verdict.ci_level, 0.95);
  assert.equal(RULE.verdict.bootstrap_resamples, 10000);
  assert.equal(RULE.verdict.exclusion_cap, 0.4);
  assert.equal(RULE.verdict.pass_disagreement_cap, 0.02);
  assert.deepEqual({ ...RULE.verdict.class_thinning }, { min_class_rows: 20, min_kept_fraction: 0.5 });
  assert.equal(RULE.verdict.discrimination_floor, 0.2);
  // Revision 1 (spec §8.3): floors unchanged in value (R3); three new keys.
  assert.deepEqual({ ...RULE.plants }, {
    accuracy_floor: 0.9, min_rows: 60, min_rows_per_donor_type: 30, retries: 1,
    near_miss_donor_attempts: 3, split_donor_attempts: 3, split_project_excluded: ['desktop', 'default', '(none)'],
  });
  assert.ok(RULE.plants.split_project_excluded.includes(RULE.population.missing_project_value));
  assert.deepEqual(Object.keys(RULE.salts),
    ['representative', 'seed_doc', 'neighbour_tiebreak', 'donor_type', 'candidate_order', 'split_referent', 'validator_order']);
  for (const v of Object.values(RULE.salts)) assert.match(v, /^[0-9a-f]{32}$/);
  assert.equal(new Set(Object.values(RULE.salts)).size, 7, 'validator_order is a new salt, so V2\'s position is independent of donor_type');
  assert.deepEqual({ ...RULE.models.validator }, { provider: 'openai', model: 'gpt-4.1-2025-04-14', temperature: 0, max_tokens: 8 });
  assert.notEqual(RULE.models.validator.provider, RULE.models.judge.provider);
  assert.equal(RULE.calibration.determinism_floor, 0.98);
  assert.deepEqual({ ...RULE.c3 }, { min_eligible_rows: 30, one_sided_level: 0.95 });
  assert.equal(RULE.population.max_df, 5);
  assert.equal(RULE.population.corpus_cutoff, '2026-10-09T00:00:00Z');
  assert.equal(RULE.gloss.window_chars, 600);
  assert.equal(RULE.gloss.min_words, 2);
  assert.equal(RULE.gloss.max_words, 6);
  const SPEC_GENERIC = ['issue', 'pr', 'file', 'flag', 'version', 'release', 'path', 'setting', 'variable', 'function', 'command',
    'port', 'option', 'script', 'config', 'fix', 'update', 'change', 'server', 'module', 'system', 'tool', 'feature', 'code', 'bug', 'thing'];
  const plural = (w) => (/(x|s|sh|ch)$/.test(w) ? `${w}es` : `${w}s`);
  assert.deepEqual([...RULE.gloss.generic_words].sort(), [...SPEC_GENERIC, ...SPEC_GENERIC.map(plural)].sort(), 'spec D2\'s words and their plurals, nothing else');
  assert.equal(RULE.corpus.pinned_user_id, 'golden');
  assert.deepEqual({ ...RULE.corpus.embedder }, { provider: 'openai', model: 'text-embedding-3-small', dims: 1536 });
  assert.equal(RULE.census.prevalence_threshold, 0.05);
  assert.equal(RULE.census.counters_export_sql,
    "SELECT day, surface, SUM(count) AS n FROM counters WHERE event = 'recall.search' AND day BETWEEN '2026-09-10' AND '2026-10-08' GROUP BY day, surface ORDER BY day, surface");
  assert.ok(RULE.codes.void_reasons.includes('post-verdict-error'));
  assert.equal(RULE.models.generator.model.startsWith('gpt-4o-mini'), true);
  assert.match(RULE.models.judge.model, /^claude-haiku-/);
  // Every code the anchor check and the census can return is in the refusal vocabulary.
  for (const c of [...ANCHOR_CODES, 'census-input-missing', 'census-counters-malformed', 'census-no-first-prompts', 'census-no-volume']) {
    assert.ok(RULE.codes.refusals.includes(c), c);
  }
  assert.deepEqual([...RULE.codes.exclusion_channels].sort(), ['g-shape', 'generator-error', 'j1', 'j2', 'j3', 'unglossable']);
});

// ── K2 ───────────────────────────────────────────────────────────────────────

/**
 * Spec §8.2 R1/R4: the keys that act only on plants are frozen from the revision
 * PR to the freeze. The pin below was computed from the revision PR's rule; a
 * later edit to any of these keys must change the pin too, visibly in its diff.
 */
const K2_PIN = '3c71eb83e01e1dce46f59e6ae251186ac4c63296ee4131508897cad465f8e45e';

test('K2 the plant-only frozen keys (validator model, validator prompts, leaky_plant) hash to the pinned value', () => {
  const frozen = {
    'models.validator': TRACKED.models.validator,
    'prompts.validator_leaky': TRACKED.prompts.validator_leaky,
    'prompts.validator_near_miss': TRACKED.prompts.validator_near_miss,
    'prompts.validator_split': TRACKED.prompts.validator_split,
    'prompts.leaky_plant': TRACKED.prompts.leaky_plant,
  };
  for (const [k, v] of Object.entries(frozen)) assert.ok(v !== undefined, `${k} present`);
  assert.equal(sha(canonicalJson(frozen)), K2_PIN);
  // The pin covers each key: one changed byte anywhere moves it.
  for (const k of Object.keys(frozen)) {
    const edited = structuredClone(frozen);
    if (typeof edited[k] === 'string') edited[k] = `${edited[k]} `;
    else edited[k] = { ...edited[k], max_tokens: edited[k].max_tokens + 1 };
    assert.notEqual(sha(canonicalJson(edited)), K2_PIN, k);
  }
});

// ── H1 ───────────────────────────────────────────────────────────────────────

test('H1 representative: nested members dropped first, then min salted hash (not keep-longest)', () => {
  assert.equal(chooseRepresentative(['0.3.8', 'v0.3.8'], 'aa'), 'v0.3.8');
  assert.equal(chooseRepresentative(['vault.mjs', 'lib/vault.mjs'], 'bb'), 'lib/vault.mjs');
  // Among non-nested members the salted hash decides, so the shorter one wins for some salts.
  const members = ['server/lib/long-path-name.mjs', '#4101'];
  const winners = new Set();
  for (const salt of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const expected = members.slice().sort((a, b) => (sha(salt + a) < sha(salt + b) ? -1 : 1))[0];
    assert.equal(chooseRepresentative(members, salt), expected, salt);
    winners.add(expected);
  }
  assert.ok(winners.has('#4101'), 'keep-longest would never pick the issue ref');
  assert.equal(saltedHash('s1', '#4101'), sha('s1#4101'));
});

test('H1 seed doc: the isDoc relevant doc with the smallest salted hash; facts fall back to all', () => {
  const pts = [
    { id: 'a', payload: { id: 'A', data: 'Session summary: one' } },
    { id: 'b', payload: { id: 'B', data: 'x'.repeat(401) } },
    { id: 'c', payload: { id: 'C', data: 'short fact' } },
  ];
  const idx = indexCorpus(pts, RULE);
  for (const salt of ['k1', 'k2', 'k3', 'k4']) {
    const docs = ['A', 'B'].sort((x, y) => (sha(salt + x) < sha(salt + y) ? -1 : 1));
    assert.equal(chooseSeedDoc(['A', 'B', 'C'], idx, salt), docs[0], salt);
    assert.equal(chooseSeedDoc(['C'], idx, salt), 'C');
  }
  const facts = [{ id: 'f', payload: { id: 'F', data: 'tiny' } }, { id: 'g', payload: { id: 'G', data: 'tiny too' } }];
  const fidx = indexCorpus(facts, RULE);
  const exp = ['F', 'G'].sort((x, y) => (sha('z' + x) < sha('z' + y) ? -1 : 1))[0];
  assert.equal(chooseSeedDoc(['F', 'G'], fidx, 'z'), exp);
});

test('H1 identifier classes follow IDENTIFIER_RX\'s frozen alternative order', () => {
  // Eight top-level alternatives: 20 bars in the source, 13 of them inside EXT's group.
  assert.equal(IDENTIFIER_RX.source.split('|').length, 21);
  assert.equal(IDENTIFIER_CLASSES.length, 8);
  assert.equal(classOf('UM_TEMPORAL_DECAY'), 'screaming-snake');
  assert.equal(classOf('v1.26.1'), 'semver');
  assert.equal(classOf('#351'), 'issue-ref');
  assert.equal(classOf('lib/vault.mjs'), 'file');
  assert.equal(classOf('--dry-run'), 'long-flag');
  assert.equal(classOf('spin_up()'), 'fn-call');
  assert.equal(classOf('/srv/demo/vault'), 'path');
  assert.equal(classOf('relay-a:8080'), 'host-port');
});

// ── H2 ───────────────────────────────────────────────────────────────────────

test('H2 scramble: letters to letters (case kept), digits to digits, punctuation kept; seeded', () => {
  for (const id of ['UM_TEMPORAL_DECAY', 'v1.26.1', '#351', 'lib/vault.mjs', '--dry-run', 'relay-a:8080']) {
    const s = scramble(id, 'seed-a');
    assert.equal(s.length, id.length);
    assert.notEqual(s, id);
    for (let i = 0; i < id.length; i++) {
      const [a, b] = [id[i], s[i]];
      if (/[A-Z]/.test(a)) assert.match(b, /[A-Z]/);
      else if (/[a-z]/.test(a)) assert.match(b, /[a-z]/);
      else if (/[0-9]/.test(a)) assert.match(b, /[0-9]/);
      else assert.equal(b, a);
    }
    assert.equal(scramble(id, 'seed-a'), s, 'same seed, same scramble');
  }
  assert.notEqual(scramble('UM_TEMPORAL_DECAY', 'seed-a'), scramble('UM_TEMPORAL_DECAY', 'seed-b'));
});

// ── H3 ───────────────────────────────────────────────────────────────────────

test('H3 derangement: a permutation with no fixed point, pairing only disjoint relevant sets; seeded', () => {
  const sets = [['a'], ['b'], ['c', 'd'], ['d'], ['e'], ['f', 'a']];
  const p = derange(sets, 'seed-x', 1000);
  assert.ok(p);
  assert.deepEqual([...p].sort(), [0, 1, 2, 3, 4, 5]);
  p.forEach((j, i) => {
    assert.notEqual(j, i);
    assert.ok(!sets[i].some((x) => sets[j].includes(x)), `${i}→${j} overlap`);
  });
  assert.deepEqual(derange(sets, 'seed-x', 1000), p);
  assert.equal(derange([['a'], ['a', 'b']], 'seed-x', 50), null, 'infeasible → null, no throw');
  assert.equal(derange([['a']], 'seed-x', 50), null);
});

// ── H4 ───────────────────────────────────────────────────────────────────────

test('H4 bootstrap CI: seeded, reproducible, percentile bounds', () => {
  const d = [1, 0, 0, -1, 1, 1, 0, 0, 1, 0, -1, 1, 0, 0, 1];
  const opts = { resamples: 2000, level: 0.95, seedHex: 'abcd', label: 'primary' };
  const a = bootstrapCI(d, opts);
  assert.deepEqual(bootstrapCI(d, opts), a);
  assert.ok(a.lower < a.mean && a.mean < a.upper);
  assert.equal(a.mean, d.reduce((x, y) => x + y, 0) / d.length);
  assert.deepEqual(bootstrapCI([1, 1, 1], opts), { lower: 1, upper: 1, mean: 1 });
  // A continuous sample, so the seed visibly moves the percentile bounds.
  const cont = Array.from({ length: 40 }, (_, i) => Math.sin(i + 1));
  const c = bootstrapCI(cont, opts);
  assert.deepEqual(bootstrapCI(cont, opts), c);
  assert.notDeepEqual(bootstrapCI(cont, { ...opts, seedHex: 'abce' }), c, 'the seed drives the resamples');
  assert.notDeepEqual(bootstrapCI(cont, { ...opts, label: 'c1' }), c, 'each label is its own stream');
  const lbOpts = { resamples: 2000, level: 0.95, seedHex: 'abcd', label: 'c3' };
  const lb = bootstrapLowerBound(cont, lbOpts);
  assert.equal(lb, bootstrapLowerBound(cont, lbOpts));
  const c3two = bootstrapCI(cont, { ...lbOpts });
  assert.ok(lb > c3two.lower && lb < c3two.mean, 'the one-sided 95% bound sits between the two-sided 95% lower bound and the mean');
  assert.equal(bootstrapLowerBound([], lbOpts), null);
});

// ── H5–H8 ────────────────────────────────────────────────────────────────────

const okGuards = { probeOk: true, idSpaceOk: true, plantCodes: [], exclusionFraction: 0.1, passDisagreement: { exact: 0, words: 0 } };
const base = (o = {}) => ({
  guards: okGuards, delta: 0, ci: { lower: -0.05, upper: 0.05 }, recall5: { exact: 0.6, words: 0.6 },
  thinning: { triggered: false }, controls: { c1: { pass: true }, c2: { pass: true }, c3: { eligible: 40, lowerBound: 0.05 } },
  ...o,
});

test('H5 the verdict function covers all five outcomes at their boundaries', () => {
  const v = (o) => decideVerdict(base(o), RULE).verdict;
  assert.equal(v({ delta: 0.1, ci: { lower: 0.001, upper: 0.2 } }), 'GAP');
  assert.equal(v({ delta: 0.0999, ci: { lower: 0.001, upper: 0.2 } }), 'INCONCLUSIVE', 'Δ just under the margin');
  assert.equal(v({ delta: 0.1, ci: { lower: 0, upper: 0.2 } }), 'INCONCLUSIVE', 'lower bound must be > 0');
  assert.equal(v({ delta: -0.1, ci: { lower: -0.2, upper: -0.001 } }), 'REVERSE');
  assert.equal(v({ delta: -0.1, ci: { lower: -0.2, upper: 0 } }), 'INCONCLUSIVE');
  assert.equal(v({ delta: 0, ci: { lower: -0.0999, upper: 0.0999 } }), 'NO-GAP');
  assert.equal(v({ delta: 0, ci: { lower: -0.1, upper: 0.05 } }), 'INCONCLUSIVE', 'the interval (−0.10, +0.10) is open');
  assert.equal(v({ delta: 0.05, ci: { lower: -0.02, upper: 0.12 } }), 'INCONCLUSIVE');
  for (const [g, code] of [
    [{ probeOk: false }, 'probe-below-floor'],
    [{ idSpaceOk: false }, 'id-space-violation'],
    [{ plantCodes: ['plant-j1-accuracy'] }, 'plant-j1-accuracy'],
    [{ exclusionFraction: 0.41 }, 'exclusions-over-cap'],
    [{ passDisagreement: { exact: 0, words: 0.021 } }, 'pass-disagreement'],
  ]) {
    const out = decideVerdict(base({ guards: { ...okGuards, ...g }, delta: 0.3, ci: { lower: 0.2, upper: 0.4 } }), RULE);
    assert.equal(out.verdict, 'VOID', code);
    assert.deepEqual(out.voidReasons, [code]);
  }
  assert.equal(v({ guards: { ...okGuards, exclusionFraction: 0.4 } }), 'NO-GAP', 'exactly 40% is not over the cap');
  assert.equal(v({ guards: { ...okGuards, passDisagreement: { exact: 0.02, words: 0.02 } } }), 'NO-GAP');
});

test('H6 required controls per verdict, applied after downgrades', () => {
  assert.deepEqual(requiredControlsFor('GAP'), ['c2']);
  assert.deepEqual(requiredControlsFor('GAP (seed-carried)'), ['c2']);
  assert.deepEqual(requiredControlsFor('REVERSE'), ['c1']);
  assert.deepEqual(requiredControlsFor('NO-GAP'), ['c1', 'c2']);
  assert.deepEqual(requiredControlsFor('INCONCLUSIVE'), ['c1', 'c2']);
  const gapCi = { delta: 0.2, ci: { lower: 0.1, upper: 0.3 } };
  // GAP needs C2 only.
  assert.equal(decideVerdict(base({ ...gapCi, controls: { c1: { pass: false }, c2: { pass: true }, c3: { eligible: 40, lowerBound: 0.1 } } }), RULE).verdict, 'GAP');
  const failC2 = decideVerdict(base({ ...gapCi, controls: { c1: { pass: true }, c2: { pass: false }, c3: { eligible: 40, lowerBound: 0.1 } } }), RULE);
  assert.deepEqual([failC2.verdict, failC2.voidReasons], ['VOID', ['control-c2-failed']]);
  // GAP (seed-carried) is a GAP first: C2 still required.
  const sc = decideVerdict(base({ ...gapCi, controls: { c1: { pass: false }, c2: { pass: true }, c3: { eligible: 40, lowerBound: -0.01 } } }), RULE);
  assert.equal(sc.verdict, 'GAP (seed-carried)');
  assert.deepEqual(sc.requiredControls, ['c2']);
  // REVERSE needs C1 only ...
  const rev = { delta: -0.2, ci: { lower: -0.3, upper: -0.1 } };
  assert.equal(decideVerdict(base({ ...rev, controls: { c1: { pass: true }, c2: { pass: false }, c3: { eligible: 0, lowerBound: null } } }), RULE).verdict, 'REVERSE');
  // ... but a REVERSE downgraded to INCONCLUSIVE needs both, so a failing C2 now voids it.
  const down = decideVerdict(base({ ...rev, thinning: { triggered: true }, controls: { c1: { pass: true }, c2: { pass: false }, c3: { eligible: 0, lowerBound: null } } }), RULE);
  assert.deepEqual([down.verdict, down.voidReasons], ['VOID', ['control-c2-failed']]);
  const ng = decideVerdict(base({ controls: { c1: { pass: false }, c2: { pass: true }, c3: { eligible: 0, lowerBound: null } } }), RULE);
  assert.deepEqual([ng.verdict, ng.voidReasons], ['VOID', ['control-c1-failed']]);
});

test('H7 class thinning and the discrimination floor downgrade NO-GAP and REVERSE only', () => {
  const thin = { thinning: { triggered: true } };
  assert.equal(decideVerdict(base(thin), RULE).verdict, 'INCONCLUSIVE');
  assert.equal(decideVerdict(base({ ...thin, delta: -0.2, ci: { lower: -0.3, upper: -0.1 } }), RULE).verdict, 'INCONCLUSIVE');
  assert.equal(decideVerdict(base({ ...thin, delta: 0.2, ci: { lower: 0.1, upper: 0.3 } }), RULE).verdict, 'GAP', 'a GAP is unaffected');
  const low = { recall5: { exact: 0.19, words: 0.15 } };
  assert.equal(decideVerdict(base(low), RULE).verdict, 'INCONCLUSIVE');
  assert.equal(decideVerdict(base({ recall5: { exact: 0.2, words: 0.1 } }), RULE).verdict, 'NO-GAP', 'the higher arm at 0.20 passes');
  assert.equal(decideVerdict(base({ ...low, delta: 0.2, ci: { lower: 0.1, upper: 0.3 } }), RULE).verdict, 'GAP');

  // The thinning count runs on doc df ≤ 5 rows BEFORE the single-project filter.
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ class: 'issue-ref', stratum: 'doc', df: 1, role: i < 9 ? 'primary' : 'nonprimary', single_project: i < 9, exclusion: null });
  for (let i = 0; i < 20; i++) rows.push({ class: 'semver', stratum: 'doc', df: 2, role: 'primary', single_project: true, exclusion: i < 10 ? null : 'j2' });
  for (let i = 0; i < 19; i++) rows.push({ class: 'path', stratum: 'doc', df: 1, role: 'primary', single_project: true, exclusion: 'j2' });
  rows.push({ class: 'semver', stratum: 'doc', df: 6, role: 'nonprimary', single_project: true, exclusion: null });
  const t = classThinning(rows, RULE);
  assert.equal(t.triggered, true);
  assert.deepEqual(t.classes, ['issue-ref'], '9 of 20 kept (the project filter thins it); semver keeps 10 of 20; path has 19 rows');
});

test('H8 C3: seed removed before the top-5 cut; ineligible rows skipped; one-sided bound; < min rows labels seed-carried', () => {
  const row = (seed, relevant, eligible, exact, words) => ({ seed_id: seed, relevant, c3_eligible: eligible, ranked: { exact, words } });
  const rows = [
    // Seed at rank 1 in the words arm; another relevant doc sits at rank 6 and moves into the top 5.
    row('S', ['S', 'R'], true, ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'], ['S', 'y1', 'y2', 'y3', 'y4', 'R']),
    // Not eligible (no other isDoc relevant doc): skipped.
    row('S2', ['S2'], false, ['S2'], ['S2']),
    // Exact finds only the seed: held out, it misses.
    row('T', ['T', 'U'], true, ['T', 'z1', 'z2', 'z3', 'z4', 'z5', 'U'], ['U']),
  ];
  const h = heldOutDeltas(rows, 5);
  assert.equal(h.eligible, 2);
  assert.deepEqual(h.deltas, [1, 1]);
  const out = (eligible, lowerBound) => decideVerdict(base({ delta: 0.2, ci: { lower: 0.1, upper: 0.3 }, controls: { c1: { pass: true }, c2: { pass: true }, c3: { eligible, lowerBound } } }), RULE).verdict;
  assert.equal(out(30, 0.01), 'GAP');
  assert.equal(out(30, 0), 'GAP (seed-carried)', 'the one-sided lower bound must be > 0');
  assert.equal(out(29, 0.5), 'GAP (seed-carried)', 'fewer than 30 eligible rows');
  assert.equal(out(0, null), 'GAP (seed-carried)', 'none eligible: no throw');
  assert.deepEqual(heldOutDeltas([], 5), { eligible: 0, deltas: [] });
});

// ── H9, H10, P2, P3 (subcommands through run) ────────────────────────────────

test('P2 build + score end to end: a verdict is written, and the tracked output holds no fixture string', async () => {
  const ctx = await e2e();
  const s = await score(ctx);
  assert.equal(s.code, 0, s.outLines.join('\n'));
  assert.equal(s.opened, 1);
  assert.deepEqual(s.files, ['2026-10-12-exact-token-203.json']);
  const written = readFileSync(join(s.resultsDir, s.files[0]), 'utf8');
  const result = JSON.parse(written);
  assert.notEqual(result.verdict, 'VOID', written);
  assert.ok(['GAP', 'GAP (seed-carried)', 'NO-GAP', 'REVERSE', 'INCONCLUSIVE'].includes(result.verdict));
  assert.equal(result.census.first_prompts.total, 6, 'the census ran inside score');
  assert.equal(typeof result.primary.delta, 'number');
  assert.equal(result.hashes.corpus.length, 64);
  const tracked = written + s.outLines.join('\n') + ctx.buildOut.join('\n');
  for (const needle of fixtureStrings(ctx.arc)) assert.ok(!tracked.includes(needle), `tracked output carries ${JSON.stringify(needle)}`);
  // Row-level outcomes go to the arc dir only.
  assert.ok(existsSync(join(ctx.arc, 'score-rows.jsonl')));
  // Revision 1: the validator ran (stubbed), and the result passes the extended
  // allowlist with the validator and the filtered denominators in it.
  assert.ok(ctx.llm.calls.some((c) => c.kind === 'v1') && ctx.llm.calls.some((c) => c.kind === 'v2') && ctx.llm.calls.some((c) => c.kind === 'v3'));
  assert.doesNotThrow(() => assertAllowlisted(result, resultSchema(loaded(fixtureRule()))));
  assert.equal(result.models.validator, TRACKED.models.validator.model);
  for (const kind of ['leaky', 'near_miss', 'split']) {
    const p = result.guards.plants[kind];
    assert.equal(typeof p.attempted, 'number', kind);
    assert.deepEqual(Object.keys(p.two_by_two).sort(), ['confirmed_correct', 'confirmed_miss', 'unconfirmed_correct', 'unconfirmed_miss'], kind);
  }
  assert.equal(typeof result.guards.plants.split.structural, 'boolean');
});

test('P3 a forced VOID with an injected id-space violation writes codes only', async () => {
  const ctx = await e2e();
  const idx = makeStubIndex(CORPUS_POINTS, { inject: (q, results) => (q === 'gearbox rotation preview' ? [{ id: 'not-a-corpus-id', score: 1 }, ...results] : results) });
  const s = await score(ctx, { index: idx });
  assert.equal(s.code, 0, s.outLines.join('\n'));
  const written = readFileSync(join(s.resultsDir, s.files[0]), 'utf8');
  const result = JSON.parse(written);
  assert.equal(result.verdict, 'VOID');
  assert.deepEqual(result.void_reasons, ['id-space-violation']);
  const all = written + s.outLines.join('\n');
  assert.ok(!all.includes('not-a-corpus-id'));
  assert.ok(!/ID-SPACE VIOLATION/.test(all), 'never the exception text');
  for (const needle of fixtureStrings(ctx.arc)) assert.ok(!all.includes(needle), needle);
  assert.ok(!existsSync(join(ctx.arc, 'score-rows.jsonl')), 'no per-arm row outcome on a VOID');
});

test('H10b a forced VOID (plants fail) writes reasons, guards and census only: no Δ, CI or class table', async () => {
  const llm = makeStubLlm({ judgeOverride: ({ kind }) => (kind === 'j1' ? 'YES' : undefined) });
  const ctx = await e2e({ llm });
  const s = await score(ctx);
  assert.equal(s.code, 0, s.outLines.join('\n'));
  const written = readFileSync(join(s.resultsDir, s.files[0]), 'utf8');
  const result = JSON.parse(written);
  assert.equal(result.verdict, 'VOID');
  assert.ok(result.void_reasons.includes('plant-j1-accuracy'));
  assert.equal(result.census.first_prompts.total, 6, 'Goal 2\'s number survives a VOID');
  const all = written + s.outLines.join('\n');
  for (const k of ['delta', '"ci"', 'per_class', 'per_df_band', 'recall', 'mcnemar', 'thinning', 'controls']) {
    assert.ok(!all.includes(k), `VOID output carries ${k}`);
  }
});

test('H9 a throw after the verdict function → VOID post-verdict-error', async () => {
  const ctx = await e2e();
  const s = await score(ctx, { faults: { afterVerdict: () => { throw new Error('boom FAKE_ALPHA_FLAG'); } } });
  const result = JSON.parse(readFileSync(join(s.resultsDir, s.files[0]), 'utf8'));
  assert.equal(result.verdict, 'VOID');
  assert.deepEqual(result.void_reasons, ['post-verdict-error']);
  assert.ok(!s.outLines.join('\n').includes('boom'));
  assert.ok(!existsSync(join(ctx.arc, 'score-rows.jsonl')));
});

test('H9 (review I-1) a throw from INSIDE the verdict call is VOID post-verdict-error, never a refusal', async () => {
  const ctx = await e2e();
  let called = 0;
  const s = await score(ctx, { faults: { decideVerdict: () => { called++; throw new Error('verdict blew up FAKE_ALPHA_FLAG'); } } });
  assert.equal(called, 1, 'the injected verdict function was called (else the case is vacuous)');
  assert.equal(s.code, 0, s.outLines.join('\n'));
  const result = JSON.parse(readFileSync(join(s.resultsDir, s.files[0]), 'utf8'));
  assert.equal(result.verdict, 'VOID');
  assert.deepEqual(result.void_reasons, ['post-verdict-error']);
  assert.equal(result.census.first_prompts.total, 6, 'the record still carries the census');
  const out = s.outLines.join('\n');
  assert.doesNotMatch(out, /"status":"refused"|internal-error|blew up/);
  assert.ok(!existsSync(join(ctx.arc, 'score-rows.jsonl')));
});

test('H9 (review I-1) when even the VOID record cannot be written: the distinct code post-verdict-write-failed', async () => {
  const ctx = await e2e();
  // A results "directory" under a regular file: every write there fails.
  const blocker = join(ctx.sb.root, 'not-a-dir');
  writeFileSync(blocker, 'x');
  const s = await score(ctx, { resultsDir: join(blocker, 'results') });
  assert.equal(s.code, 3);
  const out = s.outLines.join('\n');
  assert.match(out, /"code":"post-verdict-write-failed"/);
  assert.doesNotMatch(out, /"status":"refused"/, 'never mistakable for a pre-verdict refusal');
  assert.ok(!existsSync(join(ctx.arc, 'score-rows.jsonl')));
  assert.ok(RULE.codes.void_reasons.includes('post-verdict-write-failed'));
});

test('review item 6: score refuses while ANY earlier result (any date) or row file exists', async () => {
  const ctx = await e2e();
  const results = join(ctx.sb.repo, 'server', 'eval', 'results');
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, '2026-10-01-exact-token-203.json'), '{}\n');
  const s = await score(ctx);
  assert.notEqual(s.code, 0);
  assert.match(s.outLines.join('\n'), /result-exists/);
  assert.equal(s.opened, 0);
  // Other result files do not block it.
  const ctx2 = await e2e();
  const r2 = join(ctx2.sb.repo, 'server', 'eval', 'results');
  mkdirSync(r2, { recursive: true });
  writeFileSync(join(r2, '2026-07-28-exact-token-gap.json'), '{}\n');
  assert.equal((await score(ctx2)).code, 0);
  // A row file left in the arc dir blocks it too.
  const ctx3 = await e2e();
  writeFileSync(join(ctx3.arc, 'score-rows.jsonl'), '\n');
  const s3 = await score(ctx3);
  assert.notEqual(s3.code, 0);
  assert.match(s3.outLines.join('\n'), /result-exists/);
});

test('review item 7: the probe samples only what doSearch can return (recallableOnly); the July default is unchanged', async () => {
  const pts = [
    { id: 'q1', payload: { id: 'sup', data: 'Session summary: a superseded note.', status: 'superseded', userId: 'golden' } },
    { id: 'q2', payload: { id: 'inv', data: 'Session summary: an invalidated note.', invalidated_at: '2026-01-01T00:00:00Z', userId: 'golden' } },
    { id: 'q3', payload: { id: '_um_embedding_stamp', data: 'stamp text under the pinned user', userId: 'golden' } },
    { id: 'q4', payload: { id: 'live', data: 'Session summary: a live note.', userId: 'golden' } },
    { id: 'q5', payload: { data: 'a live fact', userId: 'golden' } },
  ];
  const idx = makeStubIndex(pts);
  const july = await verbatimProbe(idx.doSearch, idx.memory, pts, 20, 0.9);
  assert.equal(july.per.doc.n, 3, 'the July default still samples superseded and invalidated docs');
  assert.equal(july.per.fact.n, 2);
  const live = await verbatimProbe(idx.doSearch, idx.memory, pts, 20, 0.9, { recallableOnly: true });
  assert.equal(live.per.doc.n, 1);
  assert.equal(live.per.fact.n, 1, 'the system doc is not sampled');
});

test('H10a score refuses before any clone when a read-path flag is on or the embedder differs', async () => {
  const ctx = await e2e();
  for (const [env, code] of [
    [{ ...ctx.env, UM_TEMPORAL_QUERY: 'true' }, 'env-temporal-flag'],
    [{ ...ctx.env, UM_TEMPORAL_DECAY: 'true' }, 'env-temporal-flag'],
    [{ ...ctx.env, UM_EMBEDDING_MODEL: 'text-embedding-3-large' }, 'embedder-mismatch'],
  ]) {
    const s = await score(ctx, { env });
    assert.notEqual(s.code, 0);
    assert.equal(s.opened, 0, 'no clone opened');
    assert.match(s.outLines.join('\n'), new RegExp(code));
    assert.deepEqual(s.files, []);
  }
  // 'false' is not 'true': the run proceeds.
  const ok = await score(ctx, { env: { ...ctx.env, UM_TEMPORAL_DECAY: 'false' } });
  assert.equal(ok.code, 0, ok.outLines.join('\n'));
});

test('build refuses a corpus point under a third user id; score refuses a second scored run', async () => {
  const pts = CORPUS_POINTS.map((p, i) => (i === 3 ? { ...p, payload: { ...p.payload, userId: 'someone-else' } } : p));
  const sb = makeGitSandbox();
  sb.write(RULE_REL_PATH, ruleBytes(fixtureRule()));
  sb.commitAll('base');
  const arc = join(sb.root, 'arc');
  mkdirSync(arc);
  writeFileSync(join(arc, 'corpus.json'), JSON.stringify(pts));
  const out = [];
  assert.notEqual(await run(['build', '--arc-dir', arc], { repoDir: sb.repo, env: cleanEnv(sb.env), out: (l) => out.push(l), llm: makeStubLlm(), now: NOW }), 0);
  assert.match(out.join('\n'), /corpus-user-id-mismatch/);
  assert.ok(!existsSync(join(arc, 'query-set.jsonl')));

  const ok = await e2e();
  assert.equal((await score(ok)).code, 0);
  const again = await score(ok);
  assert.notEqual(again.code, 0);
  assert.match(again.outLines.join('\n'), /result-exists/);
});

test('build refuses a point created on or after the corpus cutoff', async () => {
  const pts = CORPUS_POINTS.map((p, i) => (i === 0 ? { ...p, payload: { ...p.payload, createdAt: '2026-10-09T00:00:00.000Z' } } : p));
  const sb = makeGitSandbox();
  sb.write(RULE_REL_PATH, ruleBytes(fixtureRule()));
  sb.commitAll('base');
  const arc = join(sb.root, 'arc');
  mkdirSync(arc);
  writeFileSync(join(arc, 'corpus.json'), JSON.stringify(pts));
  const out = [];
  assert.notEqual(await run(['build', '--arc-dir', arc], { repoDir: sb.repo, env: cleanEnv(sb.env), out: (l) => out.push(l), llm: makeStubLlm(), now: NOW }), 0);
  assert.match(out.join('\n'), /corpus-cutoff-violated/);
});

test('the CLI takes only --arc-dir with an absolute path', async () => {
  const out = [];
  const deps = { repoDir: tempDir('um-et203-cli-'), out: (l) => out.push(l) };
  assert.notEqual(await run(['score'], deps), 0);
  assert.notEqual(await run(['score', '--arc-dir', 'relative/path'], deps), 0);
  assert.notEqual(await run(['score', '--arc-dir', '/abs', '--rule', '/x'], deps), 0);
  assert.notEqual(await run(['bogus', '--arc-dir', '/abs'], deps), 0);
  assert.ok(out.every((l) => /"code":"usage"/.test(l)), out.join('\n'));
});

// ── build pieces: H11–H14, prompts ───────────────────────────────────────────

test('H11 calibrate scores non-primary rows only and prints PASS/FAIL, never a recall figure', async () => {
  const ctx = await e2e({ anchor: false });
  const { rows } = readQuerySet(ctx.arc);
  const primary = rows.filter((r) => r.role === 'primary');
  assert.ok(primary.length > 0);
  const idx = makeStubIndex(CORPUS_POINTS);
  const out = [];
  const code = await run(['calibrate', '--arc-dir', ctx.arc], {
    repoDir: ctx.sb.repo, env: ctx.env, out: (l) => out.push(String(l)), now: NOW, openIndex: async () => idx,
  });
  assert.equal(code, 0, out.join('\n'));
  const forbidden = new Set(primary.flatMap((r) => [r.identifier, r.gloss].filter(Boolean)));
  for (const q of idx.searches) assert.ok(!forbidden.has(q), `calibrate searched a primary row's query: ${q}`);
  assert.ok(idx.searches.length > 0);
  const text = out.join('\n');
  assert.doesNotMatch(text, /recall|delta/i);
  assert.doesNotMatch(text, /\d\.\d/, 'no fraction of any kind');
  for (const check of ['query-set-binding', 'clone-integrity', 'verbatim-probe', 'id-space', 'determinism']) assert.match(text, new RegExp(`${check}.*PASS`));
  assert.ok(listAll(ctx.arc).every((f) => !f.startsWith('score') && !f.startsWith('calibrat')), 'calibrate writes no file');
  // The row filter itself refuses a primary row.
  assert.deepEqual(calibrationQueries([primary[0]]), { ok: false, code: 'calibrate-primary-row' });
  const nonp = rows.filter((r) => r.role !== 'primary');
  const cq = calibrationQueries(nonp);
  assert.equal(cq.ok, true);
  assert.ok(cq.queries.every((q) => !forbidden.has(q.text)));
});

test('H12 cross-document neighbours: same class, not in the row\'s docs, top 3 by Jaccard, salted ties, stable', () => {
  const r = loaded(fixtureRule());
  const a = buildPopulationRows(CORPUS_POINTS, r);
  const b = buildPopulationRows(CORPUS_POINTS.map((p) => structuredClone(p)).reverse(), r);
  const alpha = a.rows.find((x) => x.identifier === 'FAKE_ALPHA_FLAG');
  // Revision 1 fixture: FAKE_DESK_FLAG (same class, the closest window) joins the
  // top 3; FAKE_GAMMA_FLAG and FAKE_DELTA_FLAG tie at Jaccard 0 and the salted
  // hash keeps FAKE_DELTA_FLAG. J2's neighbours stay project-agnostic.
  assert.deepEqual(alpha.cross.map((c) => c.identifier).sort(), ['FAKE_BETA_FLAG', 'FAKE_DELTA_FLAG', 'FAKE_DESK_FLAG'],
    'UM_COMMON_TAG occurs in a relevant doc and is excluded');
  assert.equal(alpha.cross[0].identifier, 'FAKE_DESK_FLAG', 'the highest Jaccard first');
  assert.equal(alpha.cross[2].identifier, 'FAKE_DELTA_FLAG');
  assert.ok(saltedHash(r.salts.neighbour_tiebreak, 'FAKE_DELTA_FLAG') < saltedHash(r.salts.neighbour_tiebreak, 'FAKE_GAMMA_FLAG'),
    'the tie with FAKE_GAMMA_FLAG is broken by the salted hash');
  for (const c of alpha.cross) assert.equal(classOf(c.identifier), 'screaming-snake');
  const dry = a.rows.find((x) => x.identifier === '--dry-crank');
  assert.deepEqual(dry.cross.map((c) => c.identifier), ['--slow-crank']);
  assert.equal(a.rows.find((x) => x.identifier === 'spin_up()').cross.length, 0, 'a class of one has k = 0');
  // Identical across two builds (point order does not matter).
  const pick = (res) => res.rows.map((x) => [x.identifier, x.cross.map((c) => c.identifier)]).sort();
  assert.deepEqual(pick(b), pick(a));
  // Ordered by Jaccard, ties broken by salted hash.
  for (let i = 1; i < alpha.cross.length; i++) {
    const [p, c] = [alpha.cross[i - 1], alpha.cross[i]];
    assert.ok(p.jaccard >= c.jaccard);
    if (p.jaccard === c.jaccard) assert.ok(saltedHash(r.salts.neighbour_tiebreak, p.identifier) < saltedHash(r.salts.neighbour_tiebreak, c.identifier));
  }
  // A forced tie: two neighbours with identical windows come back in salted-hash order.
  const twin = (id, ident) => ({ id: `pt-${id}`, vector: [0], payload: { id, data: `Session summary: topicmu. ${ident} drives the same spindle motor.`, userId: 'golden', project: 'proj-a' } });
  const wide = loaded(fixtureRule((x) => { x.gloss.cross_doc_neighbours = 5; return x; }));
  const tied = buildPopulationRows([...CORPUS_POINTS, twin('t1', 'FAKE_TWIN_ONE'), twin('t2', 'FAKE_TWIN_TWO')], wide);
  const tAlpha = tied.rows.find((x) => x.identifier === 'FAKE_ALPHA_FLAG');
  assert.equal(tAlpha.cross.length, 5);
  const twins = tAlpha.cross.filter((c) => c.identifier.startsWith('FAKE_TWIN'));
  assert.equal(twins.length, 2);
  assert.equal(twins[0].jaccard, twins[1].jaccard);
  assert.ok(saltedHash(r.salts.neighbour_tiebreak, twins[0].identifier) < saltedHash(r.salts.neighbour_tiebreak, twins[1].identifier));
});

test('H13 nested candidates excluded; nearest non-nested in-window donor; multi-project rows ineligible', () => {
  const r = loaded(fixtureRule());
  const { rows } = buildPopulationRows(CORPUS_POINTS, r);
  const v = rows.find((x) => x.identifier === 'v7.1.2');
  assert.ok(!v.in_window.some((c) => c.identifier === '7.1.2'), '7.1.2 is nested in v7.1.2');
  assert.deepEqual(v.in_window.map((c) => c.identifier), ['UM_COMMON_TAG']);
  assert.ok(v.options.includes('v7.1.2') && !v.options.includes('7.1.2'));
  const w = rows.find((x) => x.identifier === 'lib/widget.mjs');
  // Both FAKE_ALPHA_FLAG and UM_COMMON_TAG are in its window. Revision 1: the
  // in-window donor list is the non-nested candidates nearest first, so the
  // nearer one is the first donor tried (rank 1).
  const byDist = w.in_window.slice().sort((x, y) => Math.abs(x.pos - w.window.pos) - Math.abs(y.pos - w.window.pos));
  assert.equal(byDist.length, 2);
  const inPlan = buildPopulationRows(CORPUS_POINTS, loaded(fixtureRule((x) => { x.salts.donor_type = saltFor('lib/widget.mjs', 'in-window'); return x; })));
  const wIn = inPlan.rows.find((x) => x.identifier === 'lib/widget.mjs');
  assert.equal(wIn.donor.type, 'in-window');
  assert.deepEqual(wIn.donor.candidates.map((c) => c.identifier), byDist.map((c) => c.identifier), 'nearest first, both non-nested');
  const beta = rows.find((x) => x.identifier === 'FAKE_BETA_FLAG');
  assert.equal(beta.single_project, false);
  assert.notEqual(beta.role, 'primary');
  // Revision 1 fixture: FAKE_DESK_FLAG (two `desktop` docs) is a tenth primary row.
  assert.equal(rows.filter((x) => x.role === 'primary').length, 10);
  assert.equal(rows.find((x) => x.identifier === 'UM_COMMON_TAG').role, 'nonprimary', 'df 6 > 5');
  assert.equal(rows.find((x) => x.identifier === 'FAKE_GAMMA_FLAG').role, 'fact-control');
  // Donor types follow the seeded hash, falling back when a type is unavailable.
  // Revision 1: row.donor carries the type's donor LIST (≤ near_miss_donor_attempts,
  // in the type's own order, each without a nested twin in the candidate set).
  for (const x of rows.filter((y) => y.role === 'primary' && y.donor)) {
    const assigned = parseInt(saltedHash(r.salts.donor_type, x.identifier).slice(0, 8), 16) % 2 === 0 ? 'cross' : 'in-window';
    assert.equal(x.donor.assigned, assigned, x.identifier);
    if (assigned === 'cross' && x.cross.length) assert.equal(x.donor.type, 'cross');
    if (assigned === 'in-window' && x.in_window.length) assert.equal(x.donor.type, 'in-window');
    const pool = x.donor.type === 'cross' ? x.cross : x.in_window;
    const set = [x.identifier, ...x.in_window.map((c) => c.identifier), ...x.cross.map((c) => c.identifier)];
    const free = pool.filter((c) => !set.some((o) => o !== c.identifier && (o.includes(c.identifier) || c.identifier.includes(o))));
    assert.ok(x.donor.candidates.length >= 1 && x.donor.candidates.length <= r.plants.near_miss_donor_attempts, x.identifier);
    assert.deepEqual(x.donor.candidates.map((c) => c.identifier), free.slice(0, r.plants.near_miss_donor_attempts).map((c) => c.identifier), x.identifier);
  }
});

test('D4 ruling (PR 2 review): a doc-stratum row always gets the paragraph window; a short fact seed is its own window', () => {
  const r = loaded(fixtureRule());
  const pts = [
    { id: 'pt-p1', vector: [0], payload: { id: 'para-doc', userId: 'golden', project: 'proj-a',
      data: 'Session summary: topicnu.\n\nFAKE_PARA_FLAG drives the loom shuttle.\n\nAn unrelated closing paragraph about the orchard.' } },
    { id: 'pt-p2', vector: [0], payload: { userId: 'golden', project: 'proj-a', data: 'kiln notes\n\nFAKE_FACT_PARA toggles the kiln.' } },
  ];
  const { rows } = buildPopulationRows(pts, r);
  const doc = rows.find((x) => x.identifier === 'FAKE_PARA_FLAG');
  assert.equal(doc.stratum, 'doc');
  assert.ok(pts[0].payload.data.length <= r.gloss.window_chars, 'the seed is under the cap (else the case is vacuous)');
  assert.equal(doc.window.text, 'FAKE_PARA_FLAG drives the loom shuttle.');
  const fact = rows.find((x) => x.identifier === 'FAKE_FACT_PARA');
  assert.equal(fact.stratum, 'fact');
  assert.equal(fact.window.text, pts[1].payload.data);
});

test('D4 ruling (PR 2 review): points sharing a document id — every text kept; the window comes from the text holding the identifier', () => {
  const r = loaded(fixtureRule());
  const summary = (s) => `Session summary: ${s}`;
  const pts = [
    // Same payload.id; by point id, the first text lacks the row's identifier but names another.
    { id: 'pt-dup-a', vector: [0], payload: { id: 'dup-1', userId: 'golden', project: 'proj-a', data: summary('topicxi. FAKE_OTHER_FLAG guards the dye vat.') } },
    { id: 'pt-dup-b', vector: [0], payload: { id: 'dup-1', userId: 'golden', project: 'proj-a', data: summary('topicxi. FAKE_DUP_FLAG gates the spool winder.') } },
    { id: 'pt-x', vector: [0], payload: { id: 'doc-x', userId: 'golden', project: 'proj-a', data: summary('topicomicron. FAKE_OTHER_FLAG also guards the rinse tank.') } },
    { id: 'pt-y', vector: [0], payload: { id: 'doc-y', userId: 'golden', project: 'proj-a', data: summary('topicpi. FAKE_THIRD_FLAG gates the spool winder too.') } },
  ];
  for (const order of [pts, [...pts].reverse()]) {
    const { rows, index } = buildPopulationRows(order, r);
    assert.deepEqual(index.byId.get('dup-1').texts, [pts[0].payload.data, pts[1].payload.data], 'every text, in point-id order');
    const dup = rows.find((x) => x.identifier === 'FAKE_DUP_FLAG');
    assert.ok(dup, 'the row exists (the old index kept one text per id and threw here)');
    assert.deepEqual(dup.relevant, ['dup-1']);
    assert.match(dup.window.text, /FAKE_DUP_FLAG gates the spool winder/, 'window from the second text');
    // FAKE_OTHER_FLAG occurs only in dup-1's OTHER text: still excluded as a neighbour.
    assert.ok(!dup.cross.some((c) => c.identifier === 'FAKE_OTHER_FLAG'), 'the exclusion reads every text of the relevant doc');
    assert.ok(dup.cross.some((c) => c.identifier === 'FAKE_THIRD_FLAG'), 'a genuine other-document neighbour stays');
  }
});

test('H13 J2: NONE and SEVERAL both exclude; plant accuracy is computed per donor type', async () => {
  const several = makeStubLlm({ judgeOverride: ({ kind, meta }) => (kind === 'j2' && meta.phrase === 'gearbox rotation preview' ? 'SEVERAL' : undefined) });
  const ctx = await e2e({ llm: several, anchor: false });
  const { rows, header } = readQuerySet(ctx.arc);
  assert.equal(rows.find((x) => x.identifier === '--dry-crank').exclusion, 'j2');
  const none = makeStubLlm({ judgeOverride: ({ kind, meta }) => (kind === 'j2' && meta.phrase === 'turbine harness boot' ? 'NONE' : undefined) });
  const ctx2 = await e2e({ llm: none, anchor: false });
  assert.equal(readQuerySet(ctx2.arc).rows.find((x) => x.identifier === 'spin_up()').exclusion, 'j2');
  const r = loaded(fixtureRule());
  const ps = plantSummary(rows, header, r);
  assert.ok(ps.near_miss.by_type['in-window'].rows + ps.near_miss.by_type.cross.rows === ps.near_miss.rows);
  assert.ok(ps.near_miss.rows > 0);
  for (const t of ['in-window', 'cross']) {
    const b = ps.near_miss.by_type[t];
    assert.equal(b.accuracy, b.rows ? b.correct / b.rows : null);
  }
  // Each near-miss plant row records its uniform-random baseline 1/(c+2).
  for (const x of rows.filter((y) => y.plants?.near_miss)) assert.equal(x.plants.near_miss.chance, 1 / (x.plants.near_miss.c + 2));
});

test('H14 J3: df ≥ 2 rows get one window per relevant doc; non-SAME excludes; the split plant swaps one window from a same-project donor, V3-confirmed', async () => {
  const ctx = await e2e({ anchor: false });
  const j3 = ctx.llm.calls.filter((c) => c.kind === 'j3');
  const alphaCalls = j3.filter((c) => c.meta.identifier === 'FAKE_ALPHA_FLAG');
  assert.equal(alphaCalls.length, 2, 'one real check and one split-referent plant (its first donor is confirmed)');
  const [real, plant] = alphaCalls[0].meta.split ? [alphaCalls[1], alphaCalls[0]] : alphaCalls;
  assert.equal(real.meta.windows.length, 2, 'df 2 → two windows');
  assert.ok(real.meta.windows.every((w) => w.includes('FAKE_ALPHA_FLAG')));
  assert.equal(plant.meta.windows.length, 2);
  assert.ok(plant.meta.windows.every((w) => w.includes('FAKE_ALPHA_FLAG')), 'the swapped window carries this row\'s identifier');
  const swapped = plant.meta.windows.filter((w) => !real.meta.windows.includes(w));
  assert.equal(swapped.length, 1, 'exactly one (non-seed) window replaced');
  const { rows } = readQuerySet(ctx.arc);
  const alpha = rows.find((x) => x.identifier === 'FAKE_ALPHA_FLAG');
  assert.ok(!swapped[0].includes(alpha.window.text), 'the seed window is never the one replaced');
  assert.equal(alpha.j3, 'SAME');
  // Revision 1 (spec §8.2 R1): the donor is alpha's top same-project donor (proj-a;
  // FAKE_BETA_FLAG has a proj-b doc and FAKE_DESK_FLAG is `desktop`), V3 confirmed
  // it (NO = clearly different) and the plant counts.
  const plan = buildPopulationRows(CORPUS_POINTS, loaded(fixtureRule())).rows.find((x) => x.identifier === 'FAKE_ALPHA_FLAG');
  assert.deepEqual(plan.split_donors.map((d) => d.identifier).sort(), ['FAKE_DELTA_FLAG', 'FAKE_GAMMA_FLAG']);
  assert.equal(alpha.split_eligibility, 'donor');
  const atts = alpha.plants.split.attempts;
  assert.equal(atts.length, 1);
  assert.deepEqual(
    [atts[0].rank, atts[0].donor, atts[0].validator, atts[0].confirmed, atts[0].answer, atts[0].correct],
    [1, plan.split_donors[0].identifier, 'NO', true, 'DIFFERENT', true]);
  assert.equal(swapped[0], plan.split_donors[0].window.text.split(plan.split_donors[0].identifier).join('FAKE_ALPHA_FLAG'));
  const v3 = ctx.llm.calls.filter((c) => c.kind === 'v3' && c.meta.identifier === 'FAKE_ALPHA_FLAG');
  assert.equal(v3.length, 1);
  assert.deepEqual(v3[0].meta.windows, [alpha.window.text, swapped[0]], 'V3 sees the seed window and the relabelled passage J3 sees');
  // The catch-all-project row has its own J3 check but carries no split plant.
  const desk = rows.find((x) => x.identifier === 'FAKE_DESK_FLAG');
  assert.equal(desk.j3, 'SAME');
  assert.equal(desk.plants.split, null);
  assert.equal(desk.split_eligibility, 'catch-all');
  assert.ok(!ctx.llm.calls.some((c) => c.kind === 'v3' && c.meta.identifier === 'FAKE_DESK_FLAG'));
  // df = 1 rows skip J3.
  for (const x of rows.filter((y) => y.df === 1)) assert.equal(x.j3, null, x.identifier);
  assert.ok(!j3.some((c) => rows.find((y) => y.identifier === c.meta.identifier)?.df === 1));
  // Anything but SAME excludes.
  const unsure = makeStubLlm({ judgeOverride: ({ kind, meta }) => (kind === 'j3' && !meta.split ? 'UNSURE' : undefined) });
  const ctx2 = await e2e({ llm: unsure, anchor: false });
  assert.equal(readQuerySet(ctx2.arc).rows.find((x) => x.identifier === 'FAKE_ALPHA_FLAG').exclusion, 'j3');
});

test('prompts fence every window with a random per-call nonce and say the content is data', async () => {
  const ctx = await e2e({ anchor: false });
  const nonces = new Set();
  for (const c of ctx.llm.calls) {
    const m = [...c.prompt.matchAll(/<<<DATA ([0-9a-f]{16,})>>>/g)];
    assert.ok(m.length >= 1, `${c.kind} prompt has no fence`);
    const n = m[0][1];
    assert.ok(m.every((x) => x[1] === n), 'one nonce per call');
    assert.ok(c.prompt.includes(`<<<END DATA ${n}>>>`));
    assert.match(c.prompt, /quoted data/);
    nonces.add(n);
  }
  assert.equal(nonces.size, ctx.llm.calls.length, 'a fresh nonce on every call');
  // Generator and judges see windows, never a whole document longer than the cap.
  const { rows } = readQuerySet(ctx.arc);
  for (const x of rows) assert.ok(x.window.text.length <= RULE.gloss.window_chars);
  // The G-shape retry path ran once (the stub's first attempt carries a digit).
  const relay = rows.find((x) => x.identifier === 'relay-a:8080');
  assert.equal(relay.gloss_attempts, 2);
  assert.equal(relay.exclusion, null);
  assert.equal(rows.find((x) => x.identifier === '#4101').exclusion, 'unglossable');
});

test('build prints a counts-only summary and records E and the build number', async () => {
  const ctx = await e2e({ anchor: false });
  const { header } = readQuerySet(ctx.arc);
  assert.equal(header.E, 10, 'revision 1 fixture: FAKE_DESK_FLAG is a tenth primary row');
  assert.equal(header.schema, 'exact-token-203-query-set/2');
  assert.equal(header.build_number, 1);
  const summary = JSON.parse(ctx.buildOut.at(-1));
  assert.equal(summary.query_set_sha256, sha(readFileSync(join(ctx.arc, 'query-set.jsonl'))), 'the summary names the bytes it wrote');
  assert.match(header.rule_sha256, /^[0-9a-f]{64}$/);
  for (const needle of fixtureStrings(ctx.arc)) assert.ok(!ctx.buildOut.join('\n').includes(needle), needle);
  // A rebuild keeps the earlier query set beside the new one.
  const out = [];
  assert.equal(await run(['build', '--arc-dir', ctx.arc], { repoDir: ctx.sb.repo, env: ctx.env, out: (l) => out.push(l), llm: makeStubLlm(), now: NOW }), 0);
  assert.equal(readQuerySet(ctx.arc).header.build_number, 2);
  assert.ok(listAll(ctx.arc).includes('query-set.build-1.jsonl'));
});

// ── P1 ───────────────────────────────────────────────────────────────────────

test('P1 the aggregate writer rejects any key outside its allowlist, and any free-text string', () => {
  const schema = resultSchema(RULE);
  const good = { schema: 'exact-token-203-result/1', verdict: 'VOID', void_reasons: ['probe-below-floor'], d10_branch: 'keep-open-void' };
  assert.doesNotThrow(() => assertAllowlisted(good, schema));
  assert.throws(() => assertAllowlisted({ ...good, identifier: 'x' }, schema), /allowlist/);
  assert.throws(() => assertAllowlisted({ ...good, verdict: 'FAKE_ALPHA_FLAG' }, schema), /allowlist/);
  assert.throws(() => assertAllowlisted({ ...good, void_reasons: ['lib/widget.mjs'] }, schema), /allowlist/);
  assert.throws(() => assertAllowlisted({ ...good, guards: { probe: { fact: { n: 'doc-1' } } } }, schema), /allowlist/);
  assert.throws(() => assertAllowlisted({ ...good, per_class: { 'not-a-class': { n: 1 } } }, schema), /allowlist/);
});

// ── Revision 1 (spec §8): plant validation — H15–H19 ─────────────────────────

/** A 32-hex salt under which `identifier`'s seeded donor type is `type` (a test-only search). */
function saltFor(identifier, type) {
  for (let i = 0; ; i++) {
    const salt = sha(`et203-test-salt-${i}`).slice(0, 32);
    const t = parseInt(saltedHash(salt, identifier).slice(0, 8), 16) % 2 === 0 ? 'cross' : 'in-window';
    if (t === type) return salt;
  }
}

/** runBuild over an in-memory fixture: no git, no I/O. */
const buildDirect = (points, rule, llm) => runBuild({
  points, rule, ruleSha256: 'a'.repeat(64), corpusSha256: 'b'.repeat(64), llm, now: NOW, buildNumber: 1, pointsWithoutCreatedAt: 0,
});

const sdoc = (id, project, text) => ({
  id: `pt-${id}`, vector: [0],
  payload: { id, data: `Session summary: ${text}`, userId: 'golden', createdAt: '2026-09-15T00:00:00.000Z', ...(project === null ? {} : { project }) },
});

/**
 * H16's split corpus. FAKE_SPLIT_FLAG (proj-s, df 3: s06 holds it inside
 * FAKE_SPLIT_FLAG_WIDE) has four eligible donors in descending window overlap,
 * and four refused ones that overlap more: a donor with one doc in proj-t, a
 * proj-t donor, X ⊃ Y and X ⊂ Y. Three df-2 rows sit in the catch-all projects
 * (each with a same-project donor), and one df-2 row has no same-project donor.
 */
const SPLIT_POINTS = [
  sdoc('s01', 'proj-s', 'topicsa. FAKE_SPLIT_FLAG gates the loom shuttle tension.'),
  sdoc('s02', 'proj-s', 'topicsb. FAKE_SPLIT_FLAG gates the loom shuttle tension again.'),
  sdoc('s03', 'proj-s', 'topicsc. FAKE_MIXED_FLAG gates the loom shuttle tension.'),
  sdoc('s04', 'proj-t', 'topicsd. FAKE_MIXED_FLAG gates the loom shuttle tension.'),
  sdoc('s05', 'proj-t', 'topicse. FAKE_OTHER_PROJ gates the loom shuttle tension.'),
  sdoc('s06', 'proj-s', 'topicsf. FAKE_SPLIT_FLAG_WIDE gates the loom shuttle tension.'),
  sdoc('s07', 'proj-s', 'topicsg. FAKE_SPLIT gates the loom shuttle tension.'),
  sdoc('s08', 'proj-s', 'topicsh. FAKE_ELIG_ONE gates the loom shuttle.'),
  sdoc('s09', 'proj-s', 'topicsi. FAKE_ELIG_TWO gates the loom.'),
  sdoc('s10', 'proj-s', 'topicsj. FAKE_ELIG_THREE gates.'),
  sdoc('s11', 'proj-s', 'topicsk. FAKE_ELIG_FOUR rests quietly here.'),
  sdoc('c01', 'desktop', 'topicca. FAKE_DESK_ROW gates the kiln.'),
  sdoc('c02', 'desktop', 'topiccb. FAKE_DESK_ROW gates the kiln again.'),
  sdoc('c03', 'desktop', 'topiccc. FAKE_DESK_DONOR gates the kiln.'),
  sdoc('c04', 'default', 'topiccd. FAKE_DEFAULT_ROW gates the kiln.'),
  sdoc('c05', 'default', 'topicce. FAKE_DEFAULT_ROW gates the kiln again.'),
  sdoc('c06', 'default', 'topiccf. FAKE_DEFAULT_DONOR gates the kiln.'),
  sdoc('c07', null, 'topiccg. FAKE_NONE_ROW gates the kiln.'),
  sdoc('c08', null, 'topicch. FAKE_NONE_ROW gates the kiln again.'),
  sdoc('c09', null, 'topicci. FAKE_NONE_DONOR gates the kiln.'),
  sdoc('u01', 'proj-u', 'topicua. FAKE_LONE_FLAG gates the press.'),
  sdoc('u02', 'proj-u', 'topicub. FAKE_LONE_FLAG gates the press again.'),
];

/**
 * H16's near-miss corpus. FAKE_NEAR_FLAG's window holds six file candidates,
 * nearest first; lib/fake-alpha.mjs and server/lib/fake-alpha.mjs are nested twins (no
 * donor). Each file also sits in a doc of its own so no group collapses with the
 * row. Four same-class rows elsewhere are its cross neighbours, in Jaccard order.
 */
const NEAR_POINTS = [
  sdoc('n01', 'proj-n', 'topicna. FAKE_NEAR_FLAG sits beside lib/fake-alpha.mjs, server/lib/fake-alpha.mjs, lib/fake-beta.mjs, lib/fake-gamma.mjs, lib/fake-delta.mjs and lib/fake-epsilon.mjs.'),
  sdoc('n02', 'proj-n', 'topicnb. server/lib/fake-alpha.mjs moved.'),
  sdoc('n03', 'proj-n', 'topicnc. lib/fake-beta.mjs moved.'),
  sdoc('n04', 'proj-n', 'topicnd. lib/fake-gamma.mjs moved.'),
  sdoc('n05', 'proj-n', 'topicne. lib/fake-delta.mjs moved.'),
  sdoc('n06', 'proj-n', 'topicnf. lib/fake-epsilon.mjs moved.'),
  sdoc('n07', 'proj-n', 'topicng. FAKE_CROSS_ONE sits beside lib/fake-beta.mjs.'),
  sdoc('n08', 'proj-n', 'topicnh. FAKE_CROSS_TWO sits beside.'),
  sdoc('n09', 'proj-n', 'topicni. FAKE_CROSS_THREE sits.'),
  sdoc('n10', 'proj-n', 'topicnj. FAKE_CROSS_FOUR rests.'),
];
const NEAR_GLOSSES = {
  FAKE_NEAR_FLAG: 'shuttle placement marker',
  'lib/fake-beta.mjs': 'beta loom source', 'lib/fake-gamma.mjs': 'gamma loom source', 'lib/fake-delta.mjs': 'delta loom source',
  'lib/fake-epsilon.mjs': 'epsilon loom source', 'server/lib/fake-alpha.mjs': 'alpha loom source',
  FAKE_CROSS_ONE: 'first cross marker', FAKE_CROSS_TWO: 'second cross marker',
  FAKE_CROSS_THREE: 'third cross marker', FAKE_CROSS_FOUR: 'fourth cross marker',
};
const NEAR = 'FAKE_NEAR_FLAG';
const nearRule = (type) => loaded(fixtureRule((x) => {
  x.gloss.cross_doc_neighbours = 4;
  x.salts.donor_type = saltFor(NEAR, type);
  return x;
}));

test('H15 only validator-confirmed attempts count toward accuracy and row floors; not-confirmed and OOV are counted apart; the 2×2 covers every judged attempt', () => {
  const r = loaded(fixtureRule((x) => { x.plants.min_rows = 2; return x; }));
  const ok = (o) => ({ status: 'ok', phrase: 'FAKE phrase', ...o });
  const none = (rank) => ({ rank, status: 'unknown', phrase: null, validator: null, confirmed: false, answer: null, correct: null });
  const nm = (type, attempts) => ({ assigned_type: type, donor_type: type, c: 3, chance: 0.2, attempts });
  const row = (plants, extra = {}) => ({
    role: 'primary', class: 'screaming-snake', df: 2, j3: 'SAME', split_eligibility: 'donor',
    plants: { leaky: null, near_miss: null, split: null, ...plants }, ...extra,
  });
  const rows = [
    row({
      leaky: { attempts: [ok({ rank: 1, validator: 'YES', confirmed: true, answer: 'NO', correct: true })] },
      near_miss: nm('cross', [
        ok({ rank: 1, donor: 'FAKE_D1', validator: 'TARGET', confirmed: false, answer: 'FAKE_D1', correct: true }),
        ok({ rank: 2, donor: 'FAKE_D2', validator: 'DONOR', confirmed: true, answer: 'FAKE_D2', correct: true }),
      ]),
      split: { attempts: [ok({ rank: 1, donor: 'FAKE_S1', validator: 'NO', confirmed: true, answer: 'DIFFERENT', correct: true })] },
    }),
    row({
      leaky: { attempts: [ok({ rank: 1, validator: 'NO', confirmed: false, answer: 'NO', correct: true })] },
      near_miss: nm('in-window', [
        ok({ rank: 1, donor: 'FAKE_D3', validator: 'OOV', confirmed: false, answer: 'SEVERAL', correct: false }),
        { ...none(2), donor: 'FAKE_D4' },
        ok({ rank: 3, donor: 'FAKE_D5', validator: 'DONOR', confirmed: true, answer: 'NONE', correct: false }),
      ]),
      split: { attempts: [
        ok({ rank: 1, donor: 'FAKE_S2', validator: 'YES', confirmed: false, answer: 'DIFFERENT', correct: true }),
        ok({ rank: 2, donor: 'FAKE_S3', validator: 'OOV', confirmed: false, answer: 'SAME', correct: false }),
      ] },
    }, { j3: 'DIFFERENT' }),
    row({ leaky: { attempts: [ok({ rank: 1, validator: 'OOV', confirmed: false, answer: 'YES', correct: false })] } }, { df: 1, j3: null, split_eligibility: null }),
    row({ leaky: { attempts: [none(1)] } }, { df: 1, j3: null, split_eligibility: null }),
    row({ leaky: { attempts: [ok({ rank: 1, validator: 'YES', confirmed: true, answer: 'YES', correct: false })] } }, { df: 1, j3: null, split_eligibility: null }),
  ];
  const ps = plantSummary(rows, { donor_structural: false, split_structural: false }, r);
  const counts = (s) => ({
    rows: s.rows, correct: s.correct, accuracy: s.accuracy, attempted: s.attempted, no_phrase: s.no_phrase,
    confirmed: s.confirmed, not_confirmed: s.not_confirmed, oov: s.oov, two_by_two: s.two_by_two,
  });
  assert.deepEqual(counts(ps.leaky), {
    rows: 2, correct: 1, accuracy: 0.5, attempted: 5, no_phrase: 1, confirmed: 2, not_confirmed: 2, oov: 1,
    two_by_two: { confirmed_correct: 1, confirmed_miss: 1, unconfirmed_correct: 1, unconfirmed_miss: 1 },
  });
  assert.deepEqual(ps.leaky.by_rank, { rank_1: { attempted: 5, judged: 4, confirmed: 2, correct: 1, accuracy: 0.5 } });
  assert.deepEqual(counts(ps.near_miss), {
    rows: 2, correct: 1, accuracy: 0.5, attempted: 5, no_phrase: 1, confirmed: 2, not_confirmed: 2, oov: 1,
    two_by_two: { confirmed_correct: 1, confirmed_miss: 1, unconfirmed_correct: 1, unconfirmed_miss: 1 },
  });
  assert.deepEqual(ps.near_miss.by_type, {
    'in-window': { rows: 1, correct: 0, accuracy: 0 }, cross: { rows: 1, correct: 1, accuracy: 1 },
  });
  assert.deepEqual(ps.near_miss.by_rank, {
    rank_1: { attempted: 2, judged: 2, confirmed: 0, correct: 0, accuracy: null },
    rank_2: { attempted: 2, judged: 1, confirmed: 1, correct: 1, accuracy: 1 },
    rank_3: { attempted: 1, judged: 1, confirmed: 1, correct: 0, accuracy: 0 },
  });
  assert.deepEqual(counts(ps.split), {
    rows: 1, correct: 1, accuracy: 1, attempted: 3, no_phrase: 0, confirmed: 1, not_confirmed: 2, oov: 1,
    two_by_two: { confirmed_correct: 1, confirmed_miss: 0, unconfirmed_correct: 1, unconfirmed_miss: 1 },
  });
  // Split accuracy stratified by the row's own real J3 outcome (descriptive).
  assert.deepEqual(ps.split.by_row_j3, {
    same: { rows: 1, correct: 1, accuracy: 1 }, not_same: { rows: 0, correct: 0, accuracy: null }, not_judged: { rows: 0, correct: 0, accuracy: null },
  });
  // Row floors read counted plants only: three split attempts, one counted → too few.
  assert.deepEqual([...ps.codes].sort(), ['plant-j1-accuracy', 'plant-j2-accuracy', 'plant-j2-donor-type-accuracy', 'plant-j3-too-few']);
});

test('H15 (end to end) a not-confirmed or out-of-vocabulary validator answer is recorded and kept out of the counted plants', async () => {
  const llm = makeStubLlm({
    validateOverride: ({ kind, meta }) => {
      if (kind === 'v1' && meta.identifier === 'FAKE_ALPHA_FLAG') return 'Probably yes'; // out of vocabulary
      if (kind === 'v1' && meta.identifier === 'lib/widget.mjs') return 'NO'; // in vocabulary, not confirming
      return undefined;
    },
  });
  const ctx = await e2e({ llm, anchor: false });
  const { rows } = readQuerySet(ctx.arc);
  const la = rows.find((x) => x.identifier === 'FAKE_ALPHA_FLAG').plants.leaky.attempts;
  assert.deepEqual([la.length, la[0].validator, la[0].confirmed, la[0].answer, la[0].correct], [1, 'OOV', false, 'NO', true], 'judged and recorded, not counted');
  const lw = rows.find((x) => x.identifier === 'lib/widget.mjs').plants.leaky.attempts[0];
  assert.deepEqual([lw.validator, lw.confirmed, lw.answer], ['NO', false, 'NO']);
  const s = JSON.parse(ctx.buildOut.at(-1)).plants.leaky;
  const judged = rows.flatMap((x) => x.plants?.leaky?.attempts ?? []).filter((a) => a.status === 'ok');
  assert.equal(s.oov, 1);
  assert.equal(s.not_confirmed, 2, 'the OOV answer sits in the not-confirmed row too');
  assert.equal(s.rows, judged.filter((a) => a.confirmed).length);
  assert.equal(s.rows, s.confirmed);
  assert.equal(s.two_by_two.unconfirmed_correct, 2);
  assert.equal(Object.values(s.two_by_two).reduce((a, b) => a + b, 0), judged.length, 'the 2×2 covers every judged attempt');
  assert.equal(s.attempted, rows.filter((x) => x.role === 'primary').length, 'one leaky attempt per primary row');
  assert.equal(s.no_phrase, 1, '#4101 is UNKNOWN: an attempt with no phrase');
});

test('H16 near-miss donors: within the assigned type, in its order, at most 3, no nested twin; the availability fallback is unchanged', async () => {
  const inR = nearRule('in-window');
  const w = buildPopulationRows(NEAR_POINTS, inR).rows.find((x) => x.identifier === NEAR);
  assert.deepEqual(w.in_window.map((c) => c.identifier),
    ['lib/fake-alpha.mjs', 'server/lib/fake-alpha.mjs', 'lib/fake-beta.mjs', 'lib/fake-gamma.mjs', 'lib/fake-delta.mjs', 'lib/fake-epsilon.mjs'], 'nearest first');
  assert.deepEqual([w.donor.assigned, w.donor.type], ['in-window', 'in-window']);
  assert.deepEqual(w.donor.candidates.map((c) => c.identifier), ['lib/fake-beta.mjs', 'lib/fake-gamma.mjs', 'lib/fake-delta.mjs'],
    'the nested twins are skipped; the fourth free candidate is never tried');
  // The validator confirms none: every attempt is made, ranks 1..3, all in-window, in order, each judged.
  const reject = makeStubLlm({ glosses: NEAR_GLOSSES, validateOverride: ({ kind, meta }) => (kind === 'v2' && meta.identifier === NEAR ? 'NEITHER' : undefined) });
  const nm = (await buildDirect(NEAR_POINTS, inR, reject)).rows.find((x) => x.identifier === NEAR).plants.near_miss;
  assert.deepEqual([nm.assigned_type, nm.donor_type], ['in-window', 'in-window']);
  assert.deepEqual(nm.attempts.map((a) => [a.rank, a.donor, a.status, a.validator, a.confirmed]),
    [[1, 'lib/fake-beta.mjs', 'ok', 'NEITHER', false], [2, 'lib/fake-gamma.mjs', 'ok', 'NEITHER', false], [3, 'lib/fake-delta.mjs', 'ok', 'NEITHER', false]]);
  assert.ok(nm.attempts.every((a) => a.answer === a.donor && a.correct === true), 'J2 judged every attempt');
  assert.ok(!reject.calls.some((c) => c.kind === 'v2' && c.meta.identifier === NEAR && c.meta.donor === 'lib/fake-epsilon.mjs'));
  // The cross type: J2's Jaccard order.
  const crossR = nearRule('cross');
  const wc = buildPopulationRows(NEAR_POINTS, crossR).rows.find((x) => x.identifier === NEAR);
  assert.deepEqual(wc.cross.map((c) => c.identifier), ['FAKE_CROSS_ONE', 'FAKE_CROSS_TWO', 'FAKE_CROSS_THREE', 'FAKE_CROSS_FOUR']);
  const nmc = (await buildDirect(NEAR_POINTS, crossR, reject)).rows.find((x) => x.identifier === NEAR).plants.near_miss;
  assert.equal(nmc.donor_type, 'cross');
  assert.deepEqual(nmc.attempts.map((a) => [a.rank, a.donor]), [[1, 'FAKE_CROSS_ONE'], [2, 'FAKE_CROSS_TWO'], [3, 'FAKE_CROSS_THREE']]);
  // Availability fallback (D3, unchanged): assigned a type with no donor, the row takes the other.
  const spinR = loaded(fixtureRule((x) => { x.salts.donor_type = saltFor('spin_up()', 'cross'); return x; }));
  const spin = buildPopulationRows(CORPUS_POINTS, spinR).rows.find((x) => x.identifier === 'spin_up()');
  assert.equal(spin.cross.length, 0);
  assert.deepEqual([spin.donor.assigned, spin.donor.type, spin.donor.candidates.map((c) => c.identifier)], ['cross', 'in-window', ['UM_COMMON_TAG']]);
  const twoR = loaded(fixtureRule((x) => { x.gloss.cross_doc_neighbours = 4; x.salts.donor_type = saltFor('FAKE_CROSS_TWO', 'in-window'); return x; }));
  const two = buildPopulationRows(NEAR_POINTS, twoR).rows.find((x) => x.identifier === 'FAKE_CROSS_TWO');
  assert.equal(two.in_window.length, 0);
  assert.deepEqual([two.donor.assigned, two.donor.type], ['in-window', 'cross']);
});

test('H16 near-miss attempts: an UNKNOWN or G-shape-failed donor gloss uses up an attempt; a confirmed judge miss ends the plant', async () => {
  const inR = nearRule('in-window');
  const donorReply = (reply) => ({ kind, meta }) => (kind === 'gloss' && meta.plant === 'near-miss' && meta.identifier === 'lib/fake-beta.mjs' ? reply : undefined);
  const plantCalls = (llm, kind) => llm.calls.filter((c) => c.kind === kind && c.meta.identifier === NEAR && (kind !== 'j2' || c.meta.plant === 'near-miss'));
  for (const [reply, status] of [['UNKNOWN', 'unknown'], ['beta loom source 2', 'g-shape']]) {
    const llm = makeStubLlm({ glosses: NEAR_GLOSSES, generateOverride: donorReply(reply) });
    const nm = (await buildDirect(NEAR_POINTS, inR, llm)).rows.find((x) => x.identifier === NEAR).plants.near_miss;
    assert.deepEqual(nm.attempts.map((a) => [a.rank, a.donor, a.status, a.confirmed]),
      [[1, 'lib/fake-beta.mjs', status, false], [2, 'lib/fake-gamma.mjs', 'ok', true]], status);
    assert.deepEqual([nm.attempts[0].validator, nm.attempts[0].answer, nm.attempts[0].correct], [null, null, null], 'no phrase: neither validated nor judged');
    assert.deepEqual(plantCalls(llm, 'v2').map((c) => c.meta.donor), ['lib/fake-gamma.mjs'], status);
    assert.equal(plantCalls(llm, 'j2').length, 1, status);
  }
  // The first attempt is confirmed and J2 misses it: the plant ends there, counted as a miss.
  const miss = makeStubLlm({ glosses: NEAR_GLOSSES, judgeOverride: ({ kind, meta }) => (kind === 'j2' && meta.plant === 'near-miss' && meta.identifier === NEAR ? 'NONE' : undefined) });
  const { header, rows } = await buildDirect(NEAR_POINTS, inR, miss);
  const nm = rows.find((x) => x.identifier === NEAR).plants.near_miss;
  assert.deepEqual(nm.attempts.map((a) => [a.rank, a.donor, a.validator, a.confirmed, a.answer, a.correct]),
    [[1, 'lib/fake-beta.mjs', 'DONOR', true, 'NONE', false]]);
  assert.equal(plantCalls(miss, 'v2').length, 1, 'no further attempt after the first confirmed one');
  const ps = plantSummary(rows.filter((x) => x.identifier === NEAR), header, inR);
  assert.deepEqual([ps.near_miss.rows, ps.near_miss.correct], [1, 0]);
});

test('H16 split donors: same project only, no identifier from the row\'s docs (X ⊃ Y and X ⊂ Y), Jaccard order; catch-all rows get none', () => {
  const r = loaded(fixtureRule());
  const { rows } = buildPopulationRows(SPLIT_POINTS, r);
  const y = rows.find((x) => x.identifier === 'FAKE_SPLIT_FLAG');
  assert.equal(y.role, 'primary');
  assert.deepEqual(y.relevant, ['s01', 's02', 's06'], 'X ⊃ Y puts X\'s doc among Y\'s');
  assert.equal(rows.find((x) => x.identifier === 'FAKE_SPLIT').df, 4, 'X ⊂ Y occurs in every doc of Y');
  assert.equal(y.split_eligibility, 'donor');
  assert.deepEqual(y.split_donors.map((d) => d.identifier), ['FAKE_ELIG_ONE', 'FAKE_ELIG_TWO', 'FAKE_ELIG_THREE', 'FAKE_ELIG_FOUR'],
    'refused: FAKE_MIXED_FLAG (one doc in proj-t), FAKE_OTHER_PROJ (proj-t), FAKE_SPLIT_FLAG_WIDE (X ⊃ Y), FAKE_SPLIT (X ⊂ Y)');
  const jac = (ident) => jaccard(y.tokens, rows.find((x) => x.identifier === ident).tokens);
  for (const refused of ['FAKE_MIXED_FLAG', 'FAKE_OTHER_PROJ', 'FAKE_SPLIT_FLAG_WIDE', 'FAKE_SPLIT']) {
    assert.ok(jac(refused) > jac('FAKE_ELIG_ONE'), `${refused} would rank first by overlap (else the case is vacuous)`);
  }
  for (let i = 1; i < y.split_donors.length; i++) assert.ok(jac(y.split_donors[i - 1].identifier) > jac(y.split_donors[i].identifier));
  for (const [ident, bucket] of [['FAKE_DESK_ROW', 'desktop'], ['FAKE_DEFAULT_ROW', 'default'], ['FAKE_NONE_ROW', '(none)']]) {
    const row = rows.find((x) => x.identifier === ident);
    assert.deepEqual([row.role, row.df, row.split_eligibility, row.split_donors], ['primary', 2, 'catch-all', []], bucket);
  }
  assert.equal(rows.find((x) => x.identifier === 'FAKE_LONE_FLAG').split_eligibility, 'no-donor');
  assert.equal(rows.find((x) => x.identifier === 'FAKE_ELIG_ONE').split_eligibility, null, 'df 1: no split plant at all');
});

test('H16 split attempts: Jaccard order, at most split_donor_attempts, stopping at the first confirmed; J3 judges every attempt', async () => {
  const r = loaded(fixtureRule());
  const confirmOnly = (donor) => makeStubLlm({
    validateOverride: ({ kind, meta }) => (kind === 'v3' && meta.identifier === 'FAKE_SPLIT_FLAG' ? (meta.donor === donor ? 'NO' : 'YES') : undefined),
  });
  const llm2 = confirmOnly('FAKE_ELIG_TWO');
  const { rows } = await buildDirect(SPLIT_POINTS, r, llm2);
  const y = rows.find((x) => x.identifier === 'FAKE_SPLIT_FLAG');
  assert.deepEqual(y.plants.split.attempts.map((a) => [a.rank, a.donor, a.validator, a.confirmed]),
    [[1, 'FAKE_ELIG_ONE', 'YES', false], [2, 'FAKE_ELIG_TWO', 'NO', true]]);
  assert.ok(y.plants.split.attempts.every((a) => a.answer === 'DIFFERENT' && a.correct === true), 'J3 judged every attempt');
  assert.equal(llm2.calls.filter((c) => c.kind === 'j3' && c.meta.split && c.meta.identifier === 'FAKE_SPLIT_FLAG').length, 2);
  // None confirmed: exactly split_donor_attempts attempts; the fourth donor is never tried.
  const llm0 = confirmOnly('FAKE_NOBODY');
  const y0 = (await buildDirect(SPLIT_POINTS, r, llm0)).rows.find((x) => x.identifier === 'FAKE_SPLIT_FLAG');
  assert.deepEqual(y0.plants.split.attempts.map((a) => [a.rank, a.donor, a.confirmed]),
    [[1, 'FAKE_ELIG_ONE', false], [2, 'FAKE_ELIG_TWO', false], [3, 'FAKE_ELIG_THREE', false]]);
  assert.ok(!llm0.calls.some((c) => c.kind === 'v3' && c.meta.donor === 'FAKE_ELIG_FOUR'));
  // Catch-all and donor-less rows: no split plant, no V3 call.
  for (const ident of ['FAKE_DESK_ROW', 'FAKE_DEFAULT_ROW', 'FAKE_NONE_ROW', 'FAKE_LONE_FLAG']) {
    assert.equal(rows.find((x) => x.identifier === ident).plants.split, null, ident);
    assert.ok(!llm2.calls.some((c) => c.kind === 'v3' && c.meta.identifier === ident), ident);
  }
});

test('H17 structural shortfalls are decided on availability before generation; a validation shortfall is never structural; plant-j3-too-few is non-rebuildable', async () => {
  const r = loaded(fixtureRule());
  // Pure, no LLM anywhere: both structural flags come from availability.
  const pure = buildPopulationRows(CORPUS_POINTS, r);
  assert.deepEqual([pure.donorStructural, pure.splitStructural], [false, false]);
  assert.equal(buildPopulationRows(CORPUS_POINTS, loaded(fixtureRule((x) => { x.plants.min_rows_per_donor_type = 50; return x; }))).donorStructural, true);
  assert.equal(buildPopulationRows(CORPUS_POINTS, loaded(fixtureRule((x) => { x.plants.min_rows = 2; return x; }))).splitStructural, true,
    'one row has a same-project donor (FAKE_ALPHA_FLAG); FAKE_DESK_FLAG is catch-all');
  // Near-miss: a validator that confirms no in-window donor leaves the type non-structural → too few.
  const noIn = makeStubLlm({ validateOverride: ({ kind, meta }) => (kind === 'v2' && meta.donor_type === 'in-window' ? 'NEITHER' : undefined) });
  const ctx = await e2e({ llm: noIn, anchor: false });
  const { header, rows } = readQuerySet(ctx.arc);
  assert.equal(header.donor_structural, false);
  assert.ok(rows.some((x) => x.plants?.near_miss?.donor_type === 'in-window' && x.plants.near_miss.attempts.length > 0), 'in-window attempts were made');
  const ps = plantSummary(rows, header, r);
  assert.equal(ps.near_miss.by_type['in-window'].rows, 0);
  assert.ok(ps.codes.includes('plant-j2-donor-type-too-few'));
  assert.ok(!ps.non_rebuildable_codes.includes('plant-j2-donor-type-too-few'), 'a near-miss validation shortfall stays a rebuild trigger');
  // Split, validation cause: V3 confirms nothing; split stays non-structural.
  const noV3 = makeStubLlm({ validateOverride: ({ kind }) => (kind === 'v3' ? 'YES' : undefined) });
  const ctxV = await e2e({ llm: noV3, anchor: false });
  const sv = JSON.parse(ctxV.buildOut.at(-1));
  assert.equal(readQuerySet(ctxV.arc).header.split_structural, false);
  assert.deepEqual([sv.plants.split.structural, sv.plants.split.rows, sv.plants.split.attempted], [false, 0, 2]);
  assert.ok(sv.void_codes.includes('plant-j3-too-few'));
  assert.deepEqual(sv.non_rebuildable_codes, ['plant-j3-too-few']);
  // Split, availability cause: min_rows above the rows with a donor → structural in the header and the summary.
  const ctxA = await e2e({ anchor: false, ruleMut: (x) => { x.plants.min_rows = 2; return x; } });
  const sa = JSON.parse(ctxA.buildOut.at(-1));
  assert.equal(readQuerySet(ctxA.arc).header.split_structural, true);
  assert.deepEqual([sa.plants.split.structural, sa.plants.split.rows_with_donor, sa.plants.split.catch_all_excluded, sa.plants.split.no_donor], [true, 1, 1, 0]);
  assert.ok(sa.void_codes.includes('plant-j3-too-few'));
  assert.deepEqual(sa.non_rebuildable_codes, ['plant-j3-too-few']);
});

test('H18 V2\'s A/B order: salted over row, donor and rank; independent of the donor-type parity; an A/B swap maps back', async () => {
  const r = loaded(fixtureRule());
  for (const [row, donor, rank] of [['FAKE_X', 'FAKE_Y', 1], ['FAKE_X', 'FAKE_Y', 2], ['#4101', 'lib/widget.mjs', 3]]) {
    const h = sha(`${r.salts.validator_order}\0${row}\0${donor}\0${rank}`);
    assert.equal(validatorOrder(r, row, donor, rank), parseInt(h.slice(0, 8), 16) % 2 === 0 ? 'donor-a' : 'donor-b');
  }
  const ctx = await e2e({ anchor: false });
  const v2 = ctx.llm.calls.filter((c) => c.kind === 'v2');
  assert.ok(v2.length >= 4, 'enough V2 calls on the fixture');
  let agree = 0;
  let disagree = 0;
  for (const c of v2) {
    const order = validatorOrder(r, c.meta.identifier, c.meta.donor, c.meta.rank);
    const [a, b] = order === 'donor-a' ? [c.meta.donor, c.meta.identifier] : [c.meta.identifier, c.meta.donor];
    assert.deepEqual([c.meta.a, c.meta.b], [a, b]);
    assert.ok(c.prompt.indexOf(`A: ${a}\n`) >= 0 && c.prompt.indexOf(`A: ${a}\n`) < c.prompt.indexOf(`B: ${b}\n`), 'the prompt shows A then B');
    const parityCross = parseInt(saltedHash(r.salts.donor_type, c.meta.identifier).slice(0, 8), 16) % 2 === 0;
    if ((order === 'donor-a') === parityCross) agree++; else disagree++;
  }
  assert.ok(agree > 0 && disagree > 0, `the order is not a function of the donor-type parity (agree ${agree}, disagree ${disagree})`);
  // The default stub names the donor's side: every judged attempt maps back to DONOR, in both orders.
  const judged = (arc) => readQuerySet(arc).rows.flatMap((x) => x.plants?.near_miss?.attempts ?? []).filter((x) => x.status === 'ok');
  const att = judged(ctx.arc);
  assert.ok(att.some((x) => x.order === 'donor-a') && att.some((x) => x.order === 'donor-b'), 'both orders occur (else the case is vacuous)');
  for (const x of att) assert.deepEqual([x.validator, x.confirmed], ['DONOR', true]);
  // A validator that always answers A: confirmed exactly when the donor is A; a B donor maps to TARGET.
  const alwaysA = makeStubLlm({ validateOverride: ({ kind }) => (kind === 'v2' ? 'A' : undefined) });
  const ctxA = await e2e({ anchor: false, llm: alwaysA });
  const attA = judged(ctxA.arc);
  assert.ok(attA.some((x) => x.order === 'donor-b'));
  for (const x of attA) assert.deepEqual([x.validator, x.confirmed], x.order === 'donor-a' ? ['DONOR', true] : ['TARGET', false]);
});

test('H19 score refuses BEFORE the verdict function when a pre-verdict aggregate fails the allowlist; guards.plants is the build summary\'s projection', async () => {
  const rewriteRows = (arc, edit) => {
    const p = join(arc, 'query-set.jsonl');
    const [head, ...rest] = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    writeFileSync(p, [head, ...rest.map((x) => edit(x) ?? x)].map((x) => JSON.stringify(x)).join('\n') + '\n');
  };
  const cases = [
    // A shape defect in a revision-1 field: an attempt rank outside the rule's cap.
    ['attempt rank', (x) => { if (x.identifier === 'FAKE_ALPHA_FLAG') x.plants.leaky.attempts[0].rank = 9; return x; }],
    // A defect in the build-summary-derived class table, on an excluded row (so only exclusions_by_class carries it).
    ['class table', (x) => { if (x.identifier === '#4101') x.class = 'not-a-class'; return x; }],
  ];
  for (const [label, edit] of cases) {
    const ctx = await e2e({ tamper: (arc) => rewriteRows(arc, edit) });
    let called = 0;
    const s = await score(ctx, { faults: { decideVerdict: (...a) => { called++; return decideVerdict(...a); } } });
    assert.equal(s.code, 1, `${label}: ${s.outLines.join('\n')}`);
    assert.match(s.outLines.join('\n'), /"status":"refused","code":"internal-error"/, label);
    assert.equal(called, 0, `${label}: the verdict function never ran`);
    assert.deepEqual(s.files, [], `${label}: nothing written`);
    assert.ok(!existsSync(join(ctx.arc, 'score-rows.jsonl')), label);
  }
  // On an untampered build, guards.plants is exactly the build summary's plants (one projection).
  const ok = await e2e();
  const s = await score(ok);
  assert.equal(s.code, 0, s.outLines.join('\n'));
  const result = JSON.parse(readFileSync(join(s.resultsDir, s.files[0]), 'utf8'));
  assert.deepEqual(result.guards.plants, JSON.parse(ok.buildOut.at(-1)).plants);
});
