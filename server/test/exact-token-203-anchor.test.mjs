/**
 * exact-token-203-anchor.test.mjs — #203 PR 2 (spec D7, §4.2.4, §4.2.8; plan T4,
 * T7): the mechanical pre-registration check, on REAL git repositories built in
 * a temp dir with an isolated git config (helpers/git-sandbox.mjs) — never this
 * checkout.
 *
 * Registered cases (the spec lists A1–A8 in prose; numbering follows its order,
 * with A6 = the `score` case the plan assigns to T7 and A8 = the LF/CRLF case
 * the plan assigns to T4):
 *   A1  a matching anchor → ok (with merge provenance)
 *   A2  a one-byte edit to the rule, the query set, the corpus dump, or a
 *       committed server/ file → refused
 *   A3  an uncommitted edit to a tracked server/ file → refused (clean check)
 *   A4  a missing anchor → refused
 *   A5  a one-byte edit to a snapshot transcript or to the counters export →
 *       refused
 *   A6  `score` with a mismatched anchor exits non-zero and writes nothing
 *       (driven through run(argv, deps) with injected paths)
 *   A7  a query set whose embedded rule or corpus hash differs from the `rule`
 *       or `corpus` line → refused
 *   A8  one commit checked out with LF and with CRLF working trees (the latter
 *       via core.autocrlf=true) gives one server-tree
 *   A9  a commit not reachable from origin/main → `score` refuses, while
 *       `freeze-check` (contents only) passes
 *   A11 an untracked anchor at a merged commit whose tree holds none → refused;
 *       a modified tracked anchor → refused (clean check); neither can make a
 *       run pass that the committed anchor would refuse
 * Plus: the transcripts manifest serialization (spec D7, the one T0b used) and
 * the corpus manifest's order independence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/tmpdir.mjs';
import { makeGitSandbox, runGit } from './helpers/git-sandbox.mjs';
import { materializeCensusFixture } from './fixtures/exact-token-203-census.fixture.mjs';
import {
  ANCHOR_LABELS, ANCHOR_REL_PATH, RULE_REL_PATH,
  computeAnchorLines, corpusManifestHash, fileSha256, formatAnchor, parseAnchor,
  serverTreeHash, transcriptsManifestHash, verifyAnchor,
} from '../eval/lib/accept-rule.mjs';
import { run } from '../eval/exact-token-203.mjs';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED_RULE_BYTES = readFileSync(join(SERVER_DIR, 'eval', 'exact-token-203-accept-rule.json'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

const POINTS = [
  { id: 'aaaa-1', vector: [0.125, -0.5, 0.25], payload: { id: 'doc-one', data: 'synthetic note one', userId: 'golden', project: 'p' } },
  { id: 'aaaa-2', vector: [0.5, 0.5, -0.125], payload: { data: 'synthetic fact two', userId: 'golden', project: 'p' } },
  { id: 'aaaa-3', vector: [1, 0, 0], payload: { id: '_um_embedding_stamp', data: 'stamp', userId: '_um_system' } },
];

/** A merged repo with a committed anchor over a synthetic arc dir. */
async function anchoredRepo({ header = {}, skipAnchor = false } = {}) {
  const sb = makeGitSandbox();
  sb.write(RULE_REL_PATH, TRACKED_RULE_BYTES);
  sb.write('server/lib/sample.mjs', 'export const a = 1;\nexport const b = 2;\n');
  sb.write('server/eval/results/old-result.json', '{"n":1}\n');
  sb.write('README.md', 'sandbox\n');
  sb.commitAll('base');

  const arc = join(sb.root, 'arc');
  mkdirSync(arc);
  writeFileSync(join(arc, 'corpus.json'), JSON.stringify(POINTS));
  const head = {
    kind: 'header', schema: 'exact-token-203-query-set/1',
    rule_sha256: sha(TRACKED_RULE_BYTES), corpus_manifest_sha256: corpusManifestHash(POINTS), ...header,
  };
  writeFileSync(join(arc, 'query-set.jsonl'), `${JSON.stringify(head)}\n${JSON.stringify({ kind: 'row', identifier: 'FAKE_ROW_X' })}\n`);
  await materializeCensusFixture(arc);
  const entries = {
    rule: join(sb.repo, ...RULE_REL_PATH.split('/')),
    'query-set': join(arc, 'query-set.jsonl'),
    corpus: join(arc, 'corpus.json'),
    transcripts: join(arc, 'transcripts'),
    counters: join(arc, 'counters-export.json'),
  };
  const lines = await computeAnchorLines(entries, { repoDir: sb.repo, env: sb.env });
  if (!skipAnchor) {
    sb.write(ANCHOR_REL_PATH, formatAnchor(lines));
    sb.commitAll('freeze');
  }
  sb.push();
  return { sb, arc, entries, lines };
}

