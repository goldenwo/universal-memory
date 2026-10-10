// server/eval/lib/exact-token-203-build.mjs — #203 (spec D1–D4; plan T6, T7): the
// query-set build for server/eval/exact-token-203.mjs — population rows, gloss
// windows, the G-shape guard, J2's candidates and neighbours, the three judges
// and the planted cases. Every parameter is read from the loaded rule.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record):
//
// • POPULATION (D4): buildPopulation(points, { groups: true }) from the July
//   eval (projected ids, serving-haystack parity, set-valued relevance by
//   substring containment, majority stratum). Within a collapse group, members
//   that are substrings of another member are dropped, then the representative
//   is the member with the smallest sha256(salt + identifier) — July's
//   keep-longest rule had a direction. The seed doc is the relevant doc with
//   isDoc true and the smallest sha256(salt + projectedId), full text; with no
//   isDoc relevant doc (fact rows) the smallest-hash relevant doc. A row is
//   single-project when every point behind every relevant id carries the same
//   `project` (missing = the rule's `(none)` value). Roles: `primary` = doc
//   stratum, df ≤ max_df, single-project; `fact-control` = the fact stratum
//   under the same filter; everything else `nonprimary` (calibration only).
//
// • DUPLICATE DOCUMENT IDS (ruling, PR 2 review): several points can share one
//   payload.id. Every text is kept (point-id order); a row reads, per doc, the
//   first text that contains its identifier (docText), and the cross-document
//   exclusion checks every text of every relevant doc.
//
// • WINDOWS (G-src): the paragraph (blank-line separated) holding the
//   identifier's first occurrence in the seed doc, capped at window_chars
//   centred on it. A doc-stratum row ALWAYS gets the paragraph, however short
//   the seed; only a fact-stratum seed no longer than the cap is its own whole
//   window (ruling, PR 2 review). The generator and every judge see windows,
//   never a whole document.
//
// • J2 CANDIDATES: every IDENTIFIER_RX match (≥ MIN_IDENT_LEN) in the row's
//   window except matches nested with the target (one contains the other) —
//   the target plus the nearest max_in_window_candidates − 1 when there are
//   more — plus up to cross_doc_neighbours same-class population identifiers
//   that occur in none of the row's relevant docs, ranked by Jaccard overlap of
//   window content tokens (D9's tokenizer and stopwords), ties by salted hash.
//   Options are shown in a seeded shuffle, each with its own window, then NONE
//   and SEVERAL; anything but the target excludes the row.
//
// • PROMPT SAFETY: windows are untrusted LLM-written text. Every generator and
//   judge prompt fences each window between lines carrying a fresh random nonce
//   per call (never one that occurs in the fenced text) and says the content is
//   data. The judge never sees which call is a plant.
//
// • CHANNELS: generator-error (format), unglossable (UNKNOWN), g-shape (after
//   `retries` retries), j1, j2, j3 — each an exclusion, the first that fires.
//
// • PLANT VALIDATION (revision 1, spec §8.2 R1–R3): every plant attempt with a
//   phrase is checked by a validator from another model family (V1 leaky: only
//   YES confirms; V2 near-miss: only donor-only confirms, its A/B side set by
//   validatorOrder; V3 split: only NO confirms) AND judged; a reply outside the
//   validator's vocabulary confirms nothing and is recorded as OOV. Plants carry
//   their `attempts` (rank from 1; an UNKNOWN / format / G-shape-failed donor
//   gloss uses up an attempt with no phrase and is neither validated nor judged).
//   Near-miss tries up to plants.near_miss_donor_attempts donors of the row's
//   type in that type's order (in-window by distance, cross by Jaccard), each
//   with no nested twin; split tries up to plants.split_donor_attempts
//   same-class donors whose relevant docs all carry the row's project and whose
//   identifier occurs (substring, every text) in none of the row's docs, by
//   Jaccard; both stop at the first confirmed attempt. A row in a catch-all
//   project (plants.split_project_excluded) gets no split plant. Accuracy and
//   row floors count CONFIRMED attempts only; the near-miss structural rule and
//   split.structural are decided on availability before any LLM call.
//   plant-j3-too-few is never a rebuild trigger (split plants involve no
//   generation, so a rebuild reproduces it).

import { createHash, randomBytes } from 'node:crypto';
import { IDENTIFIER_RX, MIN_IDENT_LEN, STOPWORDS, classifyQueryShape } from '../../lib/query-shape.mjs';
import { buildPopulation, isDoc, projectedId } from '../exact-token-eval.mjs';
import { seededShuffle } from './exact-token-203-random.mjs';

/** One label per IDENTIFIER_RX alternative, in the regex's frozen order. */
export const IDENTIFIER_CLASSES = Object.freeze([
  'screaming-snake', 'semver', 'issue-ref', 'file', 'long-flag', 'fn-call', 'path', 'host-port',
]);
export const ROLES = Object.freeze(['primary', 'fact-control', 'nonprimary']);
export const QUERY_SET_SCHEMA = 'exact-token-203-query-set/2';
/** Codes no rebuild can move (spec §8.2 R3). */
export const NON_REBUILDABLE_CODES = Object.freeze(['plant-j3-too-few']);
/** Split-plant accuracy strata: the row's own real J3 answer was SAME, something else, or J3 never ran. */
export const J3_STRATA = Object.freeze(['same', 'not_same', 'not_judged']);

/** Attempts per plant kind: a leaky plant gets none extra (spec §8.2 R2); the others from the rule. */
export const attemptCaps = (rule) => ({
  leaky: 1, near_miss: rule.plants.near_miss_donor_attempts, split: rule.plants.split_donor_attempts,
});
export const rankKey = (rank) => `rank_${rank}`;

