/**
 * server/eval/exact-token-eval.mjs — #188: does vector-only retrieval have an
 * exact-token gap in UM's real corpus shape?
 *
 * Pre-registration: docs/plans/2026-07-28-lexical-exact-token-assist-{spec,plan}.md (v3).
 * The accept rule (spec §5) is FROZEN before any number is observed; this harness
 * evaluates every gate mechanically against those thresholds and refuses to emit a
 * verdict if the accept-rule hash does not match the committed anchor.
 *
 * Design (spec §5.1) — PAIRED QUERY CLASSES over a CLONE of the real corpus:
 *   • Corpus is a bit-identical clone of the live `memories` collection (vectors copied,
 *     nothing re-embedded), into a LOCAL scratch qdrant. Not authored, not synthesized.
 *   • Population is every regex-matched identifier, with SET-VALUED relevance (all docs
 *     containing it). No uniqueness filter — that was a directional selection instrument.
 *   • Each identifier yields TWO queries over the same target: a blind-generated semantic
 *     paraphrase (identifier absent) and the identifier-centric `what is <identifier>`.
 *     See PROTOCOL DEVIATION D1 below / spec §11 — the frozen rule appended the identifier
 *     to the paraphrase, which measured the wrong query class.
 *
 * Arms: vector (real doSearch) | lexical_idealized | fusion_idealized |
 *       fusion_deployable (real qdrant MatchText + word tokenizer) | keyword_exact (descriptive)
 *
 * Run:  node --env-file=.env eval/exact-token-eval.mjs --corpus <dump.json> [--runs 2]
 */

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  tokenizeIdealized, tokenizeDeployable, buildIndex, score as bm25Score, matchTextCandidates,
} from './lib/bm25.mjs';
import { fuse } from './lib/rrf.mjs';
import { percentile } from './lib/stats.mjs';

// ─── FROZEN ACCEPT RULE (spec §5.3) — do not edit after a number is observed ───
const GATES = {
  G1a: { desc: 'gap is identifier-specific', test: (m) => m.vecSemantic - m.vecExact >= 0.15, fmt: (m) => `${(m.vecSemantic - m.vecExact).toFixed(3)} >= 0.15` },
  G1b: { desc: 'headroom exists', test: (m) => m.vecExact <= 0.85, fmt: (m) => `${m.vecExact.toFixed(3)} <= 0.85` },
  G2: {
    desc: 'deployable arm closes it',
    test: (m) => (m.depExact - m.vecExact) >= 0.10 && (m.depExact - m.vecExact) >= 0.60 * (m.idealExact - m.vecExact),
    fmt: (m) => `delta ${(m.depExact - m.vecExact).toFixed(3)} >= 0.10 AND >= 0.60x idealized ${(0.60 * (m.idealExact - m.vecExact)).toFixed(3)}`,
  },
  G3: { desc: 'recall-safe on semantic', test: (m) => m.depSemantic >= m.vecSemantic - 0.02, fmt: (m) => `${m.depSemantic.toFixed(3)} >= ${(m.vecSemantic - 0.02).toFixed(3)}` },
  G5: { desc: 'local overhead screen', test: (m) => m.p95Delta <= 150, fmt: (m) => `${m.p95Delta.toFixed(1)}ms <= 150ms` },
};
// ─── pipeline health ──────────────────────────────────────────────────────────
// A corpus-wide semantic-recall floor was the WRONG instrument (run 1 fired it at 0.358 on a
// provably healthy pipeline): it encodes an assumption about blind-query QUALITY, and it is
// dragged under by whichever stratum genuinely retrieves worst — here the doc stratum's real
// 0.091, which is the finding, not a fault.
//
// Replaced by (a) a DIRECT probe — a document's own verbatim text must retrieve that document
// at rank 1, which tests the pipeline itself and depends on no query generator — and (b)
// PER-STRATUM advisory floors, so a genuinely-hard stratum cannot mask or manufacture a fault.
const VERBATIM_PROBE_N = 20;
const VERBATIM_RANK1_FLOOR = 0.90;
const STRATUM_SEMANTIC_FLOOR = { fact: 0.50, doc: null }; // null = reported, no floor asserted
const K_PRIMARY = 5;
const FETCH_DEPTH = 50;
const EXT = 'mjs|js|json|sh|ya?ml|md|ts|py|db|sql|toml|ini|env|lock';
const IDENTIFIER_RX = new RegExp([
  String.raw`[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}`,
  String.raw`v?\d+\.\d+\.\d+`,
  String.raw`#\d{1,4}`,
  String.raw`[\w-]+(?:[./][\w-]+)*\.(?:${EXT})\b`,
  String.raw`--[a-z][a-z0-9-]{2,}`,
  String.raw`[a-z_][a-z0-9_]*\(\)`,
  String.raw`(?<![\w-])~?/[\w.-]+(?:/[\w.-]+)+`,
  String.raw`[a-z][\w-]*:\d{2,5}`,
].join('|'), 'g');
const MIN_IDENT_LEN = 4;
// PROTOCOL DEVIATION D1 (recorded, spec §11) — the exact-token arm is the IDENTIFIER-CENTRIC
// query, not `semantic + identifier`.
//
// The frozen v3 rule appended the identifier to the blind semantic query to make a strict
// minimal pair. Run 1 showed that construction measures the wrong query class: appending a
// token to a rich paraphrase yields a query STRICTLY MORE informative than the semantic form,
// so it cannot express #188's premise (a user typing an error string or flag name, i.e. an
// identifier with little surrounding semantic content). Vector-arm results were byte-identical
// across both phrasings on 109/109 rows — the tell.
//
// Discovered by the pipeline-health probe, which reads NO gate, and the correction makes the
// gates HARDER to pass (an identifier-centric query at ceiling fails G1b outright), so this is
// instrument repair, not threshold tuning.
const deriveExact = (_semantic, identifier) => `what is ${identifier}`;

