// server/lib/query-shape.mjs — #203 (spec D9): classify a recall query by how
// much of it is an identifier, for the `recall.query_shape` counter and the
// #203 census, and own the frozen IDENTIFIER_RX they share with the eval.
//
// LOAD-BEARING INVARIANTS (the design docs are gitignored — this header is the
// durable record):
//
// • ONE DEFINITION: IDENTIFIER_RX, EXT and MIN_IDENT_LEN moved here from
//   server/eval/exact-token-eval.mjs, where #188 froze them on 2026-07-28. The
//   production counter, the #203 census, the eval's population and its gloss
//   guard all import them from here, so they cannot drift apart. The regex
//   source is byte-identical to the July literal and test/query-shape.test.mjs
//   pins it (Q6): an edit would silently change what every one of those
//   instruments calls an identifier, and break comparability with July's
//   numbers. A new identifier class is a new regex under a new name.
//
// • FROZEN VOCABULARY: classifyQueryShape returns exactly one of QUERY_SHAPES.
//   The label is the counter's `outcome`, which is part of the counters PRIMARY
//   KEY, so it must stay a closed three-word set (noteQueryShape refuses
//   anything else). The parameters below — the 5000-char cap, the stopword
//   list, "≥ half" and "≤ 8 content tokens" — are fixed by the spec before any
//   census reads a transcript; changing one changes what the counter measures
//   and needs a new pre-registration, not an edit.
//
// • NAMESPACE: the counter event is `recall.query_shape` (RECALL_EVENTS in
//   recall-telemetry.mjs), outside `capture.%`, so no capture aggregate, no
//   freshness figure and no stats field can see it, and an older server is
//   downgrade-inert against the rows. It is read by SQL only.
//
// • PRIVACY: the query is classified in memory and only the label leaves this
//   module. No query text, token or identifier is logged, stored or returned.
//   Keep it that way: never add a "which identifier matched" field, a debug log
//   of the input, or a per-query row.
//
// • BOUNDED COST, NO SHARED STATE: the frozen regex backtracks quadratically on
//   long unbroken tokens (measured: 41 ms at 5000 chars, 673 ms at 20 000, 67 s
//   at 200 000) and MCP memory_search has no length cap, so only the first
//   QUERY_SHAPE_MAX_CHARS characters are read (the UserPromptSubmit hook's own
//   cap). `dominant` needs ≤ 8 content tokens, so text past the cap can only
//   move `embedded` vs `none`. The cap counts UTF-16 code units (String#slice),
//   while the hook's Python cap counts code points; the two differ only on
//   astral characters and only past the cap, which is harmless for the reason
//   just given. Matching runs `matchAll` on a fresh RegExp per call:
//   IDENTIFIER_RX is a shared `g` regex and String.prototype.matchAll starts
//   from the regex's lastIndex, so matching on the shared object would let one
//   caller's leftover state change another request's answer. Every consumer
//   must use only `.match` (which resets lastIndex) or `matchAll` on a fresh
//   copy — never `.test` / `.exec` on the shared object.
//
// • SHORT MATCHES CONSUME TEXT (kept on purpose): the regex is matched as one
//   alternation, left to right, and a match under MIN_IDENT_LEN still consumes
//   the characters it covers before being discarded. So `#12.3.4` is `none`
//   (`#12` is taken, the rest no longer forms a version) while `12.3.4` is
//   `dominant`. This is exactly what the July eval's `.match` did; it is kept
//   for comparability with #188 and the census. Do not "fix" it here — a
//   different matcher is a different instrument.

