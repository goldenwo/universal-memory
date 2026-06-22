// server/eval/build-answer-grader-set.mjs — (re)generate the Layer-1 reliability fixture.
//
// Recipe (spec §3 — this script IS the documented regrow recipe):
//   • Positives (gold:true)  = each recall row's (query, target-seed text). The recall-set
//     already labels target_ref, so these are trustworthy without hand-checking.
//   • Hard negatives (gold:false, category 'hard-topical') = each UNANSWERABLE no-answer
//     query paired with its most topically-similar recall memory (same lane preferred,
//     deLeak-clean). Guaranteed a non-answer because the query is unanswerable (the answer
//     is absent from the corpus) — zero accidental-answer risk (spec §7 R5). Maximizing
//     token overlap makes them the HARD cases a lazy judge rubber-stamps (spec §4a T1).
//
// Deterministic + reproducible. Run: node server/eval/build-answer-grader-set.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFixtureJsonl } from './memory-quality-eval.mjs';
import { deLeak } from './de-leak.mjs';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));

// Content-token overlap (stopwords removed) so topical proximity isn't measured by "the"/"is".
const STOP = new Set(['the','a','an','is','are','was','were','do','does','did','of','in','on','at','to','for','and','or','my','i','it','this','that','what','which','who','when','where','how','why','me','we','our','you','your','with','be','been','have','has','had','will','would','can','could','about','from','not','no']);
function contentTokens(s) { return new Set((String(s ?? '').toLowerCase().match(/\w+/g) ?? []).filter((t) => !STOP.has(t))); }
function overlap(a, b) { const A = contentTokens(a), B = contentTokens(b); let n = 0; for (const t of A) if (B.has(t)) n++; return n; }

/** PURE: build the triples from the two source fixtures. */
export function buildTriples(recallRows, noAnswerRows) {
  const seeds = [];
  for (const row of recallRows) {
    for (let i = 0; i < row.seed_facts.length; i++) {
      seeds.push({ ref: `${row.id}:${i}`, text: row.seed_facts[i].text, lane: row.seed_facts[i].lane });
    }
  }
  const byRef = new Map(seeds.map((s) => [s.ref, s]));

  const positives = recallRows.map((row) => ({
    id: `pos-${row.id}`, query: row.query, memory: byRef.get(row.target_ref).text, gold: true, category: 'answerable',
  }));

  const hardNegatives = noAnswerRows.map((row) => {
    const clean = seeds.filter((s) => deLeak(row.query, [s.text]).clean); // never a phrasing-leak pairing
    const sameLane = clean.filter((s) => s.lane === row.lane);            // SAME domain = genuinely topical
    const pool = sameLane.length ? sameLane : clean;
    const ranked = pool.map((s) => ({ s, score: overlap(row.query, s.text) })).sort((a, b) => b.score - a.score);
    const pick = (ranked[0] ?? { s: pool[0] }).s;
    return { id: `neg-${row.id}`, query: row.query, memory: pick.text, gold: false, category: 'hard-topical' };
  });

  return [...positives, ...hardNegatives];
}

async function main() {
  const recallRows = await loadFixtureJsonl(join(EVAL_DIR, 'recall-set.jsonl'));
  const noAnswerRows = await loadFixtureJsonl(join(EVAL_DIR, 'no-answer-set.jsonl'));
  const triples = buildTriples(recallRows, noAnswerRows);
  const out = triples.map((t) => JSON.stringify(t)).join('\n') + '\n';
  await writeFile(join(EVAL_DIR, 'answer-grader-set.jsonl'), out, 'utf8');
  const pos = triples.filter((t) => t.gold === true).length;
  const hard = triples.filter((t) => t.category === 'hard-topical').length;
  console.log(`[build-answer-grader-set] wrote ${triples.length} triples (pos=${pos}, hard-neg=${hard})`);
  if (hard < 10) { console.error('FAIL: hard-negative quota <10 (spec §4a T1)'); process.exit(1); }
}

const IS_MAIN = process.argv[1] === fileURLToPath(import.meta.url);
if (IS_MAIN) main().catch((e) => { console.error(e); process.exit(1); });
