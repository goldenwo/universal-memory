/**
 * server/eval/summary-eval.mjs — keyed session-summary eval (model migration Phase B, spec R2;
 * docs/plans/2026-10-25-model-migration-phase-b/prereg.md "S-sum").
 *
 * Measures whether a summarizer arm's session summaries keep the identifiers summarize.txt asks
 * for ("cite file paths, function names, commit hashes, ticket IDs"). Scope is identifier
 * retention only (prereg S-sum Scope, operator ruling 2026-10-26).
 *
 * Sibling of state-cap-eval.mjs: the PURE parts (normaliser, matcher, invented-identifier
 * classes, format rule, the five controls, the aggregate) are named exports unit-tested offline in
 * test/summary-eval.test.mjs; the CLI shim is guarded by IS_MAIN so importing this module never
 * calls a provider.
 *
 * Inputs (gitignored, main checkout only): inputs-summary/<id>.txt, each the exact text one
 * production checkpoint passed to summarize (rebuilt and hash-checked in plan T2), and
 * labels-summary.json, {"<id>": {"keys": [...]}}, written from the transcripts before any arm.
 *
 * Usage (from server/):
 *   node eval/summary-eval.mjs --inputs <dir> --labels <json> --controls-only
 *   node --env-file=.env eval/summary-eval.mjs --inputs <dir> --labels <json> --model <id> [--provider openai] --out <run.json>
 *   node eval/summary-eval.mjs --aggregate --aliases <selection.json> --out <numbers.json> <run.json>...
 * A run file carries raw summary text and stays under docs/plans/… (gitignored); the aggregate
 * carries numbers only, with sessions as their sum-NN alias.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalise as stateCapNormalise } from './state-cap-eval.mjs';

// ---------------------------------------------------------------------------
// Normaliser and matcher (prereg S-sum "Normaliser", "Matcher")
// ---------------------------------------------------------------------------

/**
 * state-cap-eval's normaliser (delete `* \` _ ( ) [ ]`, collapse whitespace, case-fold), plus `\`
 * folded to `/` and a leading `v` stripped from a version token. Applied to both sides.
 */
export function normalise(s) {
  return stateCapNormalise(String(s).replace(/\\/g, '/')).replace(/(?<![\p{L}\p{N}])v(?=\d+(?:\.\d+)+)/gu, '');
}

const WORDISH = /[\p{L}\p{N}]/u;

/**
 * True when the normalised `needle` occurs in the normalised `hay` with no letter or digit
 * immediately before or after it, so `#39` is not credited by `#394`. Both are already normalised.
 */
export function occursBounded(needle, hay) {
  if (!needle) return false;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 ? hay[i - 1] : '';
    const after = hay[i + needle.length] ?? '';
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true;
  }
  return false;
}

/** Per key: found in the summary under the matcher. Returns {found, missed} (the keys as labelled). */
export function findKeys(keys, summary) {
  const ns = normalise(summary);
  const found = [], missed = [];
  for (const k of keys) (occursBounded(normalise(k), ns) ? found : missed).push(k);
  return { found, missed };
}

// ---------------------------------------------------------------------------
// Invented identifiers (prereg S-sum "Invented identifiers")
// ---------------------------------------------------------------------------

// The four token classes, matched on normalised text, each anchored at token boundaries. A `/`
// next to an issue ref, hex string or version means it is part of a path, which the path class
// owns, so a path is never counted twice.
export const IDENTIFIER_CLASSES = Object.freeze({
  issue: /(?<![\p{L}\p{N}/])#\d+(?!\d)/gu,
  path: /(?<![\p{L}\p{N}./~-])[\p{L}\p{N}.~-]*(?:\/[\p{L}\p{N}.~@-]+)+\.[a-z][a-z0-9]{0,7}(?![\p{L}\p{N}/])/gu,
  hex: /(?<![\p{L}\p{N}/])[0-9a-f]{7,40}(?![\p{L}\p{N}/])/gu,
  version: /(?<![\p{L}\p{N}./])\d+\.\d+\.\d+(?![\d./])/gu,
});

/** The distinct identifier tokens in `text` (normalised), by class. A hex token must hold an a–f letter. */
export function identifierTokens(text) {
  const n = normalise(text);
  const out = {};
  for (const [cls, re] of Object.entries(IDENTIFIER_CLASSES)) {
    const toks = [...n.matchAll(re)].map((m) => m[0]).filter((t) => cls !== 'hex' || /[a-f]/.test(t));
    out[cls] = [...new Set(toks)];
  }
  return out;
}

