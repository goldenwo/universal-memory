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
import { ANCHOR_CODES, ANCHOR_REL_PATH, RULE_REL_PATH, computeAnchorLines, formatAnchor } from '../eval/lib/accept-rule.mjs';
import { loadRule } from '../eval/lib/exact-token-203-rule.mjs';
import {
  IDENTIFIER_CLASSES, buildPopulationRows, chooseRepresentative, chooseSeedDoc, classOf,
  gShape, indexCorpus, plantSummary, saltedHash,
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

/** A merged sandbox repo + arc dir holding a real `build` output and its anchor. */
async function e2e({ ruleMut, llm, points = CORPUS_POINTS, anchor = true } = {}) {
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

async function score(ctx, { index, faults, env } = {}) {
  const outLines = [];
  const idx = index ?? makeStubIndex(CORPUS_POINTS);
  let opened = 0;
  const code = await run(['score', '--arc-dir', ctx.arc], {
    repoDir: ctx.sb.repo, env: env ?? ctx.env, now: NOW, faults,
    out: (l) => outLines.push(String(l)),
    openIndex: async () => { opened++; return idx; },
  });
  const resultsDir = join(ctx.sb.repo, 'server', 'eval', 'results');
  return { code, outLines, idx, opened, resultsDir, files: listAll(resultsDir) };
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

test('K1 the tracked rule carries the spec\'s pre-registered values', () => {
  assert.equal(RULE.verdict.margin, 0.1);
  assert.equal(RULE.verdict.ci_level, 0.95);
  assert.equal(RULE.verdict.bootstrap_resamples, 10000);
  assert.equal(RULE.verdict.exclusion_cap, 0.4);
  assert.equal(RULE.verdict.pass_disagreement_cap, 0.02);
  assert.deepEqual({ ...RULE.verdict.class_thinning }, { min_class_rows: 20, min_kept_fraction: 0.5 });
  assert.equal(RULE.verdict.discrimination_floor, 0.2);
  assert.deepEqual({ ...RULE.plants }, { accuracy_floor: 0.9, min_rows: 60, min_rows_per_donor_type: 30, retries: 1 });
  assert.equal(RULE.calibration.determinism_floor, 0.98);
  assert.deepEqual({ ...RULE.c3 }, { min_eligible_rows: 30, one_sided_level: 0.95 });
  assert.equal(RULE.population.max_df, 5);
  assert.equal(RULE.population.corpus_cutoff, '2026-10-09T00:00:00Z');
  assert.equal(RULE.gloss.window_chars, 600);
  assert.equal(RULE.gloss.min_words, 2);
  assert.equal(RULE.gloss.max_words, 6);
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
  assert.deepEqual(alpha.cross.map((c) => c.identifier).sort(), ['FAKE_BETA_FLAG', 'FAKE_DELTA_FLAG', 'FAKE_GAMMA_FLAG'],
    'UM_COMMON_TAG occurs in a relevant doc and is excluded');
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
  // Both FAKE_ALPHA_FLAG and UM_COMMON_TAG are in its window; the nearer one is the donor.
  const near = w.in_window.slice().sort((x, y) => Math.abs(x.pos - w.window.pos) - Math.abs(y.pos - w.window.pos))[0];
  if (w.donor?.type === 'in-window') assert.equal(w.donor.identifier, near.identifier);
  const beta = rows.find((x) => x.identifier === 'FAKE_BETA_FLAG');
  assert.equal(beta.single_project, false);
  assert.notEqual(beta.role, 'primary');
  assert.equal(rows.filter((x) => x.role === 'primary').length, 9);
  assert.equal(rows.find((x) => x.identifier === 'UM_COMMON_TAG').role, 'nonprimary', 'df 6 > 5');
  assert.equal(rows.find((x) => x.identifier === 'FAKE_GAMMA_FLAG').role, 'fact-control');
  // Donor types follow the seeded hash, falling back when a type is unavailable.
  for (const x of rows.filter((y) => y.role === 'primary' && y.donor)) {
    const assigned = parseInt(saltedHash(r.salts.donor_type, x.identifier).slice(0, 8), 16) % 2 === 0 ? 'cross' : 'in-window';
    assert.equal(x.donor.assigned, assigned, x.identifier);
    if (assigned === 'cross' && x.cross.length) assert.equal(x.donor.type, 'cross');
    if (assigned === 'in-window' && x.in_window.length) assert.equal(x.donor.type, 'in-window');
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

test('H14 J3: df ≥ 2 rows get one window per relevant doc; non-SAME excludes; the split plant swaps one window', async () => {
  const ctx = await e2e({ anchor: false });
  const j3 = ctx.llm.calls.filter((c) => c.kind === 'j3');
  const alphaCalls = j3.filter((c) => c.meta.identifier === 'FAKE_ALPHA_FLAG');
  assert.equal(alphaCalls.length, 2, 'one real check and one split-referent plant');
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
  assert.equal(alpha.plants.split.correct, true);
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
  assert.equal(header.E, 9);
  assert.equal(header.build_number, 1);
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
