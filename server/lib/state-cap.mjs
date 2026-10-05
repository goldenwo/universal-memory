// server/lib/state-cap.mjs — #326 state.md cap: section-aware shaping, retirement + ageing.
//
// Pure, no IO, no logger. Spec: docs/plans/2026-09-25-326-state-cap-section-aware-spec.md §4.2.1.
//
// shapeState = ensureRequiredSections → ageInFlight → applySectionLimits → fitStateToCap, each
// an exported pure step that returns its input byte-identical (with an empty report) when it has
// nothing to do. Every loop has a strict progress invariant and an unconditional exit; the
// skeleton (frontmatter, H1, the six required headings, the two marker lines) is bounded under
// 1200 chars and never removed, so "≤ cap" holds on every path for cap ≥ 1200.
//
// Two length measures (spec "Two length measures"): unit sizes, cut targets, UNIT_FLOOR_CHARS
// and CURRENT_FOCUS_CEIL_CHARS count a unit's text WITHOUT terminators; the running length,
// the deficit and every "≤ cap" comparison use the serialised document's String.length,
// terminators and CRs included.

export const STATE_CAP_CHARS = 3000;
export const CURRENT_FOCUS_CEIL_CHARS = 600;
export const UNIT_FLOOR_CHARS = 200;
export const INFLIGHT_MAX_AGE_DAYS = 14;
export const SECTION_LIMITS = Object.freeze({
  'In flight': 8,
  'Recent decisions': 8,
  'Next actions': 6,
  'Open questions': 5,
  'Environment': 3,
});
export const REQUIRED_SECTIONS = Object.freeze([
  'Current focus', 'In flight', 'Recent decisions', 'Next actions', 'Open questions', 'Environment',
]);
export const MARKER_STATE_MERGE_UNAVAILABLE = '<!-- state-merge-unavailable -->';
export const MARKER_LLM_MERGE_FAILED = '<!-- llm-merge-failed, appended raw -->';
export const UNMERGED_SUMMARY_HEADING = '## Unmerged session summary';

const MIN_CAP = 1200; // the skeleton bound (D8)
const FRONTMATTER_MAX_LINES = 40;
const FRONTMATTER_MAX_CHARS = 600;
const H1_MAX_CHARS = 200;
const HEADING_MAX_CHARS = 40;
const MARKER_SLACK_CHARS = 8;
const ELLIPSIS = ' …';
const PLACEHOLDER = '(none)';
const DAY_MS = 86_400_000;
const PRELUDE_KEY = '(preamble)';
const FOREIGN_KEY = '(foreign)';
const MARKERS = Object.freeze([MARKER_STATE_MERGE_UNAVAILABLE, MARKER_LLM_MERGE_FAILED]);
const REQUIRED_BY_LOWER = new Map(REQUIRED_SECTIONS.map(n => [n.toLowerCase(), n]));
const UNMERGED_NAME_LOWER = UNMERGED_SUMMARY_HEADING.slice(3).toLowerCase();
// D7 phase-3 value order: history and environment before live work.
const PHASE3_ORDER = Object.freeze([
  'Recent decisions', 'Environment', 'Open questions', 'In flight', 'Next actions', 'Current focus',
]);

const FM_KEY_RE = /^[A-Za-z_][\w-]*:/;
const STAMP_RE = /^(.*?)( \[(\d{4})-(\d{2})-(\d{2})\]\s*)$/;
const DECISION_DATE_RE = /^\s*[-*]\s+(\d{4})-(\d{2})-(\d{2})/;
// #358: models copy the doc's convention, and many docs date a decision at its end instead.
const DECISION_TRAILING_DATE_RE = /[[(](\d{4})-(\d{2})-(\d{2})[\])]\.?\s*$/;
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
function isRealDay(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
const ymd = date => date.toISOString().slice(0, 10);
const addDays = (date, n) => new Date(date.getTime() + n * DAY_MS);

function toInstant(value, name) {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`state-cap: ${name} is not a valid instant`);
  return d;
}

/**
 * The supplied date for a merge: `asOf` (ISO or Date) clamped to
 * [now − INFLIGHT_MAX_AGE_DAYS days, now]; unparseable or absent → now. Returns an ISO instant.
 */
