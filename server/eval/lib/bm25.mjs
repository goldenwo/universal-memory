// server/eval/lib/bm25.mjs — pure BM25 scorer for the #188 exact-token gap eval.
//
// Two frozen tokenizers (spec §5.5) because the whole point of the measurement is that
// they DISAGREE on identifier shapes:
//   • idealized  — preserves identifiers atomically (`1.12.0` stays `1.12.0`)
//   • deployable — qdrant 1.7.3 `word` semantics (`1.12.0` → `1`, `12`; `0` dropped)
//
// Frozen params: k1=1.2, b=0.75, Lucene/Robertson-smoothed IDF (never negative).
//
// CRITICAL (spec §7.3): df and avgdl are computed over the FULL collection, never over a
// MatchText-narrowed candidate set. Over a narrowed set every candidate contains the token
// by definition, so df≈N and IDF collapses toward zero — destroying the discriminating
// signal exactly where this eval needs it. `buildIndex` takes the whole corpus for that
// reason; `score` then ranks an arbitrary candidate subset against those global stats.
//
// No live calls — importing this stays fully offline.

export const K1 = 1.2;
export const B = 0.75;

/** Identifier-preserving tokenizer (spec §5.5 "idealized"). */
export function tokenizeIdealized(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w~/#@.-]+|[^\w~/#@.-]+$/g, '')) // strip edge punctuation only
    .map((t) => t.replace(/\(\)$/, '')) // find_orphans() → find_orphans
    .filter(Boolean);
}

/** qdrant 1.7.3 `word` tokenizer semantics (spec §5.5 "deployable"). */
export function tokenizeDeployable(text, { minTokenLen = 2, maxTokenLen = 30 } = {}) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= minTokenLen && t.length <= maxTokenLen);
}

/**
 * Collection-level statistics. `docs` MUST be the full corpus (see §7.3).
 * @param {{id: string, text: string}[]} docs
 * @param {(text: string) => string[]} tokenize
 */
export function buildIndex(docs, tokenize) {
  const postings = new Map(); // term -> Map(docId -> tf)
  const lengths = new Map();  // docId -> token count
  for (const d of docs ?? []) {
    const toks = tokenize(d.text);
    lengths.set(d.id, toks.length);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [term, n] of tf) {
      if (!postings.has(term)) postings.set(term, new Map());
      postings.get(term).set(d.id, n);
    }
  }
  const N = lengths.size;
  let total = 0;
  for (const len of lengths.values()) total += len;
  return { postings, lengths, N, avgdl: N ? total / N : 0, tokenize };
}

/** Lucene/Robertson-smoothed IDF — never negative, unlike the unsmoothed variant. */
export function idf(index, term) {
  const df = index.postings.get(term)?.size ?? 0;
  return Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
}

/**
 * Rank documents for `query` against the index's GLOBAL stats.
 * `candidateIds` optionally restricts WHICH docs are returned (the MatchText narrow) —
 * it never changes df/avgdl, which stay collection-level.
 *
 * @returns {{id: string, score: number}[]} descending by score, ties broken by id for determinism
 */
export function score(index, query, { candidateIds = null, limit = Infinity } = {}) {
  const qTerms = [...new Set(index.tokenize(query))];
  const allow = candidateIds ? new Set(candidateIds) : null;
  const acc = new Map();
  for (const term of qTerms) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    const termIdf = idf(index, term);
    for (const [docId, tf] of posting) {
      if (allow && !allow.has(docId)) continue;
      const dl = index.lengths.get(docId) ?? 0;
      const denom = tf + K1 * (1 - B + B * (dl / (index.avgdl || 1)));
      acc.set(docId, (acc.get(docId) || 0) + termIdf * ((tf * (K1 + 1)) / (denom || 1)));
    }
  }
  return [...acc]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit === Infinity ? undefined : limit);
}

/**
 * qdrant `MatchText` AND-over-tokens semantics: a doc matches only if it contains EVERY
 * query token. Returns the candidate id set the deployable arm narrows to.
 */
export function matchTextCandidates(index, query) {
  const qTerms = [...new Set(index.tokenize(query))];
  if (!qTerms.length) return [];
  let acc = null;
  for (const term of qTerms) {
    const ids = new Set(index.postings.get(term)?.keys() ?? []);
    acc = acc === null ? ids : new Set([...acc].filter((id) => ids.has(id)));
    if (!acc.size) return [];
  }
  return [...acc];
}
