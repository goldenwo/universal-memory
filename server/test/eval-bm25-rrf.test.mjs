// server/test/eval-bm25-rrf.test.mjs — pure-lib tests for the #188 exact-token eval
// (server/eval/lib/bm25.mjs + rrf.mjs).
//
// Under the eval-code carve-out the keyed run is the decisive reviewer for the HARNESS,
// but these two modules are pure and load-bearing — a bug in either moves BOTH fusion arms
// the same direction and would satisfy G2's retention relation while measuring nothing
// (spec §5.3 negative controls). So they get real TDD.
//
// Frozen-parameter coverage (spec §5.5): k1/b, Lucene-smoothed IDF, per-arm tokenizers,
// RRF k=60 with 1-based ranks, and the §7.3 rule that df/avgdl are COLLECTION-level and
// never recomputed over a narrowed candidate set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeIdealized, tokenizeDeployable, buildIndex, idf, score, matchTextCandidates, K1, B,
} from '../eval/lib/bm25.mjs';
import { fuse, RRF_K } from '../eval/lib/rrf.mjs';

// ── Frozen parameters (spec §5.5) ────────────────────────────────────────────
test('frozen BM25 + RRF parameters match the pre-registered values', () => {
  assert.equal(K1, 1.2);
  assert.equal(B, 0.75);
  assert.equal(RRF_K, 60);
});

// ── Tokenizers: the divergence G2's retention relation exists to measure ─────
test('idealized tokenizer preserves identifier shapes atomically', () => {
  assert.deepEqual(tokenizeIdealized('UM_LANE_CLASSIFIER_ENABLED'), ['um_lane_classifier_enabled']);
  assert.deepEqual(tokenizeIdealized('1.12.0'), ['1.12.0']);
  assert.deepEqual(tokenizeIdealized('~/.claude-mem/settings.json'), ['~/.claude-mem/settings.json']);
  assert.deepEqual(tokenizeIdealized('find_orphans()'), ['find_orphans']);
  assert.deepEqual(tokenizeIdealized('#161'), ['#161']);
});

test('deployable tokenizer reproduces qdrant 1.7.3 word semantics', () => {
  assert.deepEqual(tokenizeDeployable('UM_LANE_CLASSIFIER_ENABLED'), ['um', 'lane', 'classifier', 'enabled']);
  // BOTH `1` and `0` are dropped by min_token_len: 2 — a semver survives as the single
  // token `12`, which is exactly the shredding that makes the two arms disagree.
  assert.deepEqual(tokenizeDeployable('1.12.0'), ['12']);
  assert.deepEqual(tokenizeDeployable('~/.claude-mem/settings.json'), ['claude', 'mem', 'settings', 'json']);
  assert.deepEqual(tokenizeDeployable('find_orphans()'), ['find', 'orphans']);
  assert.deepEqual(tokenizeDeployable('#161'), ['161']);
});

test('idealized tokenizer strips edge punctuation without splitting the token', () => {
  assert.deepEqual(tokenizeIdealized('use "um-api.sh", ok?'), ['use', 'um-api.sh', 'ok']);
});

// ── IDF ──────────────────────────────────────────────────────────────────────
const corpus = [
  { id: 'a', text: 'the rare_token appears here' },
  { id: 'b', text: 'common word only' },
  { id: 'c', text: 'common word again' },
  { id: 'd', text: 'common word thrice' },
];

test('Lucene-smoothed IDF is never negative, even for a term in every doc', () => {
  const idx = buildIndex(corpus.concat({ id: 'e', text: 'common' }), tokenizeIdealized);
  assert.ok(idf(idx, 'common') >= 0, 'df≈N must not produce negative IDF');
  // The unsmoothed variant ln((N-df+0.5)/(df+0.5)) would go negative here; smoothed must not.
});

test('rarer terms score higher IDF than common ones', () => {
  const idx = buildIndex(corpus, tokenizeIdealized);
  assert.ok(idf(idx, 'rare_token') > idf(idx, 'common'));
});

test('IDF of an absent term is the maximum (df=0), not NaN', () => {
  const idx = buildIndex(corpus, tokenizeIdealized);
  const v = idf(idx, 'nowhere');
  assert.ok(Number.isFinite(v) && v > 0);
});

// ── §7.3: df/avgdl stay COLLECTION-level under narrowing ─────────────────────
test('§7.3 — narrowing candidates does NOT recompute df/avgdl', () => {
  const idx = buildIndex(corpus, tokenizeIdealized);
  const globalIdf = idf(idx, 'common');
  // Narrow to only docs containing `common` — the MatchText regime where a naive
  // implementation would recompute df=N and collapse IDF toward zero.
  const narrowed = ['b', 'c', 'd'];
  const ranked = score(idx, 'common word', { candidateIds: narrowed });
  assert.equal(ranked.length, 3);
  // IDF is unchanged after scoring a narrowed set — the stats are not derived from it.
  assert.equal(idf(idx, 'common'), globalIdf);
  assert.ok(ranked.every((r) => r.score > 0), 'collapsed IDF would zero these scores');
});