export function effectiveAsOf(asOf, now) {
  const nowDate = toInstant(now, 'now');
  let d = null;
  if (asOf !== undefined && asOf !== null && asOf !== '') {
    const parsed = asOf instanceof Date ? new Date(asOf.getTime()) : new Date(asOf);
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }
  if (!d) return nowDate.toISOString();
  const floor = addDays(nowDate, -INFLIGHT_MAX_AGE_DAYS);
  if (d.getTime() > nowDate.getTime()) d = nowDate;
  else if (d.getTime() < floor.getTime()) d = floor;
  return d.toISOString();
}

/**
 * The clock every step reads: `{ asOf, now }` given together or not at all. `now` alone is
 * accepted (ageing has nothing to work from; the future rule applies); `asOf` alone is a caller
 * bug and throws — a fallback to the supplied date would silently judge "future" against a
 * client-controlled, regressing value (spec "Stamps and dates").
 */
function clockFrom(opts = {}) {
  const { asOf, now } = opts;
  const hasAsOf = asOf !== undefined && asOf !== null;
  const hasNow = now !== undefined && now !== null;
  if (hasAsOf && !hasNow) {
    throw new TypeError('state-cap: asOf was given without now — pass both (asOf from effectiveAsOf, now from the server clock) or neither');
  }
  const nowDate = hasNow ? toInstant(now, 'now') : null;
  const asOfDate = hasAsOf ? toInstant(asOf, 'asOf') : null;
  return {
    supplied: asOfDate ? ymd(asOfDate) : null,
    // aged when stamp < agedBefore (i.e. more than INFLIGHT_MAX_AGE_DAYS before the supplied date)
    agedBefore: asOfDate ? ymd(addDays(asOfDate, -INFLIGHT_MAX_AGE_DAYS)) : null,
    // future when stamp/date > futureAfter (i.e. later than the server clock's UTC date + 1 day)
    futureAfter: nowDate ? ymd(addDays(nowDate, 1)) : null,
  };
}
const isFuture = (clock, day) => Boolean(day && clock.futureAfter && day > clock.futureAfter);

function checkCap(cap) {
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < MIN_CAP) {
    throw new RangeError(`state-cap: cap must be a number >= ${MIN_CAP} (the skeleton bound), got ${cap}`);
  }
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------
/** Split on \r?\n keeping each line's terminator ('' on a final unterminated line). */
function splitLines(md) {
  const out = [];
  let i = 0;
  for (;;) {
    const nl = md.indexOf('\n', i);
    if (nl === -1) {
      out.push({ text: md.slice(i), term: '' });
      break;
    }
    const cr = nl > i && md.charCodeAt(nl - 1) === 13;
    out.push({ text: md.slice(i, cr ? nl - 1 : nl), term: cr ? '\r\n' : '\n' });
    i = nl + 1;
  }
  // "" after a final terminator is not a line.
  const last = out[out.length - 1];
  if (last.text === '' && last.term === '') out.pop();
  return out;
}
const isBlank = text => text.trim() === '';
const isIndented = text => /^\s/.test(text);

// ---------------------------------------------------------------------------
// Parser (the structure every step and the eval read)
// ---------------------------------------------------------------------------
function readStamp(text) {
  const m = STAMP_RE.exec(text);
  if (!m) return null;
  const y = Number(m[3]); const mo = Number(m[4]); const d = Number(m[5]);
  if (!isRealDay(y, mo, d)) return null;
  return { day: `${m[3]}-${m[4]}-${m[5]}`, str: m[2] };
}
/**
 * A decision's date: a leading `- YYYY-MM-DD` on its first line, else a trailing `[YYYY-MM-DD]` or
 * `(YYYY-MM-DD)` on its last non-blank line (#358). Read only; the text is never rewritten.
 */
