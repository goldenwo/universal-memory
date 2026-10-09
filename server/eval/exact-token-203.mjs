/**
 * server/eval/exact-token-203.mjs — #203: does naming a thing by its identifier
 * retrieve worse than naming it in words, with informativeness held constant?
 * The pre-registered instrument (spec D1–D10; plan PR 2).
 *
 *   node --env-file=<main checkout>/server/.env eval/exact-token-203.mjs <subcommand> --arc-dir <absolute path>
 *
 * Subcommands:
 *   build         population (D4), glosses + G-shape (D1/D2), J1/J2/J3 and the
 *                 planted cases (D2/D3); writes <arc-dir>/query-set.jsonl
 *                 (embedding the corpus manifest and rule hashes) and prints a
 *                 counts-only summary. Reads no retrieval.
 *   calibrate     run 0 (D7): clone integrity, the verbatim probe, the id-space
 *                 guard and determinism on NON-primary rows only; PASS/FAIL per
 *                 check, no recall figure, no file written. Needs no anchor.
 *   freeze-check  the pre-merge contents check (verifyAnchor without merge
 *                 provenance); PASS/FAIL per anchor line, computes nothing else.
 *   score         verifyAnchor WITH provenance first, then in one process: the
 *                 census (D9), the clone, the probe, pass 1, the controls,
 *                 pass 2, the verdict (D8) and the allowlisted aggregate write.
 *
 * LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
 * durable record):
 *
 * • NO OVERRIDE SEAMS: the CLI reads the rule and the anchor only from their
 *   tracked paths (the anchor from HEAD's tree), the corpus, query set,
 *   transcripts and counters only from --arc-dir (bound by the anchor's
 *   hashes), and every parameter from the rule through ONE loader. The only
 *   flag is --arc-dir. Tests drive run(argv, deps) with injected stubs.
 *
 * • READ PATH (D5): doSearch(q, fetch_depth, false, true, { memory }) over a
 *   scratch clone on a local qdrant, `memory` built as production builds it —
 *   wrapMem0Read(new Memory(...)) — with MEM0_USER_ID pinned from the rule
 *   BEFORE mem0-mcp-http.mjs is imported. Refuses a non-system point under any
 *   other user id, an embedder config that differs from the rule's, and fails
 *   closed when UM_TEMPORAL_QUERY or UM_TEMPORAL_DECAY is 'true'.
 *
 * • OUTCOME-BLIND UNTIL THE END: everything the verdict reads — Δ, its CI, C1,
 *   C2, C3, thinning, the floor, the guards — is computed before the verdict
 *   function runs. A throw before it is a refusal that writes nothing (fixable
 *   under a tree-only re-freeze); a throw after it is VOID `post-verdict-error`.
 *
 * • CODES ONLY: every refusal and VOID is a code from the rule's vocabulary,
 *   never exception text (an id-space message quotes an identifier; a parse
 *   error quotes LLM output). Row-level data goes only to --arc-dir (gitignored);
 *   the tracked result and stdout go through the allowlisted writer.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIdSpace, projectedId, verbatimProbe } from './exact-token-eval.mjs';
import {
  ANCHOR_LABELS, RULE_REL_PATH, corpusManifestHash, readQuerySetHeader, verifyAnchor,
} from './lib/accept-rule.mjs';
import { loadRule, EMITTED_REFUSAL_CODES, EMITTED_VOID_CODES } from './lib/exact-token-203-rule.mjs';
import { runCensus, d10Branch } from './lib/query-shape-census.mjs';
import {
  QUERY_SET_SCHEMA, ROLES, buildSummary, checkCorpus, plantSummary, runBuild,
} from './lib/exact-token-203-build.mjs';
import {
  RESULT_SCHEMA_ID, assertAllowlisted, bootstrapCI, bootstrapLowerBound, buildSummarySchema, classThinning,
  decideVerdict, dedupe, derange, dfBandKey, heldOutDeltas, mcnemarExactP, mean, recallAt, reciprocalRank,
  resultSchema, scramble, writeAllowlisted,
} from './lib/exact-token-203-score.mjs';

export const SUBCOMMANDS = Object.freeze(['build', 'calibrate', 'freeze-check', 'score']);
const REPO_DIR = fileURLToPath(new URL('../..', import.meta.url));
const KNOWN_CODES = new Set([...EMITTED_REFUSAL_CODES, ...EMITTED_VOID_CODES]);

const codeErr = (code) => Object.assign(new Error(code), { code203: code });
const codeOf = (e) => (KNOWN_CODES.has(e?.code203) ? e.code203 : 'internal-error');

function parseArgs(argv) {
  const [sub, ...rest] = argv ?? [];
  if (!SUBCOMMANDS.includes(sub)) return null;
  if (rest.length !== 2 || rest[0] !== '--arc-dir' || !isAbsolute(rest[1])) return null;
  return { sub, arcDir: rest[1] };
}

function arcPaths(arcDir, repoDir) {
  return {
    entries: {
      rule: join(repoDir, ...RULE_REL_PATH.split('/')),
      'query-set': join(arcDir, 'query-set.jsonl'),
      corpus: join(arcDir, 'corpus.json'),
      transcripts: join(arcDir, 'transcripts'),
      counters: join(arcDir, 'counters-export.json'),
    },
    rows: join(arcDir, 'score-rows.jsonl'),
  };
}

function loadTrackedRule(d) {
  let bytes;
  try {
    bytes = readFileSync(join(d.repoDir, ...RULE_REL_PATH.split('/')));
  } catch {
    throw codeErr('input-missing');
  }
  const l = loadRule(bytes);
  if (!l.ok) throw Object.assign(codeErr('rule-invalid'), { key: l.key });
  return l;
}

function readCorpus(path) {
  let points;
  try {
    points = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw codeErr(e?.code === 'ENOENT' ? 'input-missing' : 'corpus-malformed');
  }
  return points;
}

function readQuerySet(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw codeErr('input-missing');
  }
  let parsed;
  try {
    parsed = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    throw codeErr('query-set-malformed');
  }
  const [header, ...rows] = parsed;
  const ok = header?.kind === 'header' && header.schema === QUERY_SET_SCHEMA
    && rows.every((r) => r?.kind === 'row' && typeof r.identifier === 'string' && Array.isArray(r.relevant)
      && ROLES.includes(r.role) && typeof r.seed_id === 'string');
  if (!ok) throw codeErr('query-set-malformed');
  return { header, rows };
}

/** D5: fail closed on a re-ranking read-path flag or a different embedder. */
async function checkReadPathEnv(rule, d) {
  for (const k of rule.read_path.fail_closed_env) if (d.env[k] === 'true') throw codeErr('env-temporal-flag');
  let cfg;
  try {
    cfg = (d.embedderConfig ?? (await import('../lib/embed.mjs')).getEmbedderConfig)(d.env);
  } catch {
    throw codeErr('embedder-mismatch');
  }
  const e = rule.corpus.embedder;
  if (cfg?.provider !== e.provider || cfg?.config?.model !== e.model || cfg?.config?.embeddingDims !== e.dims) {
    throw codeErr('embedder-mismatch');
  }
}