/** Split a regex source at its top-level `|` (outside groups and classes). */
export function topLevelAlternatives(source) {
  const out = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { cur += ch + (source[i + 1] ?? ''); i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; cur += ch; continue; }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const ALTERNATIVES = topLevelAlternatives(IDENTIFIER_RX.source);
if (ALTERNATIVES.length !== IDENTIFIER_CLASSES.length || ALTERNATIVES.join('|') !== IDENTIFIER_RX.source) {
  throw new Error('IDENTIFIER_RX alternatives do not match IDENTIFIER_CLASSES');
}
const WHOLE = ALTERNATIVES.map((a) => new RegExp(`^(?:${a})$`));

/** The class of an identifier: the first alternative that matches it whole. */
export function classOf(identifier) {
  const i = WHOLE.findIndex((rx) => rx.test(identifier));
  return i >= 0 ? IDENTIFIER_CLASSES[i] : null;
}

const STOP = new Set(STOPWORDS);
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const norm = (t) => t.toLowerCase().replace(EDGE, '');

/** D9's tokenizer: whitespace split, lowercased, edge punctuation stripped, stopwords and empties dropped. */
export function contentTokens(text) {
  const out = new Set();
  for (const t of String(text).split(/\s+/)) {
    const w = norm(t);
    if (w && !STOP.has(w)) out.add(w);
  }
  return out;
}

export function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

export const saltedHash = (salt, s) => createHash('sha256').update(`${salt}${s}`).digest('hex');
const byHash = (salt) => (a, b) => {
  const [x, y] = [saltedHash(salt, a), saltedHash(salt, b)];
  return x < y ? -1 : x > y ? 1 : 0;
};
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const isNested = (a, b) => a !== b && (a.includes(b) || b.includes(a));

/**
 * V2's A/B order (spec §8.2 R1): the donor is shown as A iff the first 32 bits of
 * sha256(validator_order + "\0" + row + "\0" + donor + "\0" + rank) are even
 * (rank from 1). A salt of its own, so the position is independent of the
 * donor-type parity that salts.donor_type sets.
 * @returns {'donor-a'|'donor-b'}
 */
export function validatorOrder(rule, rowIdentifier, donorIdentifier, rank) {
  const h = saltedHash(rule.salts.validator_order, `\0${rowIdentifier}\0${donorIdentifier}\0${rank}`);
  return parseInt(h.slice(0, 8), 16) % 2 === 0 ? 'donor-a' : 'donor-b';
}

/** Substring-then-hash representative of a collapse group (D4). */
export function chooseRepresentative(members, salt) {
  const kept = members.filter((m) => !members.some((o) => o !== m && o.includes(m)));
  return kept.slice().sort(byHash(salt))[0];
}

const projectOf = (payload, rule) => (typeof payload?.project === 'string' && payload.project !== ''
  ? payload.project : rule.population.missing_project_value);

/**
 * Projected id → { texts, projects }. Several corpus points can share one
 * document id (payload.id); EVERY text is kept, ordered by point id so the
 * order does not depend on the dump's (ruling, PR 2 review).
 */
export function indexCorpus(points, rule) {
  const byId = new Map();
  for (const p of points) {
    const id = projectedId(p);
    if (!byId.has(id)) byId.set(id, { entries: [], projects: new Set() });
    const e = byId.get(id);
    e.entries.push({ pointId: String(p.id), text: p.payload?.data ?? '' });
    e.projects.add(projectOf(p.payload, rule));
  }
  for (const e of byId.values()) {
    e.entries.sort((a, b) => cmp(a.pointId, b.pointId));
    e.texts = e.entries.map((x) => x.text);
  }
  return { byId, universe: new Set(byId.keys()) };
}

/**
 * The text of document `id` a row reads: the first of its texts (point-id
 * order) that contains the identifier — the one relevance matched — else its
 * first text (no identifier given, or none contains it).
 */
export function docText(index, id, identifier) {
  const e = index.byId.get(id);
  if (!e) return '';
  return (identifier !== undefined && e.texts.find((t) => t.includes(identifier))) || e.texts[0];
}

/**
 * The seed doc: the relevant doc whose text (docText) is isDoc, with the
 * smallest salted hash; with none, the smallest-hash relevant doc.
 */
export function chooseSeedDoc(relevant, index, salt, identifier) {
  const docs = relevant.filter((id) => isDoc(docText(index, id, identifier)));
  return (docs.length ? docs : relevant).slice().sort(byHash(salt))[0];
}

function paragraphBounds(text, pos) {
  const re = /\r?\n[ \t]*\r?\n/g;
  let start = 0;
  let end = text.length;
  let m;
  while ((m = re.exec(text))) {
    if (m.index + m[0].length <= pos) start = m.index + m[0].length;
    else if (m.index >= pos) { end = m.index; break; }
  }
  return [start, end];
}

/**
 * The window around an occurrence at `pos` (length `len`) in `text`: its
 * paragraph, capped at `cap` chars centred on the occurrence. With
 * `wholeIfShort` (fact-stratum rows only) a text no longer than the cap is
 * its own window; a doc-stratum row always gets the paragraph (ruling, PR 2
 * review).
 */
export function windowAt(text, pos, len, cap, { wholeIfShort = false } = {}) {
  if (wholeIfShort && text.length <= cap) return { text, start: 0, pos };
  const [ps, pe] = paragraphBounds(text, pos);
  let start = ps;
  let end = pe;
  if (pe - ps > cap) {
    start = Math.max(ps, Math.min(Math.round(pos + len / 2 - cap / 2), pe - cap));
    end = start + cap;
  }
  return { text: text.slice(start, end), start, pos: pos - start };
}

/**
 * The window around an identifier's first occurrence. Relevance guarantees an
 * occurrence in the text docText() picks; were there none, the window opens
 * at the text's start rather than throwing.
 */
export function firstWindow(text, identifier, cap, opts) {
  const pos = text.indexOf(identifier);
  return pos < 0 ? windowAt(text, 0, 0, cap, opts) : windowAt(text, pos, identifier.length, cap, opts);
}

/**
 * The G-shape guard (D2) — a 2–6-word gloss with no digit, no identifier of any
 * class (nor the target itself in any case), and at least two descriptive
 * content words (not stopwords, not the rule's generic words).
 * @returns {{ ok: true } | { ok: false, reason: 'word-count'|'digit'|'identifier'|'descriptive-words' }}
 */
export function gShape(phrase, identifier, rule) {
  const g = rule.gloss;
  const words = String(phrase).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length < g.min_words || words.length > g.max_words) return { ok: false, reason: 'word-count' };
  if (/\p{Nd}/u.test(phrase)) return { ok: false, reason: 'digit' };
  if (classifyQueryShape(phrase) !== 'none' || phrase.toLowerCase().includes(identifier.toLowerCase())) {
    return { ok: false, reason: 'identifier' };
  }
  const generic = new Set(g.generic_words);
  const descriptive = words.map(norm).filter((w) => w && !STOP.has(w) && !generic.has(w)).length;
  if (descriptive < g.min_descriptive_words) return { ok: false, reason: 'descriptive-words' };
  return { ok: true };
}