function readDecisionDate(firstLine, lastLine) {
  const m = DECISION_DATE_RE.exec(firstLine) ?? DECISION_TRAILING_DATE_RE.exec(lastLine);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  return isRealDay(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function parse(md) {
  const lines = splitLines(md);
  const n = lines.length;
  const skeleton = new Set();

  // Frontmatter: line 1 is ---, a closing --- within the next 40 lines, every line between blank
  // or `key:`, the block (terminators included) at most 600 chars. Otherwise body text.
  let fm = null;
  if (n > 0 && lines[0].text === '---') {
    let chars = lines[0].text.length + lines[0].term.length;
    for (let j = 1; j < n && j <= FRONTMATTER_MAX_LINES; j++) {
      const { text, term } = lines[j];
      chars += text.length + term.length;
      if (text === '---') {
        if (chars <= FRONTMATTER_MAX_CHARS) fm = { start: 0, end: j };
        break;
      }
      if (!isBlank(text) && !FM_KEY_RE.test(text)) break;
    }
  }
  if (fm) for (let j = fm.start; j <= fm.end; j++) skeleton.add(j);
  const bodyStart = fm ? fm.end + 1 : 0;

  // H1: the first non-blank body line when it is `# ` + at most 200 chars.
  let h1Idx = -1;
  for (let j = bodyStart; j < n; j++) {
    if (isBlank(lines[j].text)) continue;
    if (lines[j].text.startsWith('# ') && lines[j].text.length <= H1_MAX_CHARS) h1Idx = j;
    break;
  }
  if (h1Idx >= 0) skeleton.add(h1Idx);

  // Markers: the LAST line that trims to the constant and is at most constant + 8 chars.
  const markers = {};
  for (const c of MARKERS) {
    let last = -1;
    for (let j = bodyStart; j < n; j++) {
      const t = lines[j].text;
      if (t.length <= c.length + MARKER_SLACK_CHARS && t.trim() === c) last = j;
    }
    if (last >= 0) { markers[c] = last; skeleton.add(last); }
  }

  // Heading lines: `## ` + at most 40 chars. The first unmerged-summary heading is the boundary
  // (D9); the first occurrence of each required name before it is that required section.
  const headings = [];
  for (let j = bodyStart; j < n; j++) {
    if (skeleton.has(j)) continue;
    const t = lines[j].text;
    if (t.startsWith('## ') && t.length <= HEADING_MAX_CHARS) headings.push(j);
  }
  const lowerName = j => lines[j].text.slice(3).trim().toLowerCase();
  const firstUnmergedIdx = headings.find(j => lowerName(j) === UNMERGED_NAME_LOWER) ?? -1;
  const seen = new Set();
  const sections = headings.map(j => {
    const lower = lowerName(j);
    const unmerged = lower === UNMERGED_NAME_LOWER;
    const name = REQUIRED_BY_LOWER.get(lower) ?? null;
    const required = Boolean(name) && !seen.has(name) && (firstUnmergedIdx < 0 || j < firstUnmergedIdx);
    if (required) { seen.add(name); skeleton.add(j); }
    return { idx: j, heading: lines[j].text, name: required ? name : null, required, unmerged, key: required ? name : FOREIGN_KEY, units: [] };
  });

  // Units: a total partition of the content lines of each region.
  const lineKey = new Array(n).fill(null);
  const buildUnits = (from, to, section) => {
    const units = [];
    let open = null;
    let leadingBlank = null;
    const key = section ? section.key : PRELUDE_KEY;
    const push = u => { units.push(u); };
    const flushLeading = () => { if (leadingBlank) { push(makeUnit(leadingBlank)); leadingBlank = null; } };
    const makeUnit = idxs => {
      const first = lines[idxs[0]].text;
      const blank = idxs.every(i => isBlank(lines[i].text));
      const nonBlank = idxs.filter(i => !isBlank(lines[i].text));
      const placeholder = nonBlank.length === 1 && lines[nonBlank[0]].text.trim() === PLACEHOLDER;
      let stamp = null; let stampStr = ''; let date = null;
      if (section && section.name === 'In flight') {
        const s = readStamp(first);
        if (s) { stamp = s.day; stampStr = s.str; }
      } else if (section && section.name === 'Recent decisions') {
        date = readDecisionDate(first, nonBlank.length ? lines[nonBlank[nonBlank.length - 1]].text : first);
      }
      return { lines: idxs, size: idxs.reduce((acc, i) => acc + lines[i].text.length, 0), blank, placeholder, stamp, stampStr, date, isHeading: false, removed: false, cut: false };
    };
    for (let j = from; j < to; j++) {
      if (skeleton.has(j)) continue;
      lineKey[j] = key;
      const t = lines[j].text;
      if (isBlank(t)) {
        if (open) open.push(j);
        else (leadingBlank ??= []).push(j);
      } else if (isIndented(t)) {
        if (open) open.push(j);
        else { flushLeading(); open = [j]; }
      } else {
        flushLeading();
        if (open) push(makeUnit(open));
        open = [j];
      }
    }
    flushLeading();
    if (open) push(makeUnit(open));
    return units;
  };
  const firstHeading = headings.length ? headings[0] : n;
  const preamble = { key: PRELUDE_KEY, name: null, units: buildUnits(bodyStart, firstHeading, null) };
  sections.forEach((s, k) => {
    const end = k + 1 < sections.length ? sections[k + 1].idx : n;
    s.units = buildUnits(s.idx + 1, end, s);
    if (!s.required) {
      // A foreign heading line is its section's LAST unit.
      lineKey[s.idx] = FOREIGN_KEY;
      s.units.push({ lines: [s.idx], size: lines[s.idx].text.length, blank: false, placeholder: false, stamp: null, stampStr: '', date: null, isHeading: true, removed: false, cut: false });
    }
  });

  return { lines, n, skeleton, fm, h1Idx, markers, firstUnmergedIdx, preamble, sections, lineKey };
}

/**
 * The parsed structure, for the eval and the census: `{ frontmatter, h1, preamble, sections }`.
 * Each section carries `heading` (the line as written), `name` (canonical, required only),
 * `required`, `unmerged` and `units`; each unit carries `lines` (texts), `size`, `blank`,
 * `placeholder`, `stamp` (In flight), `date` (Recent decisions) and `heading` (true for the
 * foreign heading unit).
 */
export function parseState(md) {
  const d = parse(md);
  const pub = u => ({
    lines: u.lines.map(i => d.lines[i].text),
    size: u.size,
    blank: u.blank,
    placeholder: u.placeholder,
    stamp: u.stamp,
    date: u.date,
    heading: u.isHeading,
  });
  return {
    frontmatter: d.fm ? { lines: d.lines.slice(d.fm.start, d.fm.end + 1).map(l => l.text) } : null,
    h1: d.h1Idx >= 0 ? d.lines[d.h1Idx].text : null,
    preamble: { units: d.preamble.units.map(pub) },
    sections: d.sections.map(s => ({ heading: s.heading, name: s.name, required: s.required, unmerged: s.unmerged, units: s.units.map(pub) })),
  };
}

// ---------------------------------------------------------------------------
// Editing model shared by the steps: removed line indices + replaced first lines, serialised once.
// ---------------------------------------------------------------------------
function serialize(doc, removed, replaced) {
  let out = '';
  for (let i = 0; i < doc.n; i++) {
    if (removed.has(i)) continue;
    const l = doc.lines[i];
    out += (replaced && replaced.has(i) ? replaced.get(i) : l.text) + l.term;
  }
  return out;
}
const alive = section => section.units.filter(u => !u.removed);
const requiredByName = doc => new Map(doc.sections.filter(s => s.required).map(s => [s.name, s]));

/**
 * The removal policy (one unit; used by limits and by phase 3): blank first, then a placeholder,
 * whenever the section has another unit; then per section — In flight: the unstamped unit
 * nearest the top (a future stamp counts as unstamped), else the smallest stamp (tie → topmost);
 * Recent decisions: the undated unit nearest the top (a future date counts as undated), else the
 * smallest date (tie → topmost); Next actions / Open questions: topmost; Environment, Current
 * focus, foreign, preamble: the last unit (a foreign heading line only when nothing else is left).
 */
function pickUnit(section, live, clock) {
  if (live.length >= 2) {
    const blank = live.find(u => u.blank);
    if (blank) return blank;
    const placeholder = live.find(u => u.placeholder);
    if (placeholder) return placeholder;
  }
  const minBy = key => {
    let best = null;
    for (const u of live) if (best === null || key(u) < key(best)) best = u;
    return best;
  };
  switch (section.key) {
    case 'In flight': {
      const unstamped = live.find(u => !u.stamp || isFuture(clock, u.stamp));
      return unstamped ?? minBy(u => u.stamp);
    }
    case 'Recent decisions': {
      const undated = live.find(u => !u.date || isFuture(clock, u.date));
      return undated ?? minBy(u => u.date);
    }
    case 'Next actions':
    case 'Open questions':
      return live[0];
    case FOREIGN_KEY: {
      const nonHeading = live.filter(u => !u.isHeading);
      return nonHeading.length ? nonHeading[nonHeading.length - 1] : live[live.length - 1];
    }
    default:
      return live[live.length - 1];
  }
}

// ---------------------------------------------------------------------------
// ensureRequiredSections
// ---------------------------------------------------------------------------
/**
 * Insert every missing required section as `## <Heading>\n(none)\n`, in canonical order among the
 * inserted ones: immediately before the FIRST unmerged-summary heading when there is one (above
 * any marker lines directly preceding it, blank lines skipped), else before the trailing run of
 * marker lines (blank lines skipped), never before a heading; else at the end.
 */
export function ensureRequiredSections(md) {
  const doc = parse(md);
  const present = new Set(doc.sections.filter(s => s.required).map(s => s.name));
  const added = REQUIRED_SECTIONS.filter(n => !present.has(n));
  if (added.length === 0) return { md, added: [] };

  const isMarkerLine = j => Object.values(doc.markers).includes(j);
  const skippable = j => isBlank(doc.lines[j].text) || isMarkerLine(j);
  let at;
  if (doc.firstUnmergedIdx >= 0) {
    at = doc.firstUnmergedIdx;
    while (at > 0 && skippable(at - 1)) at--;
  } else {
    at = doc.n;
    while (at > 0 && skippable(at - 1)) at--;
  }
  const scaffold = added.map(n => `## ${n}\n${PLACEHOLDER}\n`).join('');
  let head = '';
  for (let i = 0; i < at; i++) head += doc.lines[i].text + doc.lines[i].term;
  if (at > 0 && doc.lines[at - 1].term === '') head += '\n';
  let tail = '';
  for (let i = at; i < doc.n; i++) tail += doc.lines[i].text + doc.lines[i].term;
  return { md: head + scaffold + tail, added };
}

// ---------------------------------------------------------------------------
// ageInFlight
// ---------------------------------------------------------------------------
/**
 * In the required In-flight section remove every unit whose stamp is more than
 * INFLIGHT_MAX_AGE_DAYS days before the supplied date (`aged`) and every unit whose stamp is
 * later than the server clock's UTC date + 1 day (`aged_future`). Unstamped units are never aged.
 * Without `asOf`: identity. `asOf` without `now`: TypeError.
 */
export function ageInFlight(md, opts = {}) {
  const clock = clockFrom(opts);
  if (!clock.supplied) return { md, aged: 0, aged_future: 0 };
  const doc = parse(md);
  const section = requiredByName(doc).get('In flight');
  if (!section) return { md, aged: 0, aged_future: 0 };
  const removed = new Set();
  let aged = 0;
  let agedFuture = 0;
  for (const u of section.units) {
    if (!u.stamp) continue;
    if (u.stamp < clock.agedBefore) aged++;
    else if (isFuture(clock, u.stamp)) agedFuture++;
    else continue;
    for (const i of u.lines) removed.add(i);
  }
  if (removed.size === 0) return { md, aged: 0, aged_future: 0 };
  return { md: serialize(doc, removed, null), aged, aged_future: agedFuture };
}

// ---------------------------------------------------------------------------
// applySectionLimits
// ---------------------------------------------------------------------------
/**
 * For each required section with a limit, remove units by the policy until at most the limit
 * remain (blank units and placeholders do not count toward the limit but go first when present).
 */
export function applySectionLimits(md, opts = {}) {
  const clock = clockFrom(opts);
  const doc = parse(md);
  const byName = requiredByName(doc);
  const removed = new Set();
  const bounded = [];
  for (const name of REQUIRED_SECTIONS) {
    const limit = SECTION_LIMITS[name];
    const section = byName.get(name);
    if (limit === undefined || !section) continue;
    const counts = u => !u.blank && !u.placeholder;
    let dropped = 0;
    for (;;) {
      const live = alive(section);
      if (live.filter(counts).length <= limit) break;
      const victim = pickUnit(section, live, clock);
      victim.removed = true;
      for (const i of victim.lines) removed.add(i);
      // A blank or placeholder goes first but is not an item: `bounded` reports items (#342).
      if (counts(victim)) dropped++;
    }
    if (dropped > 0) bounded.push({ heading: name, dropped });
  }
  if (removed.size === 0) return { md, bounded: [] };
  return { md: serialize(doc, removed, null), bounded };
}

// ---------------------------------------------------------------------------
// fitStateToCap
// ---------------------------------------------------------------------------
/**
 * Fit the document to `cap` (String.length): phase 1 preamble text and foreign sections
 * (last-in-document first); phase 2 the Current-focus ceiling, bounded by the deficit; phase 3
 * the value order Recent decisions, Environment, Open questions, In flight, Next actions,
 * Current focus — whole units from sections with two or more, then one cut per unit down to
 * UNIT_FLOOR_CHARS, then the remaining units, then (unreachable once the partition is total) the
 * last non-skeleton line. Precondition: cap ≥ 1200 (RangeError). Identity when already ≤ cap.
 */
export function fitStateToCap(md, opts = {}) {
  const { cap = STATE_CAP_CHARS } = opts;
  checkCap(cap);
  const clock = clockFrom(opts);
  if (md.length <= cap) return { md, trims: [] };

  const doc = parse(md);
  const { lines } = doc;
  const removed = new Set();
  const replaced = new Map();
  let length = md.length;
  const trims = new Map();
  const account = key => {
    if (!trims.has(key)) trims.set(key, { heading: key, units_dropped: 0, chars_cut: 0 });
    return trims.get(key);
  };
  const dropLine = i => { length -= lines[i].text.length + lines[i].term.length; removed.add(i); };
  const remove = (unit, key) => {
    for (const i of unit.lines) dropLine(i);
    unit.removed = true;
    account(key).units_dropped++;
  };
  const currentText = i => (replaced.has(i) ? replaced.get(i) : lines[i].text);
  /**
   * Single-unit cut: (1) drop the continuation lines; (2) if the first line is still above
   * `target`, detach a trailing In-flight stamp, keep the text before the last whitespace at
   * index ≤ target − 2 − stampSize (whitespace inside a leading list marker such as `- ` or
   * `1. ` does not count; hard-cut when there is none), append ' …', re-attach the stamp.
   * Applied only when it strictly reduces the unit's size; the unit is exhausted after it.
   * chars_cut counts dropped continuation text in full plus the first-line characters cut (the
   * ellipsis and a re-attached stamp are not counted).
   */
  const cut = (unit, target, key) => {
    const before = unit.size;
    const first = unit.lines[0];
    let chars = 0;
    let size = currentText(first).length;
    const contLines = unit.lines.slice(1);
    for (const i of contLines) chars += lines[i].text.length;
    let newText = null;
    if (size > target) {
      const text = currentText(first);
      const stampStr = unit.stampStr;
      const body = text.slice(0, text.length - stampStr.length);
      const limit = target - ELLIPSIS.length - stampStr.length;
      // A cut that lands on the whitespace of the list marker itself would leave `- …`; a
      // long URL or path is a single token and must be hard-cut like any other.
      const markerLen = LIST_MARKER_RE.exec(body)?.[0].length ?? 0;
      let at = -1;
      for (let j = Math.min(limit, body.length - 1); j >= markerLen; j--) {
        if (/\s/.test(body[j])) { at = j; break; }
      }
      if (at < 0) at = Math.max(0, limit);
      const keep = body.slice(0, at);
      newText = keep + ELLIPSIS + stampStr;
      chars += (body.length - keep.length) - (body.endsWith(ELLIPSIS) ? ELLIPSIS.length : 0);
      size = newText.length;
    }
    if (size >= before) { unit.cut = true; return false; }
    for (const i of contLines) dropLine(i);
    unit.lines = [first];
    if (newText !== null) {
      length -= currentText(first).length - newText.length;
      replaced.set(first, newText);
    }
    unit.size = size;
    unit.cut = true;
    account(key).chars_cut += chars;
    return true;
  };
  const exhausted = u => u.cut || u.size <= UNIT_FLOOR_CHARS;
  const byName = requiredByName(doc);
  const foreign = doc.sections.filter(s => !s.required);

  // Phase 1 — foreign first: preamble text, then foreign sections last-in-document first.
  while (length > cap) {
    const pre = alive(doc.preamble);
    if (pre.length) { remove(pickUnit(doc.preamble, pre, clock), PRELUDE_KEY); continue; }
    let took = false;
    for (let k = foreign.length - 1; k >= 0; k--) {
      const live = alive(foreign[k]);
      if (!live.length) continue;
      remove(pickUnit(foreign[k], live, clock), FOREIGN_KEY);
      took = true;
      break;
    }
    if (!took) break;
  }

  // Phase 2 — the Current-focus ceiling, bounded by the deficit.
  const cf = byName.get('Current focus');
  while (cf && length > cap) {
    const live = alive(cf);
    const total = live.reduce((acc, u) => acc + u.size, 0);
    if (total <= CURRENT_FOCUS_CEIL_CHARS) break;
    if (live.length >= 2) { remove(pickUnit(cf, live, clock), 'Current focus'); continue; }
    const unit = live[0];
    const target = Math.max(CURRENT_FOCUS_CEIL_CHARS, unit.size - (length - cap));
    if (!cut(unit, target, 'Current focus')) break;
  }

  // Phase 3 — value order.
  while (length > cap) {
    const deficit = length - cap;
    let done = false;
    for (const name of PHASE3_ORDER) { // (a) whole units from a section with two or more
      const s = byName.get(name);
      if (!s) continue;
      const live = alive(s);
      if (live.length >= 2) { remove(pickUnit(s, live, clock), name); done = true; break; }
    }
    if (done) continue;
    for (const name of PHASE3_ORDER) { // (b) one cut per non-exhausted unit
      const s = byName.get(name);
      if (!s) continue;
      const unit = alive(s).find(u => !exhausted(u));
      if (unit) { cut(unit, Math.max(UNIT_FLOOR_CHARS, unit.size - deficit), name); done = true; break; }
    }
    if (done) continue;
    for (const name of PHASE3_ORDER) { // (c) the remaining unit
      const s = byName.get(name);
      if (!s) continue;
      const live = alive(s);
      if (live.length) { remove(live[0], name); done = true; break; }
    }
    if (done) continue;
    // (d) the last non-skeleton line — unreachable once the partition is total; kept so the
    // loop's exit does not depend on the partition proof.
    let j = doc.n - 1;
    while (j >= 0 && (doc.skeleton.has(j) || removed.has(j))) j--;
    if (j < 0) break;
    dropLine(j);
    account(doc.lineKey[j] ?? FOREIGN_KEY).units_dropped++;
  }

  const order = [PRELUDE_KEY, FOREIGN_KEY, ...REQUIRED_SECTIONS];
  return { md: serialize(doc, removed, replaced), trims: order.filter(k => trims.has(k)).map(k => trims.get(k)) };
}

// ---------------------------------------------------------------------------
// shapeState
// ---------------------------------------------------------------------------
/**
 * The four steps in order on the text. Idempotent: shapeState(shapeState(md)) === shapeState(md).
 * `{ asOf, now }` together or not at all; `cap` ≥ 1200.
 */
export function shapeState(md, opts = {}) {
  const { asOf, now, cap = STATE_CAP_CHARS } = opts;
  checkCap(cap);
  clockFrom({ asOf, now });
  const ensured = ensureRequiredSections(md);
  const aged = ageInFlight(ensured.md, { asOf, now });
  const limited = applySectionLimits(aged.md, { asOf, now });
  const fitted = fitStateToCap(limited.md, { cap, asOf, now });
  return {
    md: fitted.md,
    report: { added: ensured.added, aged: aged.aged, aged_future: aged.aged_future, bounded: limited.bounded, trims: fitted.trims },
  };
}