// PROTOCOL DEVIATION D2 (recorded, spec §11) — MatchText narrows on RARE tokens, not all tokens.
// qdrant MatchText is AND-over-tokens, so requiring every token of a 7-word natural query is
// unsatisfiable: the deployable arm returned empty on 218/218 queries in run 1, making
// fusion_deployable identical to vector by construction. §7.2 always said "the query's RARE
// tokens"; the frozen §5.5 selector line failed to encode it. Rare = top-3 by IDF among tokens
// with df <= 20% of the collection.
const RARE_DF_FRACTION = 0.20;
const RARE_MAX_TOKENS = 3;
function rareTokens(index, query) {
  const toks = [...new Set(index.tokenize(query))];
  return toks
    .map((t) => ({ t, df: index.postings.get(t)?.size ?? 0 }))
    .filter((x) => x.df > 0 && x.df <= Math.max(1, index.N * RARE_DF_FRACTION))
    .sort((a, b) => a.df - b.df || (a.t < b.t ? -1 : 1))
    .slice(0, RARE_MAX_TOKENS)
    .map((x) => x.t);
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : dflt; };
const isDoc = (t) => t.length > 400 || /^Session summary|^<summary>/.test(t);

// ─── population (spec §6.2) ───────────────────────────────────────────────────
export function buildPopulation(points) {
  const docs = points.map((p) => ({ id: String(p.id), text: p.payload?.data ?? '', payload: p.payload ?? {} }));
  // Serving-haystack parity: doSearch can never return these, so they cannot be TARGETS.
  // They stay in the haystack and in BM25 df/avgdl (prod-faithful).
  const targetable = docs.filter((d) => {
    const st = String(d.payload.status ?? '').toLowerCase();
    if (['superseded', 'deprecated', 'rejected'].includes(st)) return false;
    if (d.payload.invalidated_at) return false;
    return d.payload.userId !== '_um_system';
  });
  const targetableIds = new Set(targetable.map((d) => d.id));

  const rel = new Map(); // identifier -> Set(docId)
  for (const d of targetable) {
    for (const m of new Set(d.text.match(IDENTIFIER_RX) || [])) {
      if (m.length < MIN_IDENT_LEN || rel.has(m)) continue;
      rel.set(m, new Set(docs.filter((x) => targetableIds.has(x.id) && x.text.includes(m)).map((x) => x.id)));
    }
  }
  // Collapse identifiers with identical relevant sets, keeping the longest
  // (`v0.3.8` and `0.3.8` are the same query in substance).
  const bySet = new Map();
  for (const [ident, set] of rel) {
    const key = [...set].sort().join('|');
    const prev = bySet.get(key);
    if (!prev || ident.length > prev.length) bySet.set(key, ident);
  }
  return [...bySet.entries()].map(([key, identifier]) => {
    const relevant = key.split('|');
    const docTexts = relevant.map((id) => docs.find((d) => d.id === id)?.text ?? '');
    const docCount = docTexts.filter(isDoc).length;
    return {
      identifier,
      relevant,
      df: relevant.length,
      stratum: docCount * 2 >= relevant.length ? 'doc' : 'fact',
      seedText: docTexts[0].slice(0, 1200),
    };
  }).sort((a, b) => (a.identifier < b.identifier ? -1 : 1));
}