function guardLlm(llm) {
  const wrap = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch {
      throw codeErr('llm-failed');
    }
  };
  return { generate: wrap((a) => llm.generate(a)), judge: wrap((a) => llm.judge(a)) };
}

/** The production LLM clients, pinned by the rule (official SDKs, keys from env). */
function realLlm(rule, env) {
  const gen = rule.models.generator;
  const jud = rule.models.judge;
  let openai;
  let anthropic;
  return {
    async generate({ prompt }) {
      if (!openai) {
        const { default: OpenAI } = await import('openai');
        openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      }
      const body = { model: gen.model, max_tokens: gen.max_tokens, messages: [{ role: 'user', content: prompt }] };
      if (gen.temperature !== null) body.temperature = gen.temperature;
      const res = await openai.chat.completions.create(body);
      return res.choices?.[0]?.message?.content ?? '';
    },
    async judge({ prompt }) {
      if (!anthropic) {
        const { default: Anthropic } = await import('@anthropic-ai/sdk');
        anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      }
      const body = {
        model: jud.model, max_tokens: jud.max_tokens, messages: [{ role: 'user', content: prompt }],
        thinking: { type: jud.thinking }, output_config: { effort: jud.effort },
      };
      if (jud.temperature !== null) body.temperature = jud.temperature;
      const res = await anthropic.messages.create(body);
      if (res.stop_reason === 'refusal') return '';
      return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}

/**
 * The scratch clone on a local qdrant and the production read construction
 * (D5). MEM0_USER_ID is pinned from the rule before mem0-mcp-http.mjs loads.
 */
async function openQdrantIndex(points, rule, { env }) {
  const dims = rule.corpus.embedder.dims;
  if (!points.every((p) => Array.isArray(p.vector) && p.vector.length === dims)) throw codeErr('corpus-malformed');
  const host = env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(env.EVAL_QDRANT_PORT ?? '6533', 10);
  let version;
  try {
    version = (await (await fetch(`http://${host}:${port}/`)).json())?.version;
  } catch {
    throw codeErr('index-open-failed');
  }
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  // The version is checked against the rule below; skip the client's own warning.
  const client = new QdrantClient({ host, port, checkCompatibility: false });
  const collection = `eval_et203_${process.pid}_${Date.now()}`;
  if (!/^eval_et203_/.test(collection) || collection === (env.QDRANT_COLLECTION ?? 'memories')) throw codeErr('index-open-failed');
  try {
    // Sweep stale scratch collections (a finally does not survive SIGKILL).
    for (const c of (await client.getCollections()).collections) {
      if (/^eval_et203_/.test(c.name)) await client.deleteCollection(c.name).catch(() => {});
    }
    await client.createCollection(collection, { vectors: { size: dims, distance: 'Cosine' } });
    for (let i = 0; i < points.length; i += 128) {
      await client.upsert(collection, {
        wait: true, points: points.slice(i, i + 128).map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
      });
    }
    const count = (await client.count(collection, { exact: true })).count;
    process.env.MEM0_USER_ID = rule.corpus.pinned_user_id;
    const { Memory } = await import('mem0ai/oss');
    const { getEmbedderConfig } = await import('../lib/embed.mjs');
    const { getFactsLlmConfig } = await import('../lib/facts.mjs');
    const { wrapMem0Read } = await import('../lib/mem0-read.mjs');
    const { doSearch } = await import('../mem0-mcp-http.mjs');
    const memory = wrapMem0Read(new Memory({
      embedder: getEmbedderConfig(env),
      llm: getFactsLlmConfig(env),
      vectorStore: { provider: 'qdrant', config: { host, port, collectionName: collection } },
    }));
    return { doSearch, memory, count, qdrantVersion: version, close: () => client.deleteCollection(collection).catch(() => {}) };
  } catch (e) {
    await client.deleteCollection(collection).catch(() => {});
    throw codeErr(e?.code203 ?? 'index-open-failed');
  }
}

function resolveDeps(deps) {
  const repoDir = deps.repoDir ?? REPO_DIR;
  return {
    repoDir,
    env: deps.env ?? process.env,
    out: deps.out ?? ((l) => process.stdout.write(`${l}\n`)),
    llm: deps.llm ?? null,
    openIndex: deps.openIndex ?? openQdrantIndex,
    resultsDir: deps.resultsDir ?? join(repoDir, 'server', 'eval', 'results'),
    now: deps.now ?? (() => new Date()),
    faults: deps.faults ?? {},
    embedderConfig: deps.embedderConfig ?? null,
  };
}

/**
 * Run one subcommand. Returns the process exit code; never throws.
 * @param {string[]} argv  e.g. ['score', '--arc-dir', '/abs/path']
 * @param {object} [deps]  test seams: repoDir, env, out, llm, openIndex, resultsDir, now, faults, embedderConfig
 */
export async function run(argv, deps = {}) {
  const d = resolveDeps(deps);
  const args = parseArgs(argv);
  if (!args) {
    d.out(JSON.stringify({ status: 'refused', code: 'usage' }));
    return 2;
  }
  try {
    if (args.sub === 'build') return await cmdBuild(args, d);
    if (args.sub === 'calibrate') return await cmdCalibrate(args, d);
    if (args.sub === 'freeze-check') return await cmdFreezeCheck(args, d);
    return await cmdScore(args, d);
  } catch (e) {
    const line = { subcommand: args.sub, status: 'refused', code: codeOf(e) };
    if (line.code === 'rule-invalid' && typeof e.key === 'string') line.key = e.key;
    d.out(JSON.stringify(line));
    return 1;
  }
}

// ── build ────────────────────────────────────────────────────────────────────

async function cmdBuild(args, d) {
  const { entries } = arcPaths(args.arcDir, d.repoDir);
  const { rule, sha256 } = loadTrackedRule(d);
  const points = readCorpus(entries.corpus);
  const cc = checkCorpus(points, rule);
  if (!cc.ok) throw codeErr(cc.code);
  const prior = existsSync(args.arcDir) ? readdirSync(args.arcDir).filter((f) => /^query-set\.build-\d+\.jsonl$/.test(f)).length : 0;
  const hasCurrent = existsSync(entries['query-set']);
  const buildNumber = prior + (hasCurrent ? 2 : 1);
  const llm = guardLlm(d.llm ?? realLlm(rule, d.env));
  const { header, rows } = await runBuild({
    points, rule, ruleSha256: sha256, corpusSha256: corpusManifestHash(points), llm, now: d.now,
    buildNumber, pointsWithoutCreatedAt: cc.pointsWithoutCreatedAt,
  });
  const summary = buildSummary(header, rows, rule);
  assertAllowlisted(summary, buildSummarySchema(rule));
  // A rebuild keeps the earlier query set beside the new one (D7's rebuild rule
  // is the operator's; the code only reports the criteria).
  if (hasCurrent) renameSync(entries['query-set'], join(args.arcDir, `query-set.build-${prior + 1}.jsonl`));
  writeFileSync(entries['query-set'], [header, ...rows].map((x) => JSON.stringify(x)).join('\n') + '\n', { flag: 'wx' });
  d.out(JSON.stringify(summary));
  return 0;
}

// ── freeze-check ─────────────────────────────────────────────────────────────

async function cmdFreezeCheck(args, d) {
  const { entries } = arcPaths(args.arcDir, d.repoDir);
  let ruleLoads = true;
  try {
    loadTrackedRule(d);
  } catch {
    ruleLoads = false;
  }
  const v = await verifyAnchor(entries, { repoDir: d.repoDir, env: d.env, provenance: false });
  const line = (check, pass) => d.out(JSON.stringify({ subcommand: 'freeze-check', check, status: pass ? 'PASS' : 'FAIL' }));
  line('rule-loader', ruleLoads);
  for (const l of ANCHOR_LABELS) line(l, v.lines[l] === true);
  line('query-set-binding', v.anchorBlob !== null && !v.reasons.some((r) => r.startsWith('query-set-') && r.endsWith('-binding')));
  line('clean', v.anchorBlob !== null && !v.reasons.includes('server-tree-dirty'));
  if (!v.ok) {
    d.out(JSON.stringify({ subcommand: 'freeze-check', status: 'refused', code: v.reason }));
    return 1;
  }
  return ruleLoads ? 0 : 1;
}

// ── calibrate ────────────────────────────────────────────────────────────────

/** Run 0's queries: non-primary rows only; refuses outright if any row is primary. */
export function calibrationQueries(rows) {
  if (rows.some((r) => r.role === 'primary')) return { ok: false, code: 'calibrate-primary-row' };
  const queries = [];
  for (const r of rows) {
    queries.push({ text: r.identifier });
    if (typeof r.gloss === 'string' && r.gloss) queries.push({ text: r.gloss });
  }
  return { ok: true, queries };
}

async function cmdCalibrate(args, d) {
  const { entries } = arcPaths(args.arcDir, d.repoDir);
  const { rule, sha256 } = loadTrackedRule(d);
  await checkReadPathEnv(rule, d);
  const points = readCorpus(entries.corpus);
  const cc = checkCorpus(points, rule);
  if (!cc.ok) throw codeErr(cc.code);
  const { header, rows } = readQuerySet(entries['query-set']);
  const cq = calibrationQueries(rows.filter((r) => r.role !== 'primary'));
  if (!cq.ok) throw codeErr(cq.code);
  const checks = { 'query-set-binding': header.rule_sha256 === sha256 && header.corpus_manifest_sha256 === corpusManifestHash(points) };
  let idx;
  try {
    idx = await d.openIndex(points, rule, { env: d.env });
  } catch (e) {
    throw codeErr(e?.code203 ?? 'index-open-failed');
  }
  try {
    checks['clone-integrity'] = idx.count === points.length;
    checks['qdrant-version'] = idx.qdrantVersion === rule.read_path.qdrant_version;
    let probe;
    try {
      probe = await verbatimProbe(idx.doSearch, idx.memory, points, rule.probe.per_stratum_n, rule.probe.rank1_floor);
    } catch {
      throw codeErr('search-failed');
    }
    checks['verbatim-probe'] = probe.ok;
    const universe = new Set(points.map(projectedId));
    const k = rule.read_path.k;
    let idOk = true;
    const pass = async () => {
      const tops = [];
      for (const q of cq.queries) {
        let res;
        try {
          res = await idx.doSearch(q.text, rule.read_path.fetch_depth, false, true, { memory: idx.memory });
        } catch {
          throw codeErr('search-failed');
        }
        const ranked = dedupe((res?.results ?? []).map((x) => String(x.id)));
        try {
          assertIdSpace(ranked, universe, 'calibrate', '');
        } catch {
          idOk = false;
        }
        tops.push(ranked.slice(0, k).sort().join('\u0000'));
      }
      return tops;
    };
    const p1 = await pass();
    const p2 = await pass();
    checks['id-space'] = idOk;
    const same = p1.filter((t, i) => t === p2[i]).length;
    checks.determinism = cq.queries.length > 0 && same / cq.queries.length >= rule.calibration.determinism_floor;
  } finally {
    await idx.close?.();
  }
  for (const [check, ok] of Object.entries(checks)) {
    d.out(JSON.stringify({ subcommand: 'calibrate', check, status: ok ? 'PASS' : 'FAIL' }));
  }
  return Object.values(checks).every(Boolean) ? 0 : 1;
}

// ── score ────────────────────────────────────────────────────────────────────

const ID_SPACE = Symbol('id-space');

function armStats(outcomes, rule, label) {
  const n = outcomes.length;
  const ex = outcomes.map((o) => o.exact);
  const wo = outcomes.map((o) => o.words);
  const d = outcomes.map((o) => o.words.r5 - o.exact.r5);
  const ci = bootstrapCI(d, { resamples: rule.verdict.bootstrap_resamples, level: rule.verdict.ci_level, seedHex: rule.seeds.bootstrap, label });
  const b = outcomes.filter((o) => o.words.r5 === 1 && o.exact.r5 === 0).length;
  const c = outcomes.filter((o) => o.exact.r5 === 1 && o.words.r5 === 0).length;
  return {
    n,
    recall5: { exact: mean(ex.map((x) => x.r5)), words: mean(wo.map((x) => x.r5)) },
    recall1: { exact: mean(ex.map((x) => x.r1)), words: mean(wo.map((x) => x.r1)) },
    mrr: { exact: mean(ex.map((x) => x.rr)), words: mean(wo.map((x) => x.rr)) },
    delta: mean(d),
    ci: { lower: ci.lower, upper: ci.upper, level: rule.verdict.ci_level },
    mcnemar: { b, c, p: mcnemarExactP(b, c) },
  };
}

function cellsBy(scored, outcomes, keyOf) {
  const cells = {};
  scored.forEach((r, i) => {
    const key = keyOf(r);
    if (key === null) return;
    (cells[key] ??= []).push(outcomes[i]);
  });
  return Object.fromEntries(Object.entries(cells).map(([key, os]) => {
    const e = mean(os.map((o) => o.exact.r5));
    const w = mean(os.map((o) => o.words.r5));
    return [key, { n: os.length, recall5_exact: e, recall5_words: w, delta: w - e }];
  }));
}

async function cmdScore(args, d) {
  const { entries, rows: rowsPath } = arcPaths(args.arcDir, d.repoDir);
  // verifyAnchor (with merge provenance) runs before anything else is read.
  const va = await verifyAnchor(entries, { repoDir: d.repoDir, env: d.env, provenance: true });
  if (!va.ok) throw codeErr(va.reason);
  const { rule } = loadTrackedRule(d);
  await checkReadPathEnv(rule, d);
  const startedAt = d.now();
  const resultPath = join(d.resultsDir, `${startedAt.toISOString().slice(0, 10)}-exact-token-203.json`);
  if (existsSync(resultPath) || existsSync(rowsPath)) throw codeErr('result-exists');

  const cen = await runCensus({ transcriptsDir: entries.transcripts, countersPath: entries.counters, rule });
  if (!cen.ok) throw codeErr(cen.code);
  const census = cen.census;
  const points = readCorpus(entries.corpus);
  const cc = checkCorpus(points, rule);
  if (!cc.ok) throw codeErr(cc.code);
  const { header, rows } = readQuerySet(entries['query-set']);

  const k = rule.read_path.k;
  const primary = rows.filter((r) => r.role === 'primary');
  const scored = primary.filter((r) => !r.exclusion);
  const facts = rows.filter((r) => r.role === 'fact-control' && !r.exclusion);
  const E = primary.length;
  const plants = plantSummary(rows, header, rule);
  const exclusion = {
    eligible: E, excluded: E - scored.length, fraction: E ? (E - scored.length) / E : 1,
    by_channel: Object.fromEntries(rule.codes.exclusion_channels.map((ch) => [ch, primary.filter((r) => r.exclusion === ch).length])),
  };

  let idx;
  try {
    idx = await d.openIndex(points, rule, { env: d.env });
  } catch (e) {
    throw codeErr(e?.code203 ?? 'index-open-failed');
  }
  try {
    if (idx.count !== points.length) throw codeErr('clone-integrity');
    if (idx.qdrantVersion !== rule.read_path.qdrant_version) throw codeErr('qdrant-version-mismatch');
    const qdrantVersion = idx.qdrantVersion;

    // ── pre-verdict: everything the verdict reads ──
    let probe;
    try {
      probe = await verbatimProbe(idx.doSearch, idx.memory, points, rule.probe.per_stratum_n, rule.probe.rank1_floor);
    } catch {
      throw codeErr('search-failed');
    }
    const universe = new Set(points.map(projectedId));
    let idSpaceOk = true;
    const search = async (q) => {
      let res;
      try {
        res = await idx.doSearch(q, rule.read_path.fetch_depth, false, true, { memory: idx.memory });
      } catch {
        throw codeErr('search-failed');
      }
      const ranked = dedupe((res?.results ?? []).map((x) => String(x.id)));
      try {
        assertIdSpace(ranked, universe, 'score', '');
      } catch {
        idSpaceOk = false;
        throw ID_SPACE;
      }
      return ranked;
    };
    const outcome = (ranked, relevant) => ({ r5: recallAt(ranked, relevant, k), r1: recallAt(ranked, relevant, 1), rr: reciprocalRank(ranked, relevant) });

    const partners = derange(scored.map((r) => r.relevant), rule.seeds.derangement, rule.controls.derangement_max_attempts);
    const pass1 = [];
    const pass2 = [];
    const factOut = [];
    const c1 = [];
    const c2 = [];
    try {
      for (const r of scored) pass1.push({ exact: await search(r.identifier), words: await search(r.gloss) });
      for (const r of facts) factOut.push({ exact: outcome(await search(r.identifier), r.relevant), words: outcome(await search(r.gloss), r.relevant) });
      for (const r of scored) c1.push(recallAt(await search(scramble(r.identifier, rule.seeds.scramble)), r.relevant, k));
      if (partners) for (const [i, r] of scored.entries()) c2.push(recallAt(await search(scored[partners[i]].gloss), r.relevant, k));
      for (const r of scored) pass2.push({ exact: await search(r.identifier), words: await search(r.gloss) });
    } catch (e) {
      if (e !== ID_SPACE) throw e;
    }

    let verdictInput;
    let stats = null;
    if (idSpaceOk) {
      const out1 = scored.map((r, i) => ({ exact: outcome(pass1[i].exact, r.relevant), words: outcome(pass1[i].words, r.relevant) }));
      stats = { primary: armStats(out1, rule, 'primary'), fact: armStats(factOut, rule, 'fact-control'), out1 };
      const B = rule.verdict.bootstrap_resamples;
      const ciOpts = (label) => ({ resamples: B, level: rule.verdict.ci_level, seedHex: rule.seeds.bootstrap, label });
      const c1ci = bootstrapCI(out1.map((o, i) => o.exact.r5 - c1[i]), ciOpts('c1'));
      const c2ci = partners ? bootstrapCI(out1.map((o, i) => o.words.r5 - c2[i]), ciOpts('c2')) : { lower: null, upper: null };
      const held = heldOutDeltas(scored.map((r, i) => ({ ...r, ranked: pass1[i] })), k);
      const heldLb = bootstrapLowerBound(held.deltas, { resamples: B, level: rule.c3.one_sided_level, seedHex: rule.seeds.bootstrap, label: 'c3' });
      const disagree = (arm) => (scored.length
        ? scored.filter((r, i) => recallAt(pass2[i][arm], r.relevant, k) !== out1[i][arm].r5).length / scored.length : 0);
      stats.controls = {
        c1: { lower: c1ci.lower, upper: c1ci.upper, pass: c1ci.lower !== null && c1ci.lower > 0 },
        c2: { lower: c2ci.lower, upper: c2ci.upper, pass: c2ci.lower !== null && c2ci.lower > 0 },
        c3: { eligible: held.eligible, delta_held: mean(held.deltas), lower_one_sided: heldLb },
      };
      stats.passDisagreement = { exact: disagree('exact'), words: disagree('words') };
      stats.thinning = classThinning(rows, rule);
      verdictInput = {
        guards: { probeOk: probe.ok, idSpaceOk, plantCodes: plants.codes, exclusionFraction: exclusion.fraction, passDisagreement: stats.passDisagreement },
        delta: stats.primary.delta ?? 0,
        ci: { lower: stats.primary.ci.lower ?? 0, upper: stats.primary.ci.upper ?? 0 },
        recall5: { exact: stats.primary.recall5.exact ?? 0, words: stats.primary.recall5.words ?? 0 },
        thinning: stats.thinning,
        controls: { c1: stats.controls.c1, c2: stats.controls.c2, c3: { eligible: held.eligible, lowerBound: heldLb } },
      };
    } else {
      verdictInput = { guards: { probeOk: probe.ok, idSpaceOk, plantCodes: plants.codes, exclusionFraction: exclusion.fraction, passDisagreement: null } };
    }
    if (scored.length === 0) verdictInput.guards.exclusionFraction = 1;

    // ── the verdict function ──
    const decided = decideVerdict(verdictInput, rule);

    // ── post-verdict: a throw from here on is VOID post-verdict-error ──
    const common = {
      schema: RESULT_SCHEMA_ID,
      freeze: { head_commit: va.headCommit, anchor_blob: va.anchorBlob },
      hashes: {
        rule: va.hashes.rule, query_set: va.hashes['query-set'], corpus: va.hashes.corpus,
        transcripts: va.hashes.transcripts, counters: va.hashes.counters, server_tree: va.hashes['server-tree'],
      },
      models: { generator: rule.models.generator.model, judge: rule.models.judge.model, embedder: rule.corpus.embedder.model },
      qdrant_version: qdrantVersion,
      census,
      guards: {
        probe: { fact: probe.per.fact, doc: probe.per.doc, floor: probe.floor, ok: probe.ok },
        id_space_ok: idSpaceOk,
        plants: { leaky: plants.leaky, near_miss: plants.near_miss, split: plants.split },
        exclusion,
        pass_disagreement: stats?.passDisagreement ?? null,
      },
    };
    const voidRecord = (reasons) => ({
      ...common, verdict: 'VOID', void_reasons: reasons, d10_branch: d10Branch('VOID', census),
      timestamps: { started_at: startedAt.toISOString(), finished_at: d.now().toISOString() },
    });
    const schema = resultSchema(rule);
    try {
      d.faults.afterVerdict?.();
      let result;
      let rowsText = null;
      if (decided.verdict === 'VOID') {
        result = voidRecord(decided.voidReasons);
      } else {
        const summary = buildSummary(header, rows, rule);
        result = {
          ...common,
          verdict: decided.verdict, void_reasons: [], d10_branch: d10Branch(decided.verdict, census),
          downgrades: decided.downgrades,
          timestamps: { started_at: startedAt.toISOString(), finished_at: d.now().toISOString() },
          primary: stats.primary, fact_control: stats.fact,
          controls: {
            required: decided.requiredControls, c1: stats.controls.c1, c2: stats.controls.c2,
            c3: { ...stats.controls.c3, applied: decided.verdict === 'GAP' || decided.verdict === 'GAP (seed-carried)' },
          },
          per_class: cellsBy(scored, stats.out1, (r) => r.class),
          per_df_band: cellsBy(scored, stats.out1, (r) => {
            const band = rule.report.df_bands.find(([lo, hi]) => r.df >= lo && r.df <= hi);
            return band ? dfBandKey(band) : null;
          }),
          exclusions_by_class: summary.by_class,
          thinning: stats.thinning,
        };
        rowsText = scored.map((r, i) => JSON.stringify({
          identifier: r.identifier, class: r.class, df: r.df, exact: stats.out1[i].exact, words: stats.out1[i].words,
          c1: c1[i], c2: partners ? c2[i] : null,
          pass2: { exact: recallAt(pass2[i].exact, r.relevant, k), words: recallAt(pass2[i].words, r.relevant, k) },
        })).join('\n') + '\n';
      }
      assertAllowlisted(result, schema);
      if (rowsText !== null) writeFileSync(rowsPath, rowsText, { flag: 'wx' });
      writeAllowlisted(resultPath, result, schema);
      d.out(JSON.stringify(result));
      return 0;
    } catch {
      // Final for this arc (spec D7): the throw site could reveal the label.
      rmSync(rowsPath, { force: true });
      const rec = voidRecord(['post-verdict-error']);
      writeAllowlisted(resultPath, rec, schema, { overwrite: true });
      d.out(JSON.stringify(rec));
      return 0;
    }
  } finally {
    await idx.close?.();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/eval/exact-token-203.mjs')) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
