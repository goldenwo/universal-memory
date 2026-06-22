// server/eval/de-leak.mjs — anti-leak n-gram guard for eval fixtures.
//
// Harvested verbatim from the parked fix/no-answer-precision branch
// (memory-quality-eval.mjs:160 there — reference-only, NOT merged). Used when curating
// the answer-grader / no-answer fixtures so a "distractor" is rejected because it answers
// for SEMANTIC reasons, not because it shares phrasing with a gold seed (which would
// inflate measured separability).

/**
 * Reject a query that shares any ≥n-gram (default trigram) token shingle with any
 * corpus seed text.
 *
 * @param {string} query
 * @param {string[]} corpusTexts - the gold seed texts
 * @param {number} [n=3]
 * @returns {{clean: boolean, shared: string[]}} clean=true when safe to use
 */
export function deLeak(query, corpusTexts, n = 3) {
  const grams = (s) => {
    const toks = String(s ?? '').toLowerCase().match(/\w+/g) ?? [];
    const out = [];
    for (let i = 0; i + n <= toks.length; i++) out.push(toks.slice(i, i + n).join(' '));
    return out;
  };
  const corpus = new Set((corpusTexts ?? []).flatMap(grams));
  const shared = [...new Set(grams(query).filter((g) => corpus.has(g)))];
  return { clean: shared.length === 0, shared };
}