/**
 * Refuse a corpus that is not the pinned one (D4, D5): malformed points, a
 * non-system point under another user id (an unreachable target in both
 * arms), or a point created on or after the cutoff.
 */
export function checkCorpus(points, rule) {
  if (!Array.isArray(points) || !points.every((p) => p && typeof p === 'object' && p.id !== undefined
    && p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload))) {
    return { ok: false, code: 'corpus-malformed' };
  }
  const { pinned_user_id: pinned, system_user_id: system } = rule.corpus;
  if (points.some((p) => p.payload.userId !== system && p.payload.userId !== pinned)) return { ok: false, code: 'corpus-user-id-mismatch' };
  const cutoff = Date.parse(rule.population.corpus_cutoff);
  let undated = 0;
  for (const p of points) {
    const t = Date.parse(p.payload.createdAt);
    if (Number.isNaN(t)) undated++;
    else if (t >= cutoff) return { ok: false, code: 'corpus-cutoff-violated' };
  }
  return { ok: true, pointsWithoutCreatedAt: undated };
}

function inWindowCandidates(row, seedText, rule) {
  const w = row.window;
  const nearest = new Map();
  for (const m of w.text.matchAll(new RegExp(IDENTIFIER_RX.source, IDENTIFIER_RX.flags))) {
    const s = m[0];
    if (s.length < MIN_IDENT_LEN || s === row.identifier || isNested(s, row.identifier)) continue;
    const dist = Math.abs(m.index - w.pos);
    const prev = nearest.get(s);
    if (!prev || dist < prev.dist) nearest.set(s, { identifier: s, pos: m.index, dist });
  }
  return [...nearest.values()]
    .sort((a, b) => a.dist - b.dist || cmp(a.identifier, b.identifier))
    .slice(0, rule.gloss.max_in_window_candidates - 1)
    .map((c) => ({
      identifier: c.identifier, pos: c.pos,
      window: windowAt(seedText, w.start + c.pos, c.identifier.length, rule.gloss.window_chars, windowOpts(row)),
    }));
}

/** Whole-text windows for short seeds are a fact-stratum rule only (D4 ruling). */
const windowOpts = (row) => ({ wholeIfShort: row.stratum === 'fact' });

/**
 * Same-class population rows from other documents, by descending window
 * Jaccard (ties by salted hash), excluding any identifier that occurs in one
 * of this row's relevant docs — EVERY text of each doc, by substring, so a
 * nested twin (X ⊂ Y occurs in Y's docs; X ⊃ Y puts X's docs among Y's) never
 * qualifies. `accept` narrows the pool further.
 */
function rankedOthers(row, rows, index, rule, accept = () => true) {
  const relTexts = row.relevant.flatMap((id) => index.byId.get(id)?.texts ?? []);
  const salt = rule.salts.neighbour_tiebreak;
  return rows
    .filter((o) => o !== row && o.class === row.class && accept(o) && !relTexts.some((t) => t.includes(o.identifier)))
    .map((o) => ({ identifier: o.identifier, window: o.window, jaccard: jaccard(row.tokens, o.tokens) }))
    .sort((a, b) => b.jaccard - a.jaccard || byHash(salt)(a.identifier, b.identifier));
}

/** J2's cross-document neighbours: the top cross_doc_neighbours, any project. */
const crossDocNeighbours = (row, rows, index, rule) => rankedOthers(row, rows, index, rule).slice(0, rule.gloss.cross_doc_neighbours);

/**
 * Split-plant donors (spec §8.2 R1), every eligible one in order: the donor's
 * relevant docs all carry this row's project value (a multi-project row has no
 * single value, so it never qualifies). The build tries the first
 * plants.split_donor_attempts of them.
 */
const splitDonors = (row, rows, index, rule) => rankedOthers(row, rows, index, rule, (o) => o.project === row.project);

/**
 * Population rows with roles, windows, J2 candidates and near-miss donor plans.
 * Pure: no LLM, no I/O. Deterministic for a given corpus and rule.
 */