const verify = (ctx, provenance = true) => verifyAnchor(ctx.entries, { repoDir: ctx.sb.repo, env: ctx.sb.env, provenance });

function flipOneByte(path) {
  const b = readFileSync(path);
  // Change one letter well inside the file, keeping the format parseable.
  for (let i = Math.floor(b.length / 2); i < b.length; i++) {
    if (b[i] >= 0x61 && b[i] <= 0x79) { b[i] += 1; writeFileSync(path, b); return; }
  }
  throw new Error('no letter to flip');
}

function listAll(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listAll(p));
    else out.push(`${relative(dir, p)}:${statSync(p).size}`);
  }
  return out.sort();
}

function harnessDeps(ctx, extra = {}) {
  const outLines = [];
  const resultsDir = join(ctx.sb.root, 'results-out');
  mkdirSync(resultsDir, { recursive: true });
  return {
    outLines, resultsDir,
    deps: {
      repoDir: ctx.sb.repo, env: ctx.sb.env, resultsDir,
      out: (l) => outLines.push(String(l)),
      openIndex: async () => { throw new Error('the index must not be opened'); },
      llm: { generate: async () => { throw new Error('no LLM'); }, judge: async () => { throw new Error('no LLM'); } },
      ...extra,
    },
  };
}

// ── serialization pins ───────────────────────────────────────────────────────

test('transcripts manifest: sha256 over path\\0sha256hex\\n rows, every file, POSIX paths, JS default sort', async () => {
  const dir = tempDir('um-et203-manifest-');
  // Distinct names in any case (NTFS and APFS fold case), so the sort is what varies.
  const files = { 'b/x.jsonl': 'one\n', 'Z/y.jsonl': 'two\r\n', 'a.txt': '', 'b/sub/z.jsonl': 'three' };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  // Independent reconstruction of the frozen serialization (byte-level, no shared code).
  const rows = Object.entries(files).map(([rel, body]) => [rel, sha(Buffer.from(body))]);
  rows.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  assert.deepEqual(rows.map((r) => r[0]), ['Z/y.jsonl', 'a.txt', 'b/sub/z.jsonl', 'b/x.jsonl'], 'uppercase sorts first');
  const expected = sha(Buffer.from(rows.map(([p, h]) => `${p}\0${h}\n`).join(''), 'utf8'));
  assert.equal(await transcriptsManifestHash(dir), expected);
});

test('corpus manifest: independent of point order, sensitive to payload, vector and id', () => {
  const h = corpusManifestHash(POINTS);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(corpusManifestHash([...POINTS].reverse()), h);
  // Key order inside a payload does not matter (canonical JSON).
  const reordered = POINTS.map((p) => ({ vector: p.vector, payload: Object.fromEntries(Object.entries(p.payload).reverse()), id: p.id }));
  assert.equal(corpusManifestHash(reordered), h);
  assert.notEqual(corpusManifestHash(POINTS.map((p, i) => (i ? p : { ...p, vector: [0.125, -0.5, 0.2500001] }))), h);
  assert.notEqual(corpusManifestHash(POINTS.map((p, i) => (i ? p : { ...p, payload: { ...p.payload, data: 'synthetic note onf' } }))), h);
  assert.notEqual(corpusManifestHash(POINTS.map((p, i) => (i ? p : { ...p, id: 'aaaa-9' }))), h);
});