/**
 * The identifier tokens of `summary` that do not occur in the normalised transcript under the
 * matcher's boundary rule, as [{cls, token}]. Counted once per distinct token.
 */
export function inventedIdentifiers(summary, transcript) {
  const nt = normalise(transcript);
  const out = [];
  for (const [cls, toks] of Object.entries(identifierTokens(summary))) {
    for (const token of toks) if (!occursBounded(token, nt)) out.push({ cls, token });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format (prereg S-sum "Format")
// ---------------------------------------------------------------------------

export const SUMMARY_HEADINGS = Object.freeze(['What happened', 'Key decisions', 'In flight', 'Next steps']);

/** Sentences in a no-heading summary: runs ended by . ! or ? followed by whitespace or the end. */
export function sentenceCount(text) {
  return String(text).split(/[.!?]+(?=\s|$)/).filter((s) => s.trim()).length;
}

/**
 * At least one of summarize.txt's four headings, or <= 3 sentences (the trivial-session form);
 * no code fence; no preamble line. A preamble line is any non-empty line before the first heading
 * in the headings form, or, in the trivial form, a first line ending in ':' (a lead-in).
 */
export function formatOk(summary) {
  const text = String(summary ?? '');
  const lines = text.split(/\r?\n/);
  const codeFence = /^\s*(```|~~~)/m.test(text);
  const headings = SUMMARY_HEADINGS.filter((h) => new RegExp(`^##\\s+${h}\\s*$`, 'im').test(text));
  let preamble, sentences = null;
  if (headings.length) {
    const first = lines.findIndex((l) => /^#{1,6}\s/.test(l));
    preamble = lines.slice(0, first < 0 ? lines.length : first).some((l) => l.trim());
  } else {
    sentences = sentenceCount(text);
    preamble = /:\s*$/.test(lines.find((l) => l.trim()) ?? '');
  }
  const form = headings.length ? 'headings' : 'trivial';
  const ok = !codeFence && !preamble && (form === 'headings' || (sentences >= 1 && sentences <= 3));
  return { ok, form, headings: headings.length, sentences, codeFence, preamble };
}

// ---------------------------------------------------------------------------
// Controls (prereg Controls "S-sum"; the eval refuses to run if any part fails)
// ---------------------------------------------------------------------------

export const FABRICATED = Object.freeze({
  issue: '#99999',
  path: 'src/nope/fake.mjs',
  hex: 'deadbeefcafe0123456789abcdef0123456789ab',
  version: 'v9.9.9',
});
export const HARMLESS = Object.freeze({
  appended: ['v1.2.3', 'server\\lib\\x.mjs', 'ABCDEF1234567'],
  summary: ['1.2.3', 'server/lib/x.mjs', 'abcdef1234567'],
});

/**
 * The five S-sum controls over `sessions` ({id: transcript}) and `labels` ({id: {keys}}):
 *   1 top — every key is found in its own transcript;
 *   2 cross-session — no session's key is found in another session's transcript;
 *   3 middle — a synthetic summary of exactly the first floor(k/2) keys scores exactly that fraction;
 *   4 invented — the transcript plus one fabricated token per class, scored as a summary, has
 *     exactly 4 invented identifiers;
 *   5 harmless — the transcript plus v1.2.3, server\lib\x.mjs and ABCDEF1234567, against a summary
 *     of 1.2.3, server/lib/x.mjs and abcdef1234567, has 0 invented identifiers.
 */
export function controls(sessions, labels) {
  const out = {
    ok: true,
    top: { ok: true, missing: [] },
    cross: { ok: true, hits: [] },
    middle: { ok: true, failures: [] },
    invented: { ok: true, failures: [] },
    harmless: { ok: true, failures: [] },
    keys: { sessions: 0, total: 0, min: null, max: null },
  };
  const ids = Object.keys(labels);
  for (const id of Object.keys(sessions)) if (!labels[id]) { out.top.ok = false; out.top.missing.push({ id, key: '(no labels for this session)' }); }
  for (const id of ids) {
    const transcript = sessions[id];
    const keys = labels[id]?.keys ?? [];
    if (typeof transcript !== 'string') { out.top.ok = false; out.top.missing.push({ id, key: '(transcript missing)' }); continue; }
    out.keys.sessions++; out.keys.total += keys.length;
    out.keys.min = out.keys.min === null ? keys.length : Math.min(out.keys.min, keys.length);
    out.keys.max = out.keys.max === null ? keys.length : Math.max(out.keys.max, keys.length);
    const own = findKeys(keys, transcript);
    for (const key of own.missed) { out.top.ok = false; out.top.missing.push({ id, key }); }
    for (const other of ids) {
      if (other === id || typeof sessions[other] !== 'string') continue;
      for (const key of findKeys(keys, sessions[other]).found) { out.cross.ok = false; out.cross.hits.push({ id, key, foundIn: other }); }
    }
    const half = Math.floor(keys.length / 2);
    const mid = findKeys(keys, keys.slice(0, half).join('\n'));
    if (mid.found.length !== half) { out.middle.ok = false; out.middle.failures.push({ id, expected: half, found: mid.found.length, of: keys.length }); }
    const fab = inventedIdentifiers(`${transcript}\n${Object.values(FABRICATED).join('\n')}`, transcript);
    if (fab.length !== 4) { out.invented.ok = false; out.invented.failures.push({ id, count: fab.length, invented: fab }); }
    const harm = inventedIdentifiers(HARMLESS.summary.join('\n'), `${transcript}\n${HARMLESS.appended.join('\n')}`);
    if (harm.length !== 0) { out.harmless.ok = false; out.harmless.failures.push({ id, invented: harm }); }
  }
  out.ok = out.top.ok && out.cross.ok && out.middle.ok && out.invented.ok && out.harmless.ok;
  return out;
}

// ---------------------------------------------------------------------------
// Per-summary score and the run aggregate
// ---------------------------------------------------------------------------

/** One summary against its own transcript and keys. */
export function scoreSummary({ summary, transcript, keys }) {
  const { found, missed } = findKeys(keys, summary);
  const invented = inventedIdentifiers(summary, transcript);
  return { keysTotal: keys.length, keysFound: found.length, found, missed, invented, inventedCount: invented.length, format: formatOk(summary), length: String(summary).length };
}

/**
 * Numbers over one or more runs. Invoke-errors (ok !== true) are excluded from every rate and
 * counted (prereg Error scoring); `errorRate` is per run, for the 5% rule.
 */
export function aggregate(runs) {
  const perRun = runs.map((r) => {
    const ok = r.calls.filter((c) => c.ok === true);
    return {
      calls: r.calls.length, errors: r.calls.length - ok.length, errorRate: r.calls.length ? (r.calls.length - ok.length) / r.calls.length : 0,
      keysFound: ok.reduce((a, c) => a + c.score.keysFound, 0), keysTotal: ok.reduce((a, c) => a + c.score.keysTotal, 0),
      invented: ok.reduce((a, c) => a + c.score.inventedCount, 0), formatOk: ok.filter((c) => c.score.format.ok).length,
      length: ok.reduce((a, c) => a + c.score.length, 0), summaries: ok.length,
    };
  });
  const sum = (k) => perRun.reduce((a, r) => a + r[k], 0);
  const summaries = sum('summaries');
  return {
    runs: perRun.length,
    recall: sum('keysTotal') ? sum('keysFound') / sum('keysTotal') : null,
    inventedPerSummary: summaries ? sum('invented') / summaries : null,
    formatPerRun: perRun.length ? sum('formatOk') / perRun.length : null,
    meanLength: summaries ? sum('length') / summaries : null,
    perRun,
  };
}

// ---------------------------------------------------------------------------
// CLI shim — guarded by IS_MAIN; the only place a provider is called.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { provider: 'openai', runFiles: [] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--inputs') a.inputs = next();
    else if (k === '--labels') a.labels = next();
    else if (k === '--model') a.model = next();
    else if (k === '--provider') a.provider = next();
    else if (k === '--out') a.out = next();
    else if (k === '--controls-only') a.controlsOnly = true;
    else if (k === '--aggregate') a.aggregate = true;
    else if (k === '--aliases') a.aliases = next();
    else if (k.startsWith('--')) throw new Error(`unknown arg ${k}`);
    else a.runFiles.push(k);
  }
  return a;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function loadSessions(dir, labels) {
  const sessions = {};
  for (const name of (await fs.readdir(dir)).filter((n) => n.endsWith('.txt')).sort()) {
    sessions[name.slice(0, -4)] = await fs.readFile(path.join(dir, name), 'utf8');
  }
  for (const id of Object.keys(labels)) if (!(id in sessions)) throw new Error(`labels name ${id}, which has no input`);
  return sessions;
}

async function cliMain() {
  const args = parseArgs(process.argv);
  if (args.aggregate) {
    if (!args.aliases || !args.out || !args.runFiles.length) { console.error('usage: --aggregate --aliases <selection.json> --out <json> <run.json>...'); process.exit(2); }
    const alias = new Map(JSON.parse(await fs.readFile(args.aliases, 'utf8')).selection.map((s) => [s.id, s.alias]));
    const runs = await Promise.all(args.runFiles.map(async (f) => JSON.parse(await fs.readFile(f, 'utf8'))));
    const agg = aggregate(runs);
    const perSession = {};
    for (const r of runs) for (const c of r.calls) {
      const a = alias.get(c.id);
      if (!a) throw new Error(`${c.id} has no alias`);
      const s = (perSession[a] ??= { keysTotal: c.score?.keysTotal ?? null, found: [], invented: [], formatOk: [], length: [], errors: 0 });
      if (c.ok !== true) { s.errors++; continue; }
      s.found.push(c.score.keysFound); s.invented.push(c.score.inventedCount); s.formatOk.push(c.score.format.ok); s.length.push(c.score.length);
    }
    const out = { schema_version: 1, prereg: 'docs/plans/2026-10-25-model-migration-phase-b/prereg.md#s-sum', model: runs[0]?.model ?? null, aggregate: agg, perSession };
    await fs.writeFile(args.out, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`[summary-eval] aggregate (numbers only) written to ${args.out}`);
    return;
  }

  if (!args.inputs || !args.labels) { console.error('usage: --inputs <dir> --labels <json> (--controls-only | --model <id> --out <json>)'); process.exit(2); }
  const labels = JSON.parse(await fs.readFile(args.labels, 'utf8'));
  const sessions = await loadSessions(args.inputs, labels);
  const ctl = controls(sessions, labels);
  console.log(`[summary-eval] controls: top ${ctl.top.ok} cross ${ctl.cross.ok} middle ${ctl.middle.ok} invented ${ctl.invented.ok} harmless ${ctl.harmless.ok} (${ctl.keys.sessions} sessions, ${ctl.keys.total} keys, ${ctl.keys.min}–${ctl.keys.max} per session)`);
  if (!ctl.ok) { console.error(JSON.stringify(ctl, null, 2)); process.exit(2); }
  if (args.controlsOnly) return;

  if (!args.model || !args.out) { console.error('--model and --out are required for a run (no default model)'); process.exit(2); }
  const { summarize } = await import('../lib/summarize.mjs');
  const { NOOP_METRICS } = await import('../lib/metrics.mjs');
  const promptPath = fileURLToPath(new URL('../config/prompts/summarize.txt', import.meta.url));
  const systemPrompt = await fs.readFile(promptPath, 'utf8');
  const ranAt = new Date().toISOString();
  const calls = [];
  for (const id of Object.keys(labels)) {
    const t0 = performance.now();
    let r;
    try {
      r = await summarize(sessions[id], { backend: args.provider, provider: args.provider, model: args.model, systemPrompt, metrics: NOOP_METRICS });
    } catch (err) {
      // An invoke-error: excluded from every rate and counted toward the 5% rule (prereg Error scoring).
      calls.push({ id, ok: false, failCause: 'invoke-error', ms: performance.now() - t0, error: String(err?.message ?? err).slice(0, 200) });
      console.log(`[summary-eval] ${id}: invoke-error`);
      continue;
    }
    const ms = performance.now() - t0;
    const summary = r.summary ?? '';
    const score = scoreSummary({ summary, transcript: sessions[id], keys: labels[id].keys });
    calls.push({
      id, ok: true, ms,
      requestParams: r.requestParams, servedModel: r.servedModel, systemFingerprint: r.systemFingerprint,
      reasoningTokens: r.reasoningTokens, stopReason: r.stopReason,
      costUsd: r.costUsd, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
      summary, score,
    });
    console.log(`[summary-eval] ${id}: keys ${score.keysFound}/${score.keysTotal} invented ${score.inventedCount} format ${score.format.ok} len ${score.length}`);
  }
  const out = {
    suite: 'S-sum', provider: args.provider, model: args.model, ranAt,
    promptSha256: sha256(systemPrompt), labelsSha256: sha256(await fs.readFile(args.labels)),
    inputs: Object.keys(labels).map((id) => ({ id, sha256: sha256(sessions[id]) })),
    controls: ctl, calls,
  };
  await fs.writeFile(args.out, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`[summary-eval] run written to ${args.out}`);
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) cliMain().catch((e) => { console.error('[summary-eval] FATAL:', e?.message ?? e); process.exit(1); });