export function buildPopulationRows(points, rule) {
  const index = indexCorpus(points, rule);
  const cap = rule.gloss.window_chars;
  const rows = buildPopulation(points, { groups: true }).map((g) => {
    const identifier = chooseRepresentative(g.identifiers, rule.salts.representative);
    const projects = new Set();
    for (const id of g.relevant) for (const p of index.byId.get(id)?.projects ?? []) projects.add(p);
    const single = projects.size === 1;
    const seed = chooseSeedDoc(g.relevant, index, rule.salts.seed_doc, identifier);
    const window = firstWindow(docText(index, seed, identifier), identifier, cap, windowOpts(g));
    const eligibleDf = g.df <= rule.population.max_df;
    const role = eligibleDf && single ? (g.stratum === 'doc' ? 'primary' : 'fact-control') : 'nonprimary';
    return {
      identifier, class: classOf(identifier), relevant: g.relevant, df: g.df, stratum: g.stratum,
      single_project: single, project: single ? [...projects][0] : null, role, seed_id: seed, window,
      c3_eligible: g.relevant.some((id) => id !== seed && isDoc(docText(index, id, identifier))),
      tokens: contentTokens(window.text),
    };
  });
  for (const row of rows) {
    row.split_eligibility = null;
    row.split_donors = [];
    if (row.role === 'nonprimary') { row.in_window = []; row.cross = []; row.options = [row.identifier]; continue; }
    row.in_window = inWindowCandidates(row, docText(index, row.seed_id, row.identifier), rule);
    row.cross = crossDocNeighbours(row, rows, index, rule);
    row.options = seededShuffle([row.identifier, ...row.in_window.map((c) => c.identifier), ...row.cross.map((c) => c.identifier)],
      rule.salts.candidate_order, row.identifier);
  }
  const primary = rows.filter((r) => r.role === 'primary');
  assignDonors(primary, rule);
  // Split-plant availability (spec §8.2 R1, R3), decided here — before any LLM call.
  for (const row of primary) {
    if (row.df < 2) continue;
    if (rule.plants.split_project_excluded.includes(row.project)) { row.split_eligibility = 'catch-all'; continue; }
    row.split_donors = splitDonors(row, rows, index, rule);
    row.split_eligibility = row.split_donors.length ? 'donor' : 'no-donor';
  }
  return {
    rows, index, E: primary.length,
    donorStructural: rows.some((r) => r.donor_structural === true),
    splitStructural: primary.filter((r) => r.split_eligibility === 'donor').length < rule.plants.min_rows,
  };
}

/**
 * Near-miss donor plan per primary row (D3, revision 1 R2): a donor is a
 * candidate with no nested twin in the row's candidate set; the type is set by
 * seeded hash (cross-document / in-window), each falling back to the other only
 * when it has no donor at all; when the in-window type would hold fewer than
 * the per-type minimum, the shortfall is structural and every row takes the
 * cross type. Decided on availability, before any LLM call. `row.donor` is
 * { type, assigned, candidates }: the type's first near_miss_donor_attempts
 * donors in its own order (in-window by distance, cross by Jaccard).
 */
function assignDonors(primary, rule) {
  const cap = rule.plants.near_miss_donor_attempts;
  for (const row of primary) {
    const set = [row.identifier, ...row.in_window.map((c) => c.identifier), ...row.cross.map((c) => c.identifier)];
    const free = (c) => !set.some((o) => isNested(o, c.identifier));
    const lists = { 'in-window': row.in_window.filter(free).slice(0, cap), cross: row.cross.filter(free).slice(0, cap) };
    const assigned = parseInt(saltedHash(rule.salts.donor_type, row.identifier).slice(0, 8), 16) % 2 === 0 ? 'cross' : 'in-window';
    row._donors = { lists, assigned };
  }
  const pick = (d, first) => {
    const type = [first, first === 'cross' ? 'in-window' : 'cross'].find((t) => d.lists[t].length);
    return type ? { type, candidates: d.lists[type].map((c) => ({ identifier: c.identifier, window: c.window })) } : null;
  };
  let inWindowCount = 0;
  for (const row of primary) {
    row.donor = pick(row._donors, row._donors.assigned);
    if (row.donor?.type === 'in-window') inWindowCount++;
  }
  const structural = inWindowCount < rule.plants.min_rows_per_donor_type;
  for (const row of primary) {
    if (structural) row.donor = pick(row._donors, 'cross');
    if (row.donor) row.donor.assigned = row._donors.assigned;
    row.donor_structural = structural;
    delete row._donors;
  }
}

// ── prompts ──────────────────────────────────────────────────────────────────

/** Single-pass `{{NAME}}` substitution: inserted values are never re-scanned. */
export function renderPrompt(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
}

function newNonce(texts) {
  for (;;) {
    const n = randomBytes(8).toString('hex');
    if (!texts.some((t) => t.includes(n))) return n;
  }
}

const fence = (text, nonce, prompts) =>
  `${renderPrompt(prompts.fence_open, { NONCE: nonce })}\n${text}\n${renderPrompt(prompts.fence_close, { NONCE: nonce })}`;

