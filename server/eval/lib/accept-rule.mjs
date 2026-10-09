// server/eval/lib/accept-rule.mjs — #203 (spec D7, §4.2.4): the mechanical
// pre-registration check for server/eval/exact-token-203.mjs.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record):
//
// • THE ANCHOR BINDS SIX THINGS. server/eval/accept-rule-203.sha256 holds one
//   `<sha256>  <label>` line for each of ANCHOR_LABELS:
//     rule         sha256 of the rule JSON's bytes
//     query-set    sha256 of <arc-dir>/query-set.jsonl's bytes
//     corpus       corpusManifestHash() over <arc-dir>/corpus.json
//     transcripts  transcriptsManifestHash() over <arc-dir>/transcripts/
//     counters     sha256 of <arc-dir>/counters-export.json's bytes
//     server-tree  serverTreeHash() over HEAD's server/ tree
//   and the query set's header must embed the same rule and corpus hashes, so a
//   frozen query set is bound to the rule and the corpus it was built under.
//   File hashes read RAW bytes: no decoding, no line-ending normalisation.
//
// • THE ANCHOR IS READ FROM HEAD'S TREE (`git show HEAD:<path>`), never from the
//   working tree: an untracked or edited local copy cannot drive a number. With
//   `provenance`, HEAD must also be reachable from origin/main after a fetch, so
//   an anchor committed on an unmerged branch cannot drive one either. Only
//   `freeze-check` (contents only, computes nothing) runs without provenance.
//
// • THE TREE IS HASHED FROM GIT'S OBJECT STORE (`git ls-tree`: mode, blob id,
//   path), so a CRLF working tree and an LF one of the same commit hash alike.
//   The anchor itself and server/eval/results/ are excluded (the anchor cannot
//   hash itself; a result file is written after the freeze). Because blob ids
//   say nothing about the working tree, the hash is only meaningful after a
//   refreshed clean check: `git update-index --really-refresh` must succeed and
//   `git status --porcelain --untracked-files=no -- server/` must be empty.
//
// • REFUSALS ARE CODES. Nothing here throws through to a caller's output and no
//   message quotes an input: every failure is one of the fixed codes below,
//   which the harness's rule vocabulary (codes.refusals) also lists.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ANCHOR_REL_PATH = 'server/eval/accept-rule-203.sha256';
export const RULE_REL_PATH = 'server/eval/exact-token-203-accept-rule.json';
export const RESULTS_REL_PREFIX = 'server/eval/results/';
export const ANCHOR_LABELS = Object.freeze(['rule', 'query-set', 'corpus', 'transcripts', 'counters', 'server-tree']);

/** The refusal codes this module can return (all listed in the rule's codes.refusals). */
export const ANCHOR_CODES = Object.freeze([
  'anchor-missing', 'anchor-malformed', 'rule-mismatch', 'query-set-mismatch', 'corpus-mismatch',
  'transcripts-mismatch', 'counters-mismatch', 'server-tree-mismatch', 'server-tree-dirty',
  'query-set-rule-binding', 'query-set-corpus-binding', 'provenance-fetch-failed',
  'provenance-not-merged', 'provenance-check-failed', 'git-failed', 'transcripts-unreadable', 'input-missing',
]);

const MISMATCH = Object.freeze({
  rule: 'rule-mismatch', 'query-set': 'query-set-mismatch', corpus: 'corpus-mismatch',
  transcripts: 'transcripts-mismatch', counters: 'counters-mismatch', 'server-tree': 'server-tree-mismatch',
});

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** sha256 of a file's raw bytes. */
export function fileSha256(path) {
  return sha256Hex(readFileSync(path));
}

/** JSON with object keys sorted at every depth (arrays keep their order). */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * The corpus manifest: one canonical-JSON row `[id, payload, vector]` per point,
 * rows sorted by id (then by row text), sha256 over the rows each ended by "\n".
 * Independent of point order and of key order inside a payload.
 */
export function corpusManifestHash(points) {
  const rows = points.map((p) => ({ id: String(p.id), row: canonicalJson([String(p.id), p.payload ?? null, p.vector ?? null]) }));
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.row < b.row ? -1 : a.row > b.row ? 1 : 0));
  const h = createHash('sha256');
  for (const r of rows) h.update(`${r.row}\n`, 'utf8');
  return h.digest('hex');
}