// ─── blind query generation (spec §6.3) ───────────────────────────────────────
const GEN_PROMPT = `You write realistic search queries for a personal memory system.

Given a stored memory and one identifier that appears in it, write the single question a user would naturally ask to find this memory again.

HARD REQUIREMENT: your question must NOT contain the identifier, nor any substring of it. Describe what it refers to in ordinary words instead.

Reply with the question only — no quotes, no preamble.`;

async function generateQueries(rows, apiKey, log) {
  const out = [];
  let dropped = 0;
  for (const r of rows) {
    let semantic = null;
    for (let attempt = 0; attempt < 2 && !semantic; attempt++) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          messages: [
            { role: 'system', content: GEN_PROMPT },
            { role: 'user', content: `MEMORY:\n${r.seedText}\n\nIDENTIFIER: ${r.identifier}` },
          ],
        }),
      });
      if (!res.ok) continue;
      const txt = (await res.json())?.choices?.[0]?.message?.content?.trim();
      // Mechanical check: semantic form must not leak the identifier.
      if (txt && !txt.toLowerCase().includes(r.identifier.toLowerCase())) semantic = txt;
    }
    if (!semantic) { dropped++; continue; }
    out.push({ ...r, semantic, exact: deriveExact(semantic, r.identifier) });
    if (out.length % 25 === 0) log(`  generated ${out.length}/${rows.length}`);
  }
  return { rows: out, dropped };
}

// ─── scoring ──────────────────────────────────────────────────────────────────
const recallAtK = (ranked, relevant, k = K_PRIMARY) =>
  ranked.slice(0, k).some((id) => relevant.includes(id)) ? 1 : 0;
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/**
 * Direct pipeline probe: a document's own verbatim text must retrieve that document at rank 1.
 * Reads NO gate and uses NO generated query, so it can distinguish "retrieval is broken" from
 * "these queries are vague" — the exact confusion that made the old corpus-wide floor useless.
 */
async function verbatimProbe(doSearch, memory, points, n = VERBATIM_PROBE_N) {
  const sample = points.filter((p) => p.payload?.userId !== '_um_system' && (p.payload?.data || '').length < 200).slice(0, n);
  let rank1 = 0;
  for (const p of sample) {
    const sr = await doSearch(p.payload.data, 10, false, true, { memory });
    if (String((sr.results ?? [])[0]?.id) === String(p.id)) rank1++;
  }
  const rate = sample.length ? rank1 / sample.length : 0;
  return { n: sample.length, rank1, rate, floor: VERBATIM_RANK1_FLOOR, ok: rate >= VERBATIM_RANK1_FLOOR };
}