/** File extensions the file-name alternative recognises (frozen 2026-07-28). */
export const EXT = 'mjs|js|json|sh|ya?ml|md|ts|py|db|sql|toml|ini|env|lock';
/** The July identifier regex (frozen 2026-07-28; source pinned by Q6). */
export const IDENTIFIER_RX = new RegExp([
  String.raw`[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}`,
  String.raw`v?\d+\.\d+\.\d+`,
  String.raw`#\d{1,4}`,
  String.raw`[\w-]+(?:[./][\w-]+)*\.(?:${EXT})\b`,
  String.raw`--[a-z][a-z0-9-]{2,}`,
  String.raw`[a-z_][a-z0-9_]*\(\)`,
  String.raw`(?<![\w-])~?/[\w.-]+(?:/[\w.-]+)+`,
  String.raw`[a-z][\w-]*:\d{2,5}`,
].join('|'), 'g');
/** A match shorter than this is not an identifier (`#12`, `1.2`). */
export const MIN_IDENT_LEN = 4;

/** The classifier's closed output set — the counter's outcome vocabulary. */
export const QUERY_SHAPES = Object.freeze(['none', 'embedded', 'dominant']);

/** Only this many leading characters are classified (see BOUNDED COST). */
export const QUERY_SHAPE_MAX_CHARS = 5000;

/** `dominant` needs at most this many content tokens. */
const DOMINANT_MAX_CONTENT_TOKENS = 8;

/** Spec D9's stopword list, verbatim and in the spec's order (pinned by a test). */
export const STOPWORDS = Object.freeze((
  'a an the of in on at to for with by from about into over under between through during '
  + 'after before via and or what how why where when which who is are was were does do did can should'
).split(' '));
const STOPWORD_SET = new Set(STOPWORDS);

// "Punctuation" for the stopword comparison: any character that is neither a
// letter nor a number, so `what?`, `(the` and `is,` compare as stopwords and a
// token of only symbols (`->`, `--`, an emoji) strips to empty and is dropped.
const EDGE_PUNCT_RX = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** True when `shape` is one of the three frozen labels. */
export function isQueryShape(shape) {
  return QUERY_SHAPES.includes(shape);
}

/**
 * Classify a query by how identifier-led it is (spec D9).
 *
 * Tokens are whitespace-split. A token is an identifier token when it overlaps
 * an IDENTIFIER_RX match of ≥ MIN_IDENT_LEN chars, matched on the original
 * text. Every other token is lowercased and stripped of leading and trailing
 * punctuation; an empty result is dropped and a stopword is not content.
 * Identifier tokens are always content tokens: the identifier test runs on the
 * original text first, so a token like `do()` counts as the identifier it is.
 *
 *   dominant ⟺ ≥ 1 identifier token, identifier tokens ≥ half the content
 *              tokens, and content tokens ≤ 8 (short and identifier-led)
 *   embedded ⟺ ≥ 1 identifier token and not dominant
 *   none     ⟺ otherwise (a non-string input is `none`)
 *
 * Pure: no clock, no I/O, no state kept between calls.
 *
 * @param {string} text
 * @returns {'none'|'embedded'|'dominant'}
 */
export function classifyQueryShape(text) {
  if (typeof text !== 'string') return 'none';
  const capped = text.slice(0, QUERY_SHAPE_MAX_CHARS);

  const spans = [];
  for (const m of capped.matchAll(new RegExp(IDENTIFIER_RX.source, IDENTIFIER_RX.flags))) {
    if (m[0].length >= MIN_IDENT_LEN) spans.push([m.index, m.index + m[0].length]);
  }

  // Matches never contain whitespace, so each lies inside one token. Spans and
  // tokens both arrive in text order: one forward pass pairs them.
  let content = 0;
  let identifiers = 0;
  let next = 0;
  for (const t of capped.matchAll(/\S+/g)) {
    const start = t.index;
    const end = start + t[0].length;
    while (next < spans.length && spans[next][1] <= start) next++;
    if (next < spans.length && spans[next][0] < end) {
      identifiers++;
      content++;
      continue;
    }
    const word = t[0].toLowerCase().replace(EDGE_PUNCT_RX, '');
    if (word.length === 0 || STOPWORD_SET.has(word)) continue;
    content++;
  }

  if (identifiers === 0) return 'none';
  if (identifiers * 2 >= content && content <= DOMINANT_MAX_CONTENT_TOKENS) return 'dominant';
  return 'embedded';
}