function walkFiles(root, rel = '') {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(root, r));
    else if (e.isFile()) out.push(r);
    else throw Object.assign(new Error('non-regular entry'), { code203: 'transcripts-unreadable' });
  }
  return out;
}

function streamSha256(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The transcript snapshot manifest, exactly as T0b serialised it: one row per
 * file under `dir` (every file, at any depth), `relative POSIX path + "\0" +
 * sha256hex(bytes) + "\n"`, rows sorted by JavaScript's default string
 * comparison on the path, sha256 over the concatenation.
 */
export async function transcriptsManifestHash(dir) {
  const paths = walkFiles(dir).sort();
  const h = createHash('sha256');
  for (const p of paths) h.update(`${p}\0${await streamSha256(join(dir, ...p.split('/')))}\n`, 'utf8');
  return h.digest('hex');
}

function git(repoDir, env, args, { binary = false } = {}) {
  const r = spawnSync('git', args, { cwd: repoDir, env, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 1 << 28 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout };
}

function topLevel(repoDir, env) {
  const r = git(repoDir, env, ['rev-parse', '--show-toplevel']);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * sha256 over HEAD's server/ tree entries from `git ls-tree -r` (mode, blob id,
 * path), sorted by path, the anchor and server/eval/results/ excluded, each row
 * `${mode} ${oid}\t${path}\n`. Refuses (code) unless a really-refresh succeeds
 * and no tracked file under server/ is modified.
 * @returns {{ ok: true, hash: string } | { ok: false, reason: string }}
 */
export function serverTreeHash({ repoDir, env = process.env } = {}) {
  const top = topLevel(repoDir, env);
  if (!top) return { ok: false, reason: 'git-failed' };
  // Spec D7, literally: the refresh must SUCCEED. It fails when any tracked file
  // in the checkout needs an update, inside server/ or not — stricter than the
  // status check below, and run in a fresh worktree where nothing is modified.
  if (git(top, env, ['update-index', '--really-refresh']).status !== 0) {
    return { ok: false, reason: 'server-tree-dirty' };
  }
  const st = git(top, env, ['status', '--porcelain', '--untracked-files=no', '--', 'server/']);
  if (st.status !== 0) return { ok: false, reason: 'git-failed' };
  if (st.stdout.trim() !== '') return { ok: false, reason: 'server-tree-dirty' };
  const ls = git(top, env, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', 'server/'], { binary: true });
  if (ls.status !== 0) return { ok: false, reason: 'git-failed' };
  const rows = [];
  for (const entry of ls.stdout.toString('utf8').split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, , oid] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (path === ANCHOR_REL_PATH || path.startsWith(RESULTS_REL_PREFIX)) continue;
    rows.push({ path, row: `${mode} ${oid}\t${path}\n` });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const h = createHash('sha256');
  for (const r of rows) h.update(r.row, 'utf8');
  return { ok: true, hash: h.digest('hex') };
}

/** Parse the anchor's six `<sha256>  <label>` lines; anything else is malformed. */
export function parseAnchor(text) {
  const lines = {};
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw === '') continue;
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(raw);
    if (!m || !ANCHOR_LABELS.includes(m[2]) || m[2] in lines) return { ok: false, reason: 'anchor-malformed' };
    lines[m[2]] = m[1];
  }
  if (ANCHOR_LABELS.some((l) => !(l in lines))) return { ok: false, reason: 'anchor-malformed' };
  return { ok: true, lines: Object.fromEntries(ANCHOR_LABELS.map((l) => [l, lines[l]])) };
}

/** The anchor file's text for a set of lines (fixed label order, LF). */
export function formatAnchor(lines) {
  return ANCHOR_LABELS.map((l) => `${lines[l]}  ${l}\n`).join('');
}

/** The query set's header (its first line), or null when absent or not JSON. */
export function readQuerySetHeader(path) {
  try {
    const text = readFileSync(path, 'utf8');
    const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
    const h = JSON.parse(first);
    return h && h.kind === 'header' ? h : null;
  } catch {
    return null;
  }
}

async function hashLabel(label, entries, { repoDir, env }) {
  switch (label) {
    case 'rule': return fileSha256(entries.rule);
    case 'query-set': return fileSha256(entries['query-set']);
    case 'counters': return fileSha256(entries.counters);
    case 'corpus': {
      let points;
      try { points = JSON.parse(readFileSync(entries.corpus, 'utf8')); } catch { return null; }
      return Array.isArray(points) ? corpusManifestHash(points) : null;
    }
    case 'transcripts': {
      if (!statSync(entries.transcripts).isDirectory()) return null;
      return transcriptsManifestHash(entries.transcripts);
    }
    case 'server-tree': {
      const t = serverTreeHash({ repoDir, env });
      return t.ok ? t.hash : t;
    }
    default: return null;
  }
}

/**
 * The six lines for the current inputs, as the freeze PR commits them. Throws a
 * code-bearing error when an input is missing or the tree is not clean — this
 * is an operator tool, run before anything is anchored.
 */
export async function computeAnchorLines(entries, { repoDir, env = process.env } = {}) {
  const lines = {};
  for (const l of ANCHOR_LABELS) {
    const h = await hashLabel(l, entries, { repoDir, env });
    if (typeof h !== 'string') throw Object.assign(new Error(`cannot hash ${l}`), { code203: h?.reason ?? 'input-missing' });
    lines[l] = h;
  }
  return lines;
}

/**
 * Verify the inputs against the anchor committed in HEAD's tree.
 *
 * @param {{ rule: string, 'query-set': string, corpus: string, transcripts: string, counters: string }} entries
 *   resolved paths for the five file labels (server-tree comes from `repoDir`)
 * @param {{ repoDir: string, env?: object, provenance?: boolean }} opts
 * @returns {Promise<{ ok: boolean, reason: string|null, reasons: string[],
 *   lines: Record<string, boolean>, hashes: Record<string, string|null>,
 *   anchorBlob: string|null, headCommit: string|null }>}
 *   Never throws: every failure is a code in `reasons` (`reason` is the first).
 */
export async function verifyAnchor(entries, { repoDir, env = process.env, provenance = false } = {}) {
  const result = (reasons, extra = {}) => ({
    ok: reasons.length === 0, reason: reasons[0] ?? null, reasons,
    lines: Object.fromEntries(ANCHOR_LABELS.map((l) => [l, false])), hashes: {}, anchorBlob: null, headCommit: null, ...extra,
  });
  try {
    const top = topLevel(repoDir, env);
    if (!top) return result(['git-failed']);

    if (provenance) {
      if (git(top, env, ['fetch', '--quiet', 'origin']).status !== 0) return result(['provenance-fetch-failed']);
      const anc = git(top, env, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']).status;
      if (anc === 1) return result(['provenance-not-merged']);
      if (anc !== 0) return result(['provenance-check-failed']);
    }

    const shown = git(top, env, ['show', `HEAD:${ANCHOR_REL_PATH}`]);
    if (shown.status !== 0) return result(['anchor-missing']);
    const parsed = parseAnchor(shown.stdout);
    if (!parsed.ok) return result([parsed.reason]);
    const anchorBlob = git(top, env, ['rev-parse', `HEAD:${ANCHOR_REL_PATH}`]).stdout.trim();
    const headCommit = git(top, env, ['rev-parse', 'HEAD']).stdout.trim();

    const reasons = [];
    const lines = {};
    const hashes = {};
    for (const label of ANCHOR_LABELS) {
      let h;
      try {
        h = await hashLabel(label, entries, { repoDir: top, env });
      } catch (e) {
        h = { reason: e?.code203 ?? 'input-missing' };
      }
      if (typeof h === 'string') {
        hashes[label] = h;
        lines[label] = h === parsed.lines[label];
        if (!lines[label]) reasons.push(MISMATCH[label]);
      } else {
        hashes[label] = null;
        lines[label] = false;
        reasons.push(h?.reason ?? MISMATCH[label]);
      }
    }
    // The query set must embed the rule and corpus it was built under.
    const header = readQuerySetHeader(entries['query-set']);
    if (!header || header.rule_sha256 !== parsed.lines.rule) reasons.push('query-set-rule-binding');
    if (!header || header.corpus_manifest_sha256 !== parsed.lines.corpus) reasons.push('query-set-corpus-binding');
    return result([...new Set(reasons)], { lines, hashes, anchorBlob, headCommit });
  } catch {
    return result(['git-failed']);
  }
}