test('anchor format: six labelled lines, parse(format(x)) round-trips, malformed refused', () => {
  const lines = Object.fromEntries(ANCHOR_LABELS.map((l, i) => [l, String(i).repeat(64)]));
  const text = formatAnchor(lines);
  assert.equal(text.split('\n').filter(Boolean).length, 6);
  assert.deepEqual(parseAnchor(text), { ok: true, lines });
  assert.equal(parseAnchor(text.replace('rule', 'rules')).ok, false);
  assert.equal(parseAnchor(text.split('\n').slice(1).join('\n')).ok, false, 'a missing label');
  assert.equal(parseAnchor(`${text}${'f'.repeat(64)}  rule\n`).ok, false, 'a duplicate label');
});

// ── A1–A5, A7 ────────────────────────────────────────────────────────────────

test('A1 a matching anchor → ok, with merge provenance; the hashes equal the anchor lines', async () => {
  const ctx = await anchoredRepo();
  const r = await verify(ctx);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.hashes, ctx.lines);
  assert.match(r.anchorBlob, /^[0-9a-f]{40}$/);
  assert.match(r.headCommit, /^[0-9a-f]{40}$/);
  for (const l of ANCHOR_LABELS) assert.equal(r.lines[l], true, l);
});

test('A2 a one-byte edit to the rule (committed and merged) → refused', async () => {
  const ctx = await anchoredRepo();
  flipOneByte(ctx.entries.rule);
  ctx.sb.commitAll('edit rule');
  ctx.sb.push();
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('rule-mismatch'), JSON.stringify(r.reasons));
  assert.ok(r.reasons.includes('server-tree-mismatch'), 'the rule is inside server/ too');
});

test('A2 a one-byte edit to the query set → refused', async () => {
  const ctx = await anchoredRepo();
  // One byte in a row (not the header, whose embedded hashes are A7's case).
  const qs = ctx.entries['query-set'];
  writeFileSync(qs, readFileSync(qs, 'utf8').replace('FAKE_ROW_X', 'FAKE_ROW_Y'));
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['query-set-mismatch']);
});

test('A2 a one-byte edit to the corpus dump → refused', async () => {
  const ctx = await anchoredRepo();
  flipOneByte(ctx.entries.corpus);
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['corpus-mismatch']);
});

test('A2 a one-byte edit to a committed server/ file → refused', async () => {
  const ctx = await anchoredRepo();
  ctx.sb.write('server/lib/sample.mjs', 'export const a = 1;\nexport const b = 3;\n');
  ctx.sb.commitAll('edit server');
  ctx.sb.push();
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['server-tree-mismatch']);
});

test('A2 control: a committed change OUTSIDE server/ and a new file under server/eval/results/ leave the tree hash alone', async () => {
  const ctx = await anchoredRepo();
  ctx.sb.write('README.md', 'sandbox edited\n');
  ctx.sb.write('server/eval/results/2026-10-20-new.json', '{}\n');
  ctx.sb.commitAll('outside');
  ctx.sb.push();
  const r = await verify(ctx);
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
});

test('A3 an uncommitted edit to a tracked server/ file → refused by the refreshed clean check', async () => {
  const ctx = await anchoredRepo();
  ctx.sb.write('server/lib/sample.mjs', 'export const a = 1;\nexport const b = 4;\n');
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('server-tree-dirty'), JSON.stringify(r.reasons));
  // An untracked file under server/ does not dirty the tree (--untracked-files=no).
  const ctx2 = await anchoredRepo();
  ctx2.sb.write('server/eval/results/scratch.json', '{}\n');
  assert.equal((await verify(ctx2)).ok, true);
});