test('scoring a narrowed set gives the same relative order as scoring the full set', () => {
  const idx = buildIndex(corpus, tokenizeIdealized);
  const full = score(idx, 'common word').filter((r) => r.id !== 'a').map((r) => r.id);
  const narrowed = score(idx, 'common word', { candidateIds: ['b', 'c', 'd'] }).map((r) => r.id);
  assert.deepEqual(narrowed, full);
});

// ── Scoring behaviour ────────────────────────────────────────────────────────
test('a df=1 identifier ranks its containing doc first', () => {
  const idx = buildIndex(corpus, tokenizeIdealized);
  assert.equal(score(idx, 'rare_token')[0].id, 'a');
});

test('length normalization: shorter doc outranks longer one at equal tf', () => {
  const idx = buildIndex([
    { id: 'short', text: 'target' },
    { id: 'long', text: `target ${'filler '.repeat(50)}` },
  ], tokenizeIdealized);
  assert.equal(score(idx, 'target')[0].id, 'short');
});

test('score is deterministic and breaks ties by id', () => {
  const idx = buildIndex([
    { id: 'zeta', text: 'same text' },
    { id: 'alpha', text: 'same text' },
  ], tokenizeIdealized);
  assert.deepEqual(score(idx, 'same text').map((r) => r.id), ['alpha', 'zeta']);
});

test('a query with no matching terms returns empty, not everything', () => {
  const idx = buildIndex(corpus, tokenizeIdealized);
  assert.deepEqual(score(idx, 'zzz_absent'), []);
});

// ── MatchText AND-over-tokens ────────────────────────────────────────────────
test('matchTextCandidates requires ALL query tokens (AND semantics)', () => {
  const idx = buildIndex([
    { id: 'both', text: 'alpha beta' },
    { id: 'one', text: 'alpha only' },
  ], tokenizeIdealized);
  assert.deepEqual(matchTextCandidates(idx, 'alpha beta'), ['both']);
});

test('matchTextCandidates returns empty when any token is absent — arm contributes nothing', () => {
  const idx = buildIndex(corpus, tokenizeIdealized);
  assert.deepEqual(matchTextCandidates(idx, 'common absent_token'), []);
});

// ── RRF ──────────────────────────────────────────────────────────────────────
test('RRF uses 1-based ranks: top doc scores weight/(k+1)', () => {
  const [top] = fuse([{ ranking: ['x'], weight: 1 }]);
  assert.equal(top.score, 1 / (RRF_K + 1));
});

test('a doc ranked by both arms outranks one ranked by a single arm', () => {
  const out = fuse([
    { ranking: ['both', 'onlyA'], weight: 1 },
    { ranking: ['both', 'onlyB'], weight: 1 },
  ]);
  assert.equal(out[0].id, 'both');
});

test('missing from one arm contributes nothing from that arm (no 1/(k+0) reward)', () => {
  const out = fuse([{ ranking: ['a'], weight: 1 }, { ranking: [], weight: 1 }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 1 / (RRF_K + 1));
});

test('NEGATIVE CONTROL — lexical weight 0 reproduces the vector ranking exactly', () => {
  const vector = ['v1', 'v2', 'v3'];
  const out = fuse([
    { ranking: vector, weight: 1 },
    { ranking: ['L1', 'L2', 'L3'], weight: 0 },
  ]);
  assert.deepEqual(out.map((r) => r.id), vector,
    'spec §5.3 control 1: weight-0 fusion must equal the vector arm row-for-row');
});

test('weighting shifts the winner toward the heavier arm', () => {
  const arms = (wv, wl) => fuse([
    { ranking: ['V'], weight: wv },
    { ranking: ['L'], weight: wl },
  ])[0].id;
  assert.equal(arms(2, 1), 'V');
  assert.equal(arms(1, 2), 'L');
});

test('fuse is deterministic and breaks ties by id', () => {
  const out = fuse([{ ranking: ['zeta'], weight: 1 }, { ranking: ['alpha'], weight: 1 }]);
  assert.deepEqual(out.map((r) => r.id), ['alpha', 'zeta']);
});

test('limit truncates after fusion, not before', () => {
  const out = fuse([
    { ranking: ['a', 'b', 'c'], weight: 1 },
    { ranking: ['c', 'b', 'a'], weight: 1 },
  ], { limit: 2 });
  assert.equal(out.length, 2);
});