export function parseGeneration(text) {
  let t = String(text ?? '').trim();
  if (!t || /[\r\n]/.test(t)) return { kind: 'format' };
  t = t.replace(/^["'`“‘]+|["'`”’]+$/g, '').replace(/\.$/, '').trim();
  if (!t) return { kind: 'format' };
  if (/^unknown$/i.test(t)) return { kind: 'unknown' };
  return { kind: 'phrase', phrase: t };
}

function parseToken(text) {
  const first = String(text ?? '').trim().split(/\r?\n/)[0] ?? '';
  return first.replace(/^[\s"'`[(*]+|[\s"'`\]).,:;!*]+$/g, '').toUpperCase();
}

async function generatePhrase({ kind, identifier, window, llm, rule, retries, meta = {} }) {
  const P = rule.prompts;
  let reason = null;
  for (let attempt = 0; ; attempt++) {
    const nonce = newNonce([window.text]);
    const base = renderPrompt(kind === 'leaky' ? P.leaky_plant : P.generator, {
      NONCE: nonce, WINDOW: fence(window.text, nonce, P), IDENTIFIER: identifier,
    });
    const prompt = attempt === 0 ? base : renderPrompt(P.generator_retry, { PROMPT: base, REASON: P.generator_retry_reasons[reason] });
    const out = parseGeneration(await llm.generate({ kind, prompt, meta: { ...meta, identifier, attempt } }));
    if (out.kind === 'format') return { status: 'format', attempts: attempt + 1 };
    if (out.kind === 'unknown') return { status: 'unknown', attempts: attempt + 1 };
    const g = gShape(out.phrase, identifier, rule);
    if (g.ok) return { status: 'ok', phrase: out.phrase, attempts: attempt + 1 };
    if (attempt >= retries) return { status: 'g-shape', attempts: attempt + 1 };
    reason = g.reason;
  }
}

async function judgeJ1({ identifier, window, phrase, plant }, { llm, rule }) {
  const P = rule.prompts;
  const nonce = newNonce([window.text]);
  const prompt = renderPrompt(P.j1, { NONCE: nonce, WINDOW: fence(window.text, nonce, P), IDENTIFIER: identifier, PHRASE: phrase });
  const a = parseToken(await llm.judge({ kind: 'j1', prompt, meta: { identifier, phrase, windows: [window.text], plant } }));
  return a === 'YES' || a === 'NO' ? a : 'INVALID';
}

function candidateWindows(row) {
  const m = new Map([[row.identifier, row.window]]);
  for (const c of row.in_window) m.set(c.identifier, c.window);
  for (const c of row.cross) m.set(c.identifier, c.window);
  return m;
}

async function judgeJ2(row, phrase, plant, { llm, rule }) {
  const P = rule.prompts;
  const wins = candidateWindows(row);
  const nonce = newNonce([...wins.values()].map((w) => w.text));
  const blocks = row.options.map((ident, i) => renderPrompt(P.j2_candidate, {
    NUMBER: String(i + 1), IDENTIFIER: ident, WINDOW: fence(wins.get(ident).text, nonce, P),
  }));
  const prompt = renderPrompt(P.j2, { NONCE: nonce, CANDIDATES: blocks.join('\n\n'), PHRASE: phrase });
  const a = parseToken(await llm.judge({
    kind: 'j2', prompt, meta: { identifier: row.identifier, phrase, options: [...row.options], windows: row.options.map((o) => wins.get(o).text), plant },
  }));
  if (a === 'NONE' || a === 'SEVERAL') return a;
  // "3" or "Candidate 3" name one option; anything else ("Candidate 2 and 3",
  // prose, a cut-off reply) is not a single answer.
  const m = /^(?:CANDIDATE\s+)?(\d+)$/.exec(a);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= row.options.length) return row.options[n - 1];
  }
  return 'INVALID';
}

/** J3's windows: seed doc first, then the other relevant docs by salted hash. */
function j3Windows(row, index, rule) {
  const others = row.relevant.filter((id) => id !== row.seed_id).sort(byHash(rule.salts.seed_doc));
  return [row.seed_id, ...others].map((id) => ({
    id, text: firstWindow(docText(index, id, row.identifier), row.identifier, rule.gloss.window_chars, windowOpts(row)).text,
  }));
}

async function judgeJ3(row, windows, plant, { llm, rule }) {
  const P = rule.prompts;
  const nonce = newNonce(windows);
  const passages = windows.map((w, i) => renderPrompt(P.j3_passage, { NUMBER: String(i + 1), WINDOW: fence(w, nonce, P) }));
  const prompt = renderPrompt(P.j3, { NONCE: nonce, IDENTIFIER: row.identifier, PASSAGES: passages.join('\n\n') });
  const a = parseToken(await llm.judge({
    kind: 'j3', prompt, meta: { identifier: row.identifier, windows: [...windows], plant, split: plant === 'split' },
  }));
  return ['SAME', 'DIFFERENT', 'UNSURE'].includes(a) ? a : 'INVALID';
}

// ── the plant validator (revision 1, spec §8.2 R1) ──────────────────────────
// Replies are parsed like judge tokens; anything outside a validator's
// vocabulary is recorded as OOV and confirms nothing. One fresh nonce per call,
// checked against every window the prompt inserts.

const validatorReply = (text, vocabulary) => {
  const a = parseToken(text);
  return vocabulary.includes(a) ? a : 'OOV';
};

/** V1: does the leaky phrase report a one-time happening? Only YES confirms. */
async function validateLeaky(row, phrase, { llm, rule }) {
  const P = rule.prompts;
  const nonce = newNonce([row.window.text]);
  const prompt = renderPrompt(P.validator_leaky, {
    NONCE: nonce, WINDOW: fence(row.window.text, nonce, P), IDENTIFIER: row.identifier, PHRASE: phrase,
  });
  const a = validatorReply(await llm.validate({ kind: 'v1', prompt, meta: { identifier: row.identifier, phrase, windows: [row.window.text] } }), ['YES', 'NO']);
  return { validator: a, confirmed: a === 'YES' };
}

/**
 * V2: does the donor gloss name the donor (A or B), the target, both or neither?
 * Only donor-only confirms; the answer is mapped back to DONOR / TARGET.
 */
async function validateNearMiss(row, donor, donorType, phrase, rank, { llm, rule }) {
  const P = rule.prompts;
  const order = validatorOrder(rule, row.identifier, donor.identifier, rank);
  const target = { identifier: row.identifier, window: row.window };
  const [a, b] = order === 'donor-a' ? [donor, target] : [target, donor];
  const nonce = newNonce([a.window.text, b.window.text]);
  const prompt = renderPrompt(P.validator_near_miss, {
    NONCE: nonce, IDENTIFIER_A: a.identifier, WINDOW_A: fence(a.window.text, nonce, P),
    IDENTIFIER_B: b.identifier, WINDOW_B: fence(b.window.text, nonce, P), PHRASE: phrase,
  });
  const reply = validatorReply(await llm.validate({
    kind: 'v2', prompt,
    meta: { identifier: row.identifier, donor: donor.identifier, donor_type: donorType, rank, phrase, a: a.identifier, b: b.identifier, windows: [a.window.text, b.window.text] },
  }), ['A', 'B', 'BOTH', 'NEITHER']);
  const side = { A: order === 'donor-a' ? 'DONOR' : 'TARGET', B: order === 'donor-a' ? 'TARGET' : 'DONOR' };
  const validator = side[reply] ?? reply;
  return { order, validator, confirmed: validator === 'DONOR' };
}

/** V3: could the seed window and the relabelled passage use the identifier for one thing? Only NO confirms. */
async function validateSplit(row, donor, relabelled, rank, { llm, rule }) {
  const P = rule.prompts;
  const windows = [row.window.text, relabelled];
  const nonce = newNonce(windows);
  const prompt = renderPrompt(P.validator_split, {
    NONCE: nonce, IDENTIFIER: row.identifier, WINDOW_A: fence(windows[0], nonce, P), WINDOW_B: fence(windows[1], nonce, P),
  });
  const a = validatorReply(await llm.validate({ kind: 'v3', prompt, meta: { identifier: row.identifier, donor: donor.identifier, rank, windows } }), ['YES', 'NO']);
  return { validator: a, confirmed: a === 'NO' };
}

/** An attempt that produced no phrase (UNKNOWN / format / G-shape): neither validated nor judged. */
const noPhraseAttempt = (rank, status, extra = {}) => ({
  rank, ...extra, status, phrase: null, validator: null, confirmed: false, answer: null, correct: null,
});

/** J1's planted case: one generation (the G-shape retry aside), V1, then J1. */
async function leakyPlant(row, ctx) {
  const { rule } = ctx;
  const g = await generatePhrase({ kind: 'leaky', identifier: row.identifier, window: row.window, llm: ctx.llm, rule, retries: rule.plants.retries });
  if (g.status !== 'ok') return { attempts: [noPhraseAttempt(1, g.status)] };
  const v = await validateLeaky(row, g.phrase, ctx);
  const answer = await judgeJ1({ identifier: row.identifier, window: row.window, phrase: g.phrase, plant: 'leaky' }, ctx);
  return { attempts: [{ rank: 1, status: 'ok', phrase: g.phrase, ...v, answer, correct: answer === 'NO' }] };
}

/** J2's planted case: the row's donors in order, each glossed, validated and judged, until one is confirmed. */
async function nearMissPlant(row, ctx) {
  const { rule } = ctx;
  const c = row.options.length;
  const attempts = [];
  for (const [i, donor] of row.donor.candidates.entries()) {
    const rank = i + 1;
    const g = await generatePhrase({
      kind: 'gloss', identifier: donor.identifier, window: donor.window, llm: ctx.llm, rule, retries: rule.plants.retries,
      meta: { plant: 'near-miss', row: row.identifier },
    });
    if (g.status !== 'ok') { attempts.push(noPhraseAttempt(rank, g.status, { donor: donor.identifier })); continue; }
    const v = await validateNearMiss(row, donor, row.donor.type, g.phrase, rank, ctx);
    const answer = await judgeJ2(row, g.phrase, 'near-miss', ctx);
    attempts.push({ rank, donor: donor.identifier, status: 'ok', phrase: g.phrase, ...v, answer, correct: answer === donor.identifier });
    if (v.confirmed) break;
  }
  return { assigned_type: row.donor.assigned, donor_type: row.donor.type, c, chance: 1 / (c + 2), attempts };
}

/**
 * J3's planted case: one NON-seed window (the smallest salted hash) is replaced
 * by a same-project donor's window with the donor's identifier swapped for this
 * row's string; V3 and J3 see the relabelled passage; donors in order until one
 * is confirmed.
 */
async function splitPlant(row, ctx) {
  const { rule, index } = ctx;
  const wins = j3Windows(row, index, rule);
  let swapAt = 1;
  for (let i = 2; i < wins.length; i++) {
    if (byHash(rule.salts.split_referent)(wins[i].id, wins[swapAt].id) < 0) swapAt = i;
  }
  const attempts = [];
  for (const [i, donor] of row.split_donors.slice(0, rule.plants.split_donor_attempts).entries()) {
    const rank = i + 1;
    const relabelled = donor.window.text.split(donor.identifier).join(row.identifier);
    const v = await validateSplit(row, donor, relabelled, rank, ctx);
    const texts = wins.map((w) => w.text);
    texts[swapAt] = relabelled;
    const answer = await judgeJ3(row, texts, 'split', ctx);
    attempts.push({ rank, donor: donor.identifier, status: 'ok', ...v, answer, correct: answer === 'DIFFERENT' });
    if (v.confirmed) break;
  }
  return { attempts };
}

async function processRow(row, ctx) {
  const { rule, index } = ctx;
  const judged = row.role === 'primary' || row.role === 'fact-control';
  const rec = {
    gloss: null, gloss_attempts: 0, gen_format_failure: false, exclusion: null,
    j1: null, j2: null, j3: null, plants: null,
  };
  const g = await generatePhrase({ kind: 'gloss', identifier: row.identifier, window: row.window, llm: ctx.llm, rule, retries: rule.gloss.retries });
  rec.gloss_attempts = g.attempts;
  if (g.status === 'format') { rec.exclusion = 'generator-error'; rec.gen_format_failure = true; }
  else if (g.status === 'unknown') rec.exclusion = 'unglossable';
  else if (g.status === 'g-shape') rec.exclusion = 'g-shape';
  else rec.gloss = g.phrase;

  if (judged && !rec.exclusion) {
    rec.j1 = await judgeJ1({ identifier: row.identifier, window: row.window, phrase: rec.gloss, plant: null }, ctx);
    if (rec.j1 !== 'YES') rec.exclusion = 'j1';
  }
  if (judged && !rec.exclusion) {
    const answer = await judgeJ2(row, rec.gloss, null, ctx);
    rec.j2 = answer;
    if (answer !== row.identifier) rec.exclusion = 'j2';
  }
  if (judged && !rec.exclusion && row.df >= 2) {
    rec.j3 = await judgeJ3(row, j3Windows(row, index, rule).map((w) => w.text), null, ctx);
    if (rec.j3 !== 'SAME') rec.exclusion = 'j3';
  }

  if (row.role === 'primary') {
    rec.plants = {
      leaky: await leakyPlant(row, ctx),
      near_miss: row.donor ? await nearMissPlant(row, ctx) : null,
      split: row.split_eligibility === 'donor' ? await splitPlant(row, ctx) : null,
    };
  }
  return rec;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The query-set row as written (arc dir only: it carries corpus strings). */
function serialiseRow(row, rec) {
  return {
    kind: 'row', identifier: row.identifier, class: row.class, df: row.df, stratum: row.stratum, role: row.role,
    single_project: row.single_project, project: row.project, relevant: row.relevant, seed_id: row.seed_id,
    window: { text: row.window.text, pos: row.window.pos }, c3_eligible: row.c3_eligible,
    options: row.options, n_in_window: row.in_window.length, k_cross: row.cross.length,
    donor_type: row.donor?.type ?? null, split_eligibility: row.split_eligibility, ...rec,
  };
}

/** The attempt a plant counts by: its first confirmed one (attempts stop there), or null. */
export const countedAttempt = (plant) => plant?.attempts?.find((a) => a.confirmed) ?? null;

const accuracyOf = (attempts) => {
  const correct = attempts.filter((a) => a.correct).length;
  return { rows: attempts.length, correct, accuracy: attempts.length ? correct / attempts.length : null };
};

/**
 * One plant kind: accuracy and row count over COUNTED (confirmed) plants, plus
 * every attempt's counts — attempted, no phrase, confirmed / not confirmed among
 * the judged ones (OOV inside not-confirmed, also counted apart), the 2×2 of
 * confirmed × judge correct over every judged attempt, and the per-rank
 * histogram with accuracy on the plants counted at that rank.
 */
function kindSummary(plants, cap) {
  const attempts = plants.flatMap((p) => p.attempts);
  const judged = attempts.filter((a) => a.status === 'ok');
  const byRank = {};
  const bucket = (rank) => (byRank[rankKey(rank)] ??= { attempted: 0, judged: 0, confirmed: 0, correct: 0, accuracy: null });
  for (let r = 1; r <= cap; r++) bucket(r);
  for (const a of attempts) {
    const b = bucket(a.rank);
    b.attempted++;
    if (a.status === 'ok') b.judged++;
    if (a.confirmed) { b.confirmed++; if (a.correct) b.correct++; }
  }
  for (const b of Object.values(byRank)) b.accuracy = b.confirmed ? b.correct / b.confirmed : null;
  const n = (pred) => judged.filter(pred).length;
  return {
    ...accuracyOf(plants.map(countedAttempt).filter(Boolean)),
    attempted: attempts.length,
    no_phrase: attempts.length - judged.length,
    confirmed: n((a) => a.confirmed),
    not_confirmed: n((a) => !a.confirmed),
    oov: n((a) => a.validator === 'OOV'),
    two_by_two: {
      confirmed_correct: n((a) => a.confirmed && a.correct),
      confirmed_miss: n((a) => a.confirmed && !a.correct),
      unconfirmed_correct: n((a) => !a.confirmed && a.correct),
      unconfirmed_miss: n((a) => !a.confirmed && !a.correct),
    },
    by_rank: byRank,
  };
}

/**
 * Plant accuracy (D3, revision 1 R3) over the primary rows, and the codes it
 * triggers: fewer than min_rows COUNTED plants of a kind, or accuracy below the
 * floor, overall and (near-miss) within each donor type — only the cross type
 * under a structural in-window shortfall, which is decided on availability
 * (header.donor_structural, from assignDonors) and never by validation.
 * split.structural (also availability) is reported; a split shortfall of either
 * cause is plant-j3-too-few, listed in non_rebuildable_codes.
 */
export function plantSummary(rows, header, rule) {
  const prim = rows.filter((r) => r.role === 'primary');
  const caps = attemptCaps(rule);
  const plantsOf = (kind) => prim.map((r) => r.plants?.[kind]).filter(Boolean);
  const nm = plantsOf('near_miss');
  const countedOfType = (t) => nm.filter((p) => p.donor_type === t).map(countedAttempt).filter(Boolean);
  const splitCounted = (pred) => accuracyOf(prim.filter((r) => r.plants?.split && pred(r)).map((r) => countedAttempt(r.plants.split)).filter(Boolean));
  const out = {
    leaky: kindSummary(plantsOf('leaky'), caps.leaky),
    near_miss: {
      ...kindSummary(nm, caps.near_miss),
      structural: header.donor_structural === true,
      by_type: { 'in-window': accuracyOf(countedOfType('in-window')), cross: accuracyOf(countedOfType('cross')) },
    },
    split: {
      ...kindSummary(plantsOf('split'), caps.split),
      structural: header.split_structural === true,
      rows_with_donor: prim.filter((r) => r.split_eligibility === 'donor').length,
      catch_all_excluded: prim.filter((r) => r.split_eligibility === 'catch-all').length,
      no_donor: prim.filter((r) => r.split_eligibility === 'no-donor').length,
      // Descriptive (limit 13): a row whose own windows J3 judged non-SAME likely draws DIFFERENT regardless.
      by_row_j3: {
        same: splitCounted((r) => r.j3 === 'SAME'),
        not_same: splitCounted((r) => r.j3 != null && r.j3 !== 'SAME'),
        not_judged: splitCounted((r) => r.j3 == null),
      },
    },
  };
  const { accuracy_floor: floor, min_rows: minRows, min_rows_per_donor_type: minType } = rule.plants;
  const codes = [];
  for (const [j, s] of [['j1', out.leaky], ['j2', out.near_miss], ['j3', out.split]]) {
    if (s.rows < minRows) codes.push(`plant-${j}-too-few`);
    else if (s.accuracy < floor) codes.push(`plant-${j}-accuracy`);
  }
  for (const t of out.near_miss.structural ? ['cross'] : ['in-window', 'cross']) {
    const b = out.near_miss.by_type[t];
    if (b.rows < minType) codes.push('plant-j2-donor-type-too-few');
    else if (b.accuracy < floor) codes.push('plant-j2-donor-type-accuracy');
  }
  out.codes = [...new Set(codes)];
  out.non_rebuildable_codes = out.codes.filter((c) => NON_REBUILDABLE_CODES.includes(c));
  return out;
}

/**
 * The plants block as published: build's summary and score's guards.plants
 * both go through this one projection (spec §8.3), so they cannot drift.
 */
export const plantsProjection = (ps) => ({ leaky: ps.leaky, near_miss: ps.near_miss, split: ps.split });

/**
 * Run the build: population rows, glosses, guards, judges and plants.
 * @returns {Promise<{ header: object, rows: object[] }>}
 */
export async function runBuild({ points, rule, ruleSha256, corpusSha256, llm, now, buildNumber, pointsWithoutCreatedAt }) {
  // Both structural flags are fixed here, on availability, before any LLM call.
  const { rows, index, E, donorStructural, splitStructural } = buildPopulationRows(points, rule);
  const ctx = { rule, index, llm };
  const recs = await pool(rows, rule.build.llm_concurrency, (row) => processRow(row, ctx));
  const out = rows.map((row, i) => serialiseRow(row, recs[i]));
  const header = {
    kind: 'header', schema: QUERY_SET_SCHEMA, rule_sha256: ruleSha256, corpus_manifest_sha256: corpusSha256,
    build_number: buildNumber, built_at: now().toISOString(), E, donor_structural: donorStructural,
    split_structural: splitStructural, points: points.length, points_without_created_at: pointsWithoutCreatedAt,
  };
  return { header, rows: out };
}

/** Counts-only summary of a build (printed; every key and label from fixed vocabularies). */
export function buildSummary(header, rows, rule) {
  const prim = rows.filter((r) => r.role === 'primary');
  const byClass = {};
  const ensure = (c) => (byClass[c] ??= {
    doc_rows_df_le_max: 0, multi_project: 0, eligible: 0, kept: 0,
    by_channel: Object.fromEntries(rule.codes.exclusion_channels.map((ch) => [ch, 0])),
    j3_checked: 0, j3_same: 0, in_window_candidates: 0, cross_neighbours: 0,
    leaky_confirmed: 0, near_miss_confirmed: 0, split_confirmed: 0,
    split_with_donor: 0, split_catch_all: 0, split_no_donor: 0,
  });
  const splitKey = { donor: 'split_with_donor', 'catch-all': 'split_catch_all', 'no-donor': 'split_no_donor' };
  for (const r of rows) {
    if (r.stratum === 'doc' && r.df <= rule.population.max_df) {
      const b = ensure(r.class);
      b.doc_rows_df_le_max++;
      if (!r.single_project) b.multi_project++;
    }
  }
  for (const r of prim) {
    const b = ensure(r.class);
    b.eligible++;
    if (r.exclusion) b.by_channel[r.exclusion]++;
    else b.kept++;
    if (r.j3 !== null) { b.j3_checked++; if (r.j3 === 'SAME') b.j3_same++; }
    b.in_window_candidates += r.n_in_window;
    b.cross_neighbours += r.k_cross;
    for (const kind of ['leaky', 'near_miss', 'split']) if (countedAttempt(r.plants?.[kind])) b[`${kind}_confirmed`]++;
    if (splitKey[r.split_eligibility]) b[splitKey[r.split_eligibility]]++;
  }
  const byChannel = Object.fromEntries(rule.codes.exclusion_channels.map((ch) => [ch, prim.filter((r) => r.exclusion === ch).length]));
  const formatFailures = rows.filter((r) => r.gen_format_failure).length;
  const plants = plantSummary(rows, header, rule);
  const formatFraction = rows.length ? formatFailures / rows.length : 0;
  const checks = {
    plants: plants.codes.length ? 'FAIL' : 'PASS',
    format_failures: formatFraction > rule.build.max_format_failure_fraction ? 'FAIL' : 'PASS',
  };
  const voidCodes = [...plants.codes, ...(checks.format_failures === 'FAIL' ? ['format-failures-over-cap'] : [])];
  const excluded = prim.filter((r) => r.exclusion).length;
  return {
    subcommand: 'build', status: 'ok', build_number: header.build_number, E: header.E,
    rows: {
      total: rows.length, primary: prim.length,
      fact_control: rows.filter((r) => r.role === 'fact-control').length,
      nonprimary: rows.filter((r) => r.role === 'nonprimary').length,
      c3_eligible: prim.filter((r) => r.c3_eligible).length,
      // Exclusions above the cap VOID the run, so at most floor(cap × E) rows can go.
      smallest_non_void_n: header.E - Math.floor(rule.verdict.exclusion_cap * header.E),
    },
    exclusions: { excluded, fraction: prim.length ? excluded / prim.length : 0, by_channel: byChannel },
    by_class: byClass,
    plants: plantsProjection(plants),
    format_failures: { rows: formatFailures, fraction: formatFraction },
    checks,
    void_codes: voidCodes,
    // Codes a rebuild cannot move (D7's rebuild rule is the operator's; the code only reports).
    non_rebuildable_codes: plants.non_rebuildable_codes,
  };
}