test('A3 (spec D7, literal) the refresh itself must succeed: an uncommitted edit outside server/ also refuses', async () => {
  const ctx = await anchoredRepo();
  ctx.sb.write('README.md', 'sandbox, edited but not committed\n');
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('server-tree-dirty'), JSON.stringify(r.reasons));
});

test('A4 a missing anchor → refused', async () => {
  const ctx = await anchoredRepo({ skipAnchor: true });
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'anchor-missing');
});

test('A5 a one-byte edit to a snapshot transcript → refused', async () => {
  const ctx = await anchoredRepo();
  flipOneByte(join(ctx.entries.transcripts, 'C--proj-alpha', 'sess-a3.jsonl'));
  const r = await verify(ctx);
  assert.deepEqual(r.reasons, ['transcripts-mismatch']);
});

test('A5 an added file in the snapshot → refused', async () => {
  const ctx = await anchoredRepo();
  writeFileSync(join(ctx.entries.transcripts, 'extra.jsonl'), '{}\n');
  assert.deepEqual((await verify(ctx)).reasons, ['transcripts-mismatch']);
});

test('A5 a one-byte edit to the counters export → refused', async () => {
  const ctx = await anchoredRepo();
  const b = readFileSync(ctx.entries.counters);
  writeFileSync(ctx.entries.counters, Buffer.from(b.toString('utf8').replace('"n":10', '"n":11')));
  assert.deepEqual((await verify(ctx)).reasons, ['counters-mismatch']);
});

test('A7 a query set whose embedded rule hash differs from the rule line → refused', async () => {
  const ctx = await anchoredRepo({ header: { rule_sha256: 'e'.repeat(64) } });
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['query-set-rule-binding']);
});

test('A7 a query set whose embedded corpus hash differs from the corpus line → refused', async () => {
  const ctx = await anchoredRepo({ header: { corpus_manifest_sha256: 'd'.repeat(64) } });
  const r = await verify(ctx);
  assert.deepEqual(r.reasons, ['query-set-corpus-binding']);
});

// ── A8 ───────────────────────────────────────────────────────────────────────

test('A8 one commit, LF and CRLF working trees → one server-tree, both clean', async () => {
  const ctx = await anchoredRepo();
  const crlf = join(ctx.sb.root, 'crlf');
  runGit(ctx.sb.root, ctx.sb.env, ['-c', 'core.autocrlf=true', 'clone', '-q', ctx.sb.repo, crlf]);
  runGit(crlf, ctx.sb.env, ['config', 'core.autocrlf', 'true']);
  const lfBytes = readFileSync(join(ctx.sb.repo, 'server', 'lib', 'sample.mjs'));
  const crlfBytes = readFileSync(join(crlf, 'server', 'lib', 'sample.mjs'));
  assert.ok(!lfBytes.includes(Buffer.from('\r\n')), 'LF checkout');
  assert.ok(crlfBytes.includes(Buffer.from('\r\n')), 'the autocrlf checkout really is CRLF (else the case is vacuous)');
  const a = serverTreeHash({ repoDir: ctx.sb.repo, env: ctx.sb.env });
  const b = serverTreeHash({ repoDir: crlf, env: ctx.sb.env });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(a.hash, b.hash);
  assert.equal(a.hash, ctx.lines['server-tree']);
  assert.notEqual(sha(lfBytes), sha(crlfBytes), 'working-tree bytes differ; only the blob ids are hashed');
});

test('A8 control: the tree hash excludes the anchor and server/eval/results/, and is not a constant', async () => {
  const ctx = await anchoredRepo();
  const before = serverTreeHash({ repoDir: ctx.sb.repo, env: ctx.sb.env }).hash;
  ctx.sb.write('server/lib/another.mjs', 'export const c = 3;\n');
  ctx.sb.commitAll('add');
  assert.notEqual(serverTreeHash({ repoDir: ctx.sb.repo, env: ctx.sb.env }).hash, before);
});

// ── A6, A9, A11 (through run) ────────────────────────────────────────────────