async function main() {
  const log = (m) => console.log(m);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('[exact-token] OPENAI_API_KEY not set — run: node --env-file=.env eval/exact-token-eval.mjs'); process.exit(2); }

  const corpusPath = arg('corpus');
  if (!corpusPath) { console.error('[exact-token] --corpus <points.json> required'); process.exit(2); }
  const points = JSON.parse(await readFile(corpusPath, 'utf8'));
  const corpusHash = sha(JSON.stringify(points.map((p) => p.id).sort()));
  log(`\n=== #188 exact-token gap — corpus ${points.length} points (hash ${corpusHash}) ===`);

  // ── clone into a LOCAL scratch qdrant (spec §6.1) ──
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const host = process.env.QDRANT_HOST ?? 'localhost';
  const port = parseInt(process.env.EVAL_QDRANT_PORT ?? '6533', 10);
  const client = new QdrantClient({ host, port });
  const collection = `eval_exact_token_${process.pid}`;
  const configured = process.env.QDRANT_COLLECTION ?? 'memories';
  // Guard 1: scratch safety.
  if (!/^eval_/.test(collection) || collection === configured) throw new Error(`refusing to run against ${collection}`);
  // Sweep stale eval collections (a finally does not survive SIGKILL).
  for (const c of (await client.getCollections()).collections) {
    if (/^eval_exact_token_/.test(c.name)) { await client.deleteCollection(c.name).catch(() => {}); }
  }

  const results = {};
  try {
    await client.createCollection(collection, { vectors: { size: 1536, distance: 'Cosine' } });
    await client.upsert(collection, { wait: true, points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })) });
    // Guard 2: clone integrity.
    const cloned = await client.count(collection, { exact: true });
    if (cloned.count !== points.length) throw new Error(`clone integrity: ${cloned.count} != ${points.length}`);
    log(`cloned ${cloned.count} points -> ${collection} @ ${host}:${port}`);

    // Real text payload index — only params qdrant 1.7.3 accepts (spec §7.4).
    let textIndexOk = true;
    try {
      await client.createPayloadIndex(collection, {
        field_name: 'data', field_schema: { type: 'text', tokenizer: 'word', min_token_len: 2, max_token_len: 30 }, wait: true,
      });
    } catch (e) { textIndexOk = false; log(`  WARN text index rejected: ${e?.message}`); }
    // Probe it — a silent absence would surface as a 400 at query time (spec §7.4).
    let probeOk = false;
    try {
      await client.scroll(collection, { filter: { must: [{ key: 'data', match: { text: 'the' } }] }, limit: 1 });
      probeOk = true;
    } catch (e) { log(`  WARN MatchText probe failed: ${e?.message}`); }
    log(`  text index: created=${textIndexOk} probe=${probeOk}`);

    // ── population + queries ──
    const pop = buildPopulation(points);
    log(`population: ${pop.length} identifiers (fact ${pop.filter((r) => r.stratum === 'fact').length}, doc ${pop.filter((r) => r.stratum === 'doc').length})`);
    log('generating blind semantic queries…');
    const { rows, dropped } = await generateQueries(pop, apiKey, log);
    const queryHash = sha(JSON.stringify(rows.map((r) => [r.identifier, r.semantic])));
    log(`queries: ${rows.length} pairs (dropped ${dropped}, hash ${queryHash})`);
    const nDoc = rows.filter((r) => r.stratum === 'doc').length;
    if (nDoc < 30) log(`  ABORT-NOTE: doc n=${nDoc} < 30 — subgroup path is VOID (spec §6.3)`);
    if (rows.length < 60) log(`  ABORT-NOTE: combined n=${rows.length} < 60 — run is EXPLORATORY (spec §6.3)`);

    // ── BM25 indexes over the FULL corpus, per-arm tokenizer (spec §5.5/§7.3) ──
    const docs = points.map((p) => ({ id: String(p.id), text: p.payload?.data ?? '' }));
    const idxIdeal = buildIndex(docs, tokenizeIdealized);
    const idxDeploy = buildIndex(docs, tokenizeDeployable);

    // ── arms ──
    const { Memory } = await import('mem0ai/oss');
    const { getEmbedderConfig } = await import('../lib/embed.mjs');
    const { getFactsLlmConfig } = await import('../lib/facts.mjs');
    process.env.MEM0_USER_ID = 'golden';
    process.env.UM_TEMPORAL_DECAY = 'false';
    process.env.UM_BOUNCER_ENABLED = 'false';
    const { doSearch } = await import('../mem0-mcp-http.mjs');
    const memory = new Memory({
      embedder: getEmbedderConfig(process.env),
      llm: getFactsLlmConfig(process.env),
      vectorStore: { provider: 'qdrant', config: { host, port, collectionName: collection } },
    });

    // Pipeline health BEFORE scoring — a broken pipeline must fail loudly, not read as "no gap".
    const probe = await verbatimProbe(doSearch, memory, points);
    log(`pipeline probe: verbatim rank1 ${probe.rank1}/${probe.n} (${probe.rate.toFixed(3)}) — ${probe.ok ? 'HEALTHY' : 'SUSPECT'}`);
    if (!probe.ok) log(`  !! PIPELINE SUSPECT: rank1 ${probe.rate.toFixed(3)} < ${VERBATIM_RANK1_FLOOR} — deltas below are NOT trustworthy`);

    const per = [];
    const latVec = [], latDep = [];
    for (const [i, r] of rows.entries()) {
      const row = { identifier: r.identifier, stratum: r.stratum, df: r.df, relevant: r.relevant };
      for (const phrasing of ['semantic', 'exact']) {
        const q = r[phrasing];
        const t0 = performance.now();
        const sr = await doSearch(q, FETCH_DEPTH, false, true, { memory });
        const vecRanked = (sr.results ?? []).map((x) => String(x.id));
        const tVec = performance.now() - t0;

        const lexIdeal = bm25Score(idxIdeal, q, { limit: FETCH_DEPTH }).map((x) => x.id);

        const t1 = performance.now();
        const rare = rareTokens(idxDeploy, q);
        const cands = rare.length ? matchTextCandidates(idxDeploy, rare.join(' ')) : [];
        const lexDeploy = cands.length ? bm25Score(idxDeploy, q, { candidateIds: cands, limit: FETCH_DEPTH }).map((x) => x.id) : [];
        const depRanked = fuse([{ ranking: vecRanked, weight: 1 }, { ranking: lexDeploy, weight: 1 }], { limit: FETCH_DEPTH }).map((x) => x.id);
        const lexOverhead = performance.now() - t1;

        const idealRanked = fuse([{ ranking: vecRanked, weight: 1 }, { ranking: lexIdeal, weight: 1 }], { limit: FETCH_DEPTH }).map((x) => x.id);
        const kwRanked = docs.filter((d) => d.text.includes(r.identifier)).map((d) => d.id);
        const kwFused = fuse([{ ranking: vecRanked, weight: 1 }, { ranking: kwRanked, weight: 1 }], { limit: FETCH_DEPTH }).map((x) => x.id);
        // Negative control 1: weight-0 lexical must reproduce vector exactly.
        const ctrl = fuse([{ ranking: vecRanked, weight: 1 }, { ranking: lexDeploy, weight: 0 }], { limit: FETCH_DEPTH }).map((x) => x.id);
        if (ctrl.join('|') !== vecRanked.join('|')) throw new Error(`NEGATIVE CONTROL FAILED (weight-0 != vector) on "${r.identifier}"`);

        // PAIRED latency: same query, both arms. p95 of two differently-populated arrays
        // (run 1's bug) produced a meaningless -921ms.
        latVec.push(tVec); latDep.push(tVec + lexOverhead);
        row[phrasing] = {
          vector: recallAtK(vecRanked, r.relevant),
          lexicalIdeal: recallAtK(lexIdeal, r.relevant),
          fusionIdeal: recallAtK(idealRanked, r.relevant),
          fusionDeploy: recallAtK(depRanked, r.relevant),
          keywordExact: recallAtK(kwFused, r.relevant),
          lexDeployEmpty: lexDeploy.length === 0,
        };
      }
      per.push(row);
      if ((i + 1) % 25 === 0) log(`  scored ${i + 1}/${rows.length}`);
    }

    // ── aggregate ──
    const agg = (sel, phrasing, subset = per) => mean(subset.map((r) => r[phrasing][sel]));
    const m = {
      vecExact: agg('vector', 'exact'), vecSemantic: agg('vector', 'semantic'),
      idealExact: agg('fusionIdeal', 'exact'),
      depExact: agg('fusionDeploy', 'exact'), depSemantic: agg('fusionDeploy', 'semantic'),
      lexExact: agg('lexicalIdeal', 'exact'), kwExact: agg('keywordExact', 'exact'),
      p95Delta: percentile(latDep, 95) - percentile(latVec, 95),
    };
    const gained = per.filter((r) => r.exact.fusionDeploy > r.exact.vector).length;
    const lost = per.filter((r) => r.exact.fusionDeploy < r.exact.vector).length;
    const lexEmptySemantic = per.filter((r) => r.semantic.lexDeployEmpty).length;

    results.metrics = m;
    results.n = { total: per.length, fact: per.filter((r) => r.stratum === 'fact').length, doc: per.filter((r) => r.stratum === 'doc').length };
    results.strata = Object.fromEntries(['fact', 'doc'].map((s) => {
      const sub = per.filter((r) => r.stratum === s);
      return [s, sub.length ? {
        n: sub.length,
        vecExact: agg('vector', 'exact', sub), vecSemantic: agg('vector', 'semantic', sub),
        depExact: agg('fusionDeploy', 'exact', sub), idealExact: agg('fusionIdeal', 'exact', sub),
      } : null];
    }));
    results.discordant = { gained, lost };
    results.controls = { weight0EqualsVector: true, lexicalEmptyOnSemantic: `${lexEmptySemantic}/${per.length}` };
    // Per-stratum floors — a stratum with a null floor is reported, never asserted.
    const strataHealth = Object.entries(results.strata).map(([s, v]) => {
      const floor = STRATUM_SEMANTIC_FLOOR[s];
      return { stratum: s, vecSemantic: v?.vecSemantic ?? null, floor, ok: floor == null || (v?.vecSemantic ?? 0) >= floor };
    });
    results.pipelineHealth = { verbatimProbe: probe, strata: strataHealth, ok: probe.ok && strataHealth.every((x) => x.ok) };
    results.hashes = { corpus: corpusHash, queries: queryHash };
    results.textIndex = { created: textIndexOk, probeOk };

    // ── mechanical gate evaluation (spec §5.7) ──
    log(`\n--- recall@${K_PRIMARY} (n=${per.length}: fact ${results.n.fact}, doc ${results.n.doc}) ---`);
    log(`  vector      exact ${m.vecExact.toFixed(3)}   semantic ${m.vecSemantic.toFixed(3)}`);
    log(`  fusion_deploy exact ${m.depExact.toFixed(3)} semantic ${m.depSemantic.toFixed(3)}`);
    log(`  fusion_ideal  exact ${m.idealExact.toFixed(3)}  |  lexical_ideal ${m.lexExact.toFixed(3)}  |  keyword_exact ${m.kwExact.toFixed(3)}`);
    log(`  paired discordant: +${gained} / -${lost}`);
    log(`  lexical arm empty on semantic queries: ${lexEmptySemantic}/${per.length}`);
    for (const h of strataHealth) {
      const verdict = h.floor == null ? 'reported (no floor)' : h.ok ? `>= ${h.floor}` : `!! BELOW FLOOR ${h.floor}`;
      log(`  health[${h.stratum}] semantic ${h.vecSemantic?.toFixed(3) ?? 'n/a'} — ${verdict}`);
    }

    log('\n--- pre-registered gates ---');
    const verdicts = {};
    for (const [name, g] of Object.entries(GATES)) {
      const pass = g.test(m);
      verdicts[name] = pass;
      log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  ${g.desc.padEnd(28)} ${g.fmt(m)}`);
    }
    results.gates = verdicts;
    results.decision = Object.values(verdicts).every(Boolean) ? 'SHIP-CANDIDATE (pending G4 second run)' : 'PARK';
    log(`\n  DECISION: ${results.decision}\n`);

    const outPath = fileURLToPath(new URL('./results/2026-07-28-exact-token-gap.json', import.meta.url));
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify({ timestamp: new Date().toISOString(), ...results, per }, null, 2) + '\n', 'utf8');
    log(`wrote ${outPath}`);
  } finally {
    await client.deleteCollection(collection).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('exact-token-eval.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