test('A6 score with a mismatched anchor exits non-zero and writes nothing', async () => {
  const ctx = await anchoredRepo();
  flipOneByte(ctx.entries.corpus);
  const before = listAll(ctx.arc);
  const { deps, outLines, resultsDir } = harnessDeps(ctx);
  const code = await run(['score', '--arc-dir', ctx.arc], deps);
  assert.notEqual(code, 0);
  assert.deepEqual(listAll(ctx.arc), before, 'the arc dir is untouched');
  assert.deepEqual(listAll(resultsDir), [], 'no result written');
  assert.deepEqual(listAll(join(ctx.sb.repo, 'server', 'eval', 'results')), ['old-result.json:8']);
  const out = outLines.join('\n');
  assert.match(out, /corpus-mismatch/);
  assert.doesNotMatch(out, /recall|delta|verdict/i, 'no metric of any kind');
});

test('A9 a commit not reachable from origin/main: score refuses, freeze-check passes', async () => {
  const ctx = await anchoredRepo();
  ctx.sb.write('README.md', 'unmerged change outside server/\n');
  ctx.sb.commitAll('local only'); // not pushed
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'provenance-not-merged');
  assert.equal((await verify(ctx, false)).ok, true, 'contents alone still match');

  const s = harnessDeps(ctx);
  assert.notEqual(await run(['score', '--arc-dir', ctx.arc], s.deps), 0);
  assert.match(s.outLines.join('\n'), /provenance-not-merged/);
  assert.deepEqual(listAll(s.resultsDir), []);

  const f = harnessDeps(ctx);
  assert.equal(await run(['freeze-check', '--arc-dir', ctx.arc], f.deps), 0, f.outLines.join('\n'));
  const fc = f.outLines.join('\n');
  for (const l of ANCHOR_LABELS) assert.match(fc, new RegExp(`${l}.*PASS`));
  assert.doesNotMatch(fc, /FAIL/);
});

test('A11 an untracked anchor at a merged commit whose tree holds none → refused', async () => {
  const ctx = await anchoredRepo({ skipAnchor: true });
  // The operator's local copy, matching every input, but never committed.
  ctx.sb.write(ANCHOR_REL_PATH, formatAnchor(ctx.lines));
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'anchor-missing', 'the anchor is read from HEAD, never from the working tree');
  const s = harnessDeps(ctx);
  assert.notEqual(await run(['score', '--arc-dir', ctx.arc], s.deps), 0);
  assert.notEqual(await run(['freeze-check', '--arc-dir', ctx.arc], harnessDeps(ctx).deps), 0);
});

test('A11 a modified tracked anchor cannot make a run pass that the committed anchor refuses', async () => {
  const ctx = await anchoredRepo();
  // The committed anchor refuses an edited corpus ...
  flipOneByte(ctx.entries.corpus);
  assert.deepEqual((await verify(ctx)).reasons, ['corpus-mismatch']);
  // ... and rewriting the working-tree anchor to match the edited corpus is refused too.
  const doctored = { ...ctx.lines, corpus: corpusManifestHash(JSON.parse(readFileSync(ctx.entries.corpus, 'utf8'))) };
  ctx.sb.write(ANCHOR_REL_PATH, formatAnchor(doctored));
  const r = await verify(ctx);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('server-tree-dirty'), JSON.stringify(r.reasons));
  assert.ok(r.reasons.includes('corpus-mismatch'), 'still compared against HEAD\'s anchor');
  const s = harnessDeps(ctx);
  assert.notEqual(await run(['score', '--arc-dir', ctx.arc], s.deps), 0);
  assert.deepEqual(listAll(s.resultsDir), []);
});

test('fileSha256 hashes raw bytes (CRLF and a BOM are not normalised)', () => {
  const dir = tempDir('um-et203-bytes-');
  const p = join(dir, 'f');
  writeFileSync(p, Buffer.from('﻿a\r\nb', 'utf8'));
  assert.equal(fileSha256(p), sha(readFileSync(p)));
  assert.notEqual(fileSha256(p), sha(Buffer.from('a\nb')));
});
