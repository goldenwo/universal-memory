// server/test/state-cap.test.mjs — #326 state.md cap: section-aware shaping, retirement + ageing.
//
// The 46 numbered cases below are the REGISTERED set of spec 4.2.4
// (docs/plans/2026-09-25-326-state-cap-section-aware-spec.md); the mutation control's
// predicted FAIL / PASS sets refer to these numbers, so keep the numbering stable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_CAP_CHARS,
  CURRENT_FOCUS_CEIL_CHARS,
  UNIT_FLOOR_CHARS,
  INFLIGHT_MAX_AGE_DAYS,
  SECTION_LIMITS,
  REQUIRED_SECTIONS,
  MARKER_STATE_MERGE_UNAVAILABLE,
  MARKER_LLM_MERGE_FAILED,
  UNMERGED_SUMMARY_HEADING,
  effectiveAsOf,
  parseState,
  ensureRequiredSections,
  ageInFlight,
  applySectionLimits,
  fitStateToCap,
  shapeState,
} from '../lib/state-cap.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers (inline, per plan T1.1)
// ---------------------------------------------------------------------------
const NOW = new Date('2026-09-25T12:00:00.000Z');
const AS_OF = '2026-09-25T10:00:00.000Z';
const CTX = { asOf: AS_OF, now: NOW };
const ELL = ' …';
const FM_LINES = [
  '---',
  'schema_version: 1',
  'type: state',
  'id: state-fixture',
  'title: State of play — fixture',
  'status: current',
  'valid_from: 2026-09-20T00:00:00.000Z',
  'project: fixture',
  '---',
];
const FM = FM_LINES.join('\n') + '\n';
const H1 = '# State of play — fixture';
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];

/** Exactly n chars of cuttable prose (word-separated, never ends in whitespace). */
function text(n) {
  let s = '';
  for (let i = 0; s.length < n; i++) s += WORDS[i % WORDS.length] + ' ';
  s = s.slice(0, n);
  if (s.endsWith(' ')) s = s.slice(0, -1) + 'x';
  return s;
}
/** One In-flight bullet of exactly `size` chars (stamp included when given). */
function bullet(label, size, stamp) {
  const tail = stamp ? ` [${stamp}]` : '';
  const head = `- ${label}: `;
  return head + text(size - head.length - tail.length) + tail;
}
/** One Recent-decisions entry of exactly `size` chars. */
function decision(date, size) {
  const head = `- ${date}: `;
  return head + text(size - head.length);
}
function sec(name, units) {
  return `## ${name}\n` + units.map(u => u + '\n').join('');
}
/**
 * A full six-section doc. Every section value is a list of unit strings
 * (a unit may span lines). `pre` is preamble text after the H1; `tail` is appended raw.
 */
function build({ cf = [text(300)], inflight = [bullet('a', 100, '2026-09-20')], decisions = [decision('2026-09-20', 100)],
  next = [text(100)], open = [text(100)], env = [text(100)], pre = '', tail = '' } = {}) {
  return FM + '\n' + H1 + '\n' + pre
    + sec('Current focus', cf) + sec('In flight', inflight) + sec('Recent decisions', decisions)
    + sec('Next actions', next) + sec('Open questions', open) + sec('Environment', env) + tail;
}
function section(md, name) {
  const p = parseState(md);
  return p.sections.find(s => s.required && s.name === name);
}
function requiredNames(md) {
  return parseState(md).sections.filter(s => s.required).map(s => s.name);
}
function unitTexts(md, name) {
  return section(md, name).units.map(u => u.lines.join('\n'));
}
/** The raw text of a required section (heading line through the line before the next heading). */
function rawSection(md, name) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex(l => l === `## ${name}`);
  assert.ok(start >= 0, `section ${name} present`);
  let end = start + 1;
  while (end < lines.length && !/^## /.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}
const headingCount = md => (md.match(/^## /gm) || []).length;
const requiredHeadingCount = md => REQUIRED_SECTIONS.filter(n => md.includes(`\n## ${n}\n`) || md.startsWith(`## ${n}\n`)).length;
const fit = (md, ctx = CTX) => fitStateToCap(md, { cap: STATE_CAP_CHARS, ...ctx });
/** The skeleton survives in order: frontmatter first, then the H1, then the six headings in canonical order. */
function assertSkeletonInOrder(md) {
  assert.ok(md.startsWith(FM), 'frontmatter first');
  const marks = [H1, ...REQUIRED_SECTIONS.map(n => `## ${n}`)].map(m => md.indexOf(`${m}\n`) >= 0 ? md.indexOf(`${m}\n`) : md.indexOf(`${m}\r\n`));
  assert.ok(marks.every(i => i >= FM.length), `every skeleton line present after the frontmatter: ${marks}`);
  for (let i = 1; i < marks.length; i++) assert.ok(marks[i] > marks[i - 1], 'skeleton lines in order');
}

// ---------------------------------------------------------------------------
// Constants (exported contract)
// ---------------------------------------------------------------------------
test('constants match the spec', () => {
  assert.equal(STATE_CAP_CHARS, 3000);
  assert.equal(CURRENT_FOCUS_CEIL_CHARS, 600);
  assert.equal(UNIT_FLOOR_CHARS, 200);
  assert.equal(INFLIGHT_MAX_AGE_DAYS, 14);
  assert.deepEqual(SECTION_LIMITS, { 'In flight': 8, 'Recent decisions': 8, 'Next actions': 6, 'Open questions': 5, 'Environment': 3 });
  assert.deepEqual(REQUIRED_SECTIONS, ['Current focus', 'In flight', 'Recent decisions', 'Next actions', 'Open questions', 'Environment']);
  assert.equal(MARKER_STATE_MERGE_UNAVAILABLE, '<!-- state-merge-unavailable -->');
  assert.equal(MARKER_LLM_MERGE_FAILED, '<!-- llm-merge-failed, appended raw -->');
  assert.equal(UNMERGED_SUMMARY_HEADING, '## Unmerged session summary');
});

// ---------------------------------------------------------------------------
// SC01–SC19: fitStateToCap
// ---------------------------------------------------------------------------
test('SC01 fit: identity under cap (byte-identical, trims: [])', () => {
  const md = build();
  assert.ok(md.length < STATE_CAP_CHARS);
  const r = fit(md);
  assert.equal(r.md, md);
  assert.deepEqual(r.trims, []);
});

const BASE_OVER = () => build({
  cf: [text(700)],
  inflight: [
    bullet('A', 90, '2026-09-20'), bullet('B', 90, '2026-09-18'), bullet('C', 90),
    bullet('D', 90, '2026-09-22'), bullet('E', 90, '2026-09-14'), bullet('F', 90, '2026-09-19'),
    bullet('G', 90, '2026-09-23'), bullet('H', 90), bullet('I', 90, '2026-09-17'),
    bullet('J', 90, '2026-09-24'), bullet('K', 90, '2026-09-16'), bullet('L', 90, '2026-09-25'),
  ],
  decisions: ['2026-09-24', '2026-09-23', '2026-09-22', '2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18', '2026-09-17'].map(d => decision(d, 90)),
  next: Array.from({ length: 6 }, (_, i) => `- next ${i + 1}: ${text(50)}`),
  open: Array.from({ length: 5 }, (_, i) => `- open ${i + 1}: ${text(50)}`),
  env: ['- branch: main', '- server: running on :3000', '- notable: fixtures under test/fixtures'],
});

test('SC02 fit: over cap keeps all six required headings and is <= cap', () => {
  const md = BASE_OVER();
  assert.ok(md.length > STATE_CAP_CHARS, `fixture over cap (${md.length})`);
  const r = fit(md);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
  assert.ok(r.trims.length > 0);
});

const STAMPS12 = ['2026-09-20', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-14', '2026-09-19',
  '2026-09-23', '2026-09-17', '2026-09-16', '2026-09-24', '2026-09-15', '2026-09-25'];

test('SC03 fit: In flight loses its smallest-stamped unit, which is not on top', () => {
  const md = build({
    cf: [text(600)],
    inflight: STAMPS12.map((s, i) => bullet(String.fromCharCode(65 + i), 150, s)),
    decisions: [decision('2026-09-20', 190)], next: [text(190)], open: [text(190)], env: [text(100)],
  });
  assert.ok(md.length > STATE_CAP_CHARS && md.length < STATE_CAP_CHARS + 500, `deficit sized for a few removals (${md.length})`);
  const r = fit(md);
  const stamps = unitTexts(r.md, 'In flight').map(u => u.slice(-11, -1));
  assert.ok(!stamps.includes('2026-09-14'), 'smallest stamp removed');
  assert.ok(stamps.includes('2026-09-20'), 'topmost (not smallest) kept');
  assert.ok(stamps.includes('2026-09-25'));
  // every removed stamp is smaller than every kept one
  const removed = STAMPS12.filter(s => !stamps.includes(s));
  assert.ok(removed.length >= 1);
  assert.ok(Math.max(...removed.map(s => s.replace(/-/g, ''))) < Math.min(...stamps.map(s => s.replace(/-/g, ''))));
  assert.ok(r.md.length <= STATE_CAP_CHARS);
});

test('SC04 fit: unstamped In-flight units go before stamped ones, topmost first', () => {
  const units = STAMPS12.map((s, i) => (i === 2 || i === 6) ? bullet(String.fromCharCode(65 + i), 137) : bullet(String.fromCharCode(65 + i), 150, s));
  const md = build({ cf: [text(450)], inflight: units, decisions: [decision('2026-09-20', 190)], next: [text(190)], open: [text(190)], env: [text(100)] });
  const deficit = md.length - STATE_CAP_CHARS;
  assert.ok(deficit > 138 && deficit <= 2 * 138, `deficit covers exactly the two unstamped units (${deficit})`);
  const r = fit(md);
  const kept = unitTexts(r.md, 'In flight');
  assert.equal(kept.length, 10);
  assert.ok(kept.every(u => /\[\d{4}-\d{2}-\d{2}\]$/.test(u)), 'only stamped units remain');
  assert.ok(!kept.some(u => u.startsWith('- C:')) && !kept.some(u => u.startsWith('- G:')));
});

test('SC05 fit: Recent decisions loses its smallest-dated unit, which is not on top (newest-first list)', () => {
  const dates = ['2026-09-24', '2026-09-23', '2026-09-22', '2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18', '2026-09-17', '2026-09-16', '2026-09-15'];
  const md = build({ cf: [text(600)], inflight: [bullet('a', 190, '2026-09-20')], decisions: dates.map(d => decision(d, 200)), next: [text(190)], open: [text(190)], env: [text(190)] });
  assert.ok(md.length > STATE_CAP_CHARS);
  const r = fit(md);
  const kept = unitTexts(r.md, 'Recent decisions').map(u => u.slice(2, 12));
  assert.ok(!kept.includes('2026-09-15'), 'smallest date (bottom) removed');
  assert.ok(kept.includes('2026-09-24'), 'top (newest) kept');
  const removed = dates.filter(d => !kept.includes(d));
  assert.ok(Math.max(...removed.map(s => s.replace(/-/g, ''))) < Math.min(...kept.map(s => s.replace(/-/g, ''))));
  assert.ok(r.md.length <= STATE_CAP_CHARS);
});

test('SC06 fit: Next actions and Open questions lose their topmost unit', () => {
  const one = { cf: [text(600)], inflight: [bullet('a', 190, '2026-09-20')], decisions: [decision('2026-09-20', 190)], env: [text(190)] };
  const mdOpen = build({ ...one, next: [text(190)], open: Array.from({ length: 7 }, (_, i) => `- q${i + 1} ${text(194)}`) });
  assert.ok(mdOpen.length > STATE_CAP_CHARS && mdOpen.length - STATE_CAP_CHARS < 200);
  const a = fit(mdOpen);
  const openKept = unitTexts(a.md, 'Open questions');
  assert.equal(openKept.length, 6);
  assert.ok(openKept[0].startsWith('- q2 '), 'topmost removed');
  const mdNext = build({ ...one, open: [text(190)], next: Array.from({ length: 8 }, (_, i) => `- n${i + 1} ${text(194)}`) });
  assert.ok(mdNext.length > STATE_CAP_CHARS);
  const b = fit(mdNext);
  const nextKept = unitTexts(b.md, 'Next actions');
  assert.ok(nextKept.length < 8 && nextKept.length >= 6);
  assert.ok(nextKept[0].startsWith(`- n${8 - nextKept.length + 1} `), 'removed from the top');
  assert.ok(nextKept.at(-1).startsWith('- n8 '));
});

test('SC07 fit: Environment loses its last unit', () => {
  const md = build({ cf: [text(600)], inflight: [bullet('a', 190, '2026-09-20')], decisions: [decision('2026-09-20', 190)], next: [text(190)], open: [text(190)],
    env: Array.from({ length: 8 }, (_, i) => `- e${i + 1} ${text(194)}`) });
  assert.ok(md.length > STATE_CAP_CHARS);
  const r = fit(md);
  const env = unitTexts(r.md, 'Environment');
  assert.ok(env.length < 8 && env.length >= 1);
  assert.ok(env[0].startsWith('- e1 '), 'top kept');
  assert.ok(!env.some(u => u.startsWith('- e8 ')), 'last removed');
});

test('SC08 fit: Current focus ceiling — (a) cut bounded by the deficit, (b) cut to 600 then value order, (c) blank line then paragraph is cut not removed', () => {
  const others = { inflight: [bullet('a', 100, '2026-09-20')], decisions: [decision('2026-09-20', 100)], next: [text(100)], open: [text(100)], env: [text(100)] };
  // (a)
  const mdA = build({ cf: [text(2800)], ...others });
  const deficitA = mdA.length - STATE_CAP_CHARS;
  assert.ok(deficitA > 0 && deficitA < 2800 - CURRENT_FOCUS_CEIL_CHARS);
  const a = fit(mdA);
  const cfA = unitTexts(a.md, 'Current focus');
  assert.equal(cfA.length, 1);
  assert.ok(cfA[0].length <= 2800 - deficitA, `cut to <= size - deficit (${cfA[0].length})`);
  assert.ok(cfA[0].endsWith(ELL), 'ellipsis appended');
  assert.ok(cfA[0].length > CURRENT_FOCUS_CEIL_CHARS, 'not cut further than the deficit needs');
  for (const n of REQUIRED_SECTIONS.slice(1)) assert.equal(rawSection(a.md, n), rawSection(mdA, n), `${n} byte-identical`);
  assert.ok(a.md.length <= STATE_CAP_CHARS);
  // (b)
  const mdB = build({ cf: [text(2800)], inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')),
    decisions: Array.from({ length: 10 }, (_, i) => decision(`2026-09-${String(24 - i).padStart(2, '0')}`, 200)), next: [text(100)], open: [text(100)], env: [text(100)] });
  assert.ok(mdB.length - STATE_CAP_CHARS >= 2800 - CURRENT_FOCUS_CEIL_CHARS + 500);
  const b = fit(mdB);
  const cfB = unitTexts(b.md, 'Current focus');
  assert.ok(cfB[0].length <= CURRENT_FOCUS_CEIL_CHARS && cfB[0].endsWith(ELL));
  assert.ok(unitTexts(b.md, 'Recent decisions').length < 10, 'phase 3 took decisions next');
  assert.equal(unitTexts(b.md, 'In flight').length, 8, 'In flight untouched');
  assert.ok(b.md.length <= STATE_CAP_CHARS);
  // (c)
  const para = text(2800);
  const mdC = build({ cf: ['', para], ...others });
  const c = fit(mdC);
  const cfC = rawSection(c.md, 'Current focus');
  assert.ok(cfC.includes(para.slice(0, 80)), 'the paragraph was cut, not removed');
  assert.ok(cfC.endsWith(ELL));
  assert.ok(c.md.length <= STATE_CAP_CHARS);
});

test('SC09 fit: phase 3 drains Recent decisions to one unit before In flight loses any', () => {
  const mk = pad => build({ cf: [text(600)],
    inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')),
    decisions: Array.from({ length: 8 }, (_, i) => decision(`2026-09-${String(24 - i).padStart(2, '0')}`, 150)),
    next: [text(200)], open: [text(190)], env: [text(190 + pad)] });
  const md = mk(0);
  const deficit = md.length - STATE_CAP_CHARS;
  const want = 6 * 151 + 60;
  const md2 = mk(want - deficit);
  const deficit2 = md2.length - STATE_CAP_CHARS;
  assert.ok(deficit2 > 6 * 151 && deficit2 <= 7 * 151, `deficit needs exactly seven decision removals (${deficit2})`);
  const r = fit(md2);
  assert.equal(unitTexts(r.md, 'Recent decisions').length, 1);
  assert.equal(unitTexts(r.md, 'In flight').length, 8);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
});

const FOREIGN_TAIL = () => '## What happened\n' + [text(100), text(100), text(100)].join('\n') + '\n'
  + '## Next steps\n' + [text(100), text(100)].join('\n') + '\n'
  + `${UNMERGED_SUMMARY_HEADING}\n` + [text(100), text(100), text(100)].join('\n') + '\n';

test('SC10 fit: foreign text first; a foreign section that fits alone leaves the six required sections byte-identical', () => {
  const md = build({ cf: [text(600)],
    inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')),
    decisions: Array.from({ length: 8 }, (_, i) => decision(`2026-09-${String(24 - i).padStart(2, '0')}`, 150)),
    next: [text(190)], open: [text(190)], env: [text(190)],
    pre: text(100) + '\n' + text(100) + '\n', tail: FOREIGN_TAIL() });
  const foreignChars = FOREIGN_TAIL().length + 202;
  assert.ok(md.length - STATE_CAP_CHARS > foreignChars, 'deficit larger than the foreign surplus');
  const r = fit(md);
  assert.ok(!r.md.includes('## What happened') && !r.md.includes('## Next steps') && !r.md.includes(UNMERGED_SUMMARY_HEADING));
  assert.equal(parseState(r.md).preamble.units.filter(u => !u.blank).length, 0, 'no preamble text left');
  assert.equal(unitTexts(r.md, 'In flight').length, 8, 'required sections changed only after the foreign region was gone');
  assert.ok(r.trims.some(t => t.heading === '(preamble)') && r.trims.some(t => t.heading === '(foreign)'));
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  // second half: a foreign section that fits alone
  const md2 = build({ cf: [text(1400)], inflight: [bullet('a', 150, '2026-09-20'), bullet('b', 150, '2026-09-21'), bullet('c', 150, '2026-09-22')],
    decisions: [decision('2026-09-22', 150), decision('2026-09-21', 150), decision('2026-09-20', 150)], next: [text(100)], open: [text(100)], env: [text(100)],
    tail: '## What happened\n' + [text(100), text(100), text(100)].join('\n') + '\n' });
  const requiredOnly = md2.slice(0, md2.indexOf('## What happened'));
  assert.ok(requiredOnly.length <= STATE_CAP_CHARS && md2.length > STATE_CAP_CHARS);
  const r2 = fit(md2);
  for (const n of REQUIRED_SECTIONS) assert.equal(rawSection(r2.md, n), rawSection(md2, n), `${n} byte-identical`);
  assert.ok(r2.md.length <= STATE_CAP_CHARS);
});

test('SC11 fit: frontmatter byte-identical', () => {
  const r = fit(BASE_OVER());
  assert.ok(r.md.startsWith(FM));
});

test('SC12 fit: both marker lines survive (indented by two spaces; last line); any other HTML comment line is content', () => {
  const md = build({ cf: [text(600)], inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')),
    decisions: [decision('2026-09-20', 190)], next: [text(190)], open: [text(190)], env: [text(225)],
    tail: `${UNMERGED_SUMMARY_HEADING}\n<!-- note -->\n${text(100)}\n${text(100)}\n${text(100)}\n  ${MARKER_LLM_MERGE_FAILED}\n${text(100)}\n${MARKER_STATE_MERGE_UNAVAILABLE}` });
  const deficit = md.length - STATE_CAP_CHARS;
  assert.ok(deficit > 404 && deficit <= 417, `deficit removes every foreign unit incl. the note (${deficit})`);
  const r = fit(md);
  assert.ok(!r.md.includes('<!-- note -->'), 'plain comment removed as content');
  assert.ok(r.md.includes(`\n  ${MARKER_LLM_MERGE_FAILED}\n`), 'indented marker kept as written');
  assert.ok(r.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE), 'trailing marker last');
  assert.ok(r.md.length <= STATE_CAP_CHARS);
});

test('SC13 shapeState on the no-heading degrade doc: six required sections ahead of the unmerged heading, marker last, idempotent (also lower-case heading)', () => {
  for (const heading of [UNMERGED_SUMMARY_HEADING, '## unmerged session summary  ']) {
    const md = `${heading}\n\n${'x'.repeat(4000)}\n\n${MARKER_STATE_MERGE_UNAVAILABLE}`;
    const r = shapeState(md, CTX);
    assert.ok(r.md.length <= STATE_CAP_CHARS);
    const p = parseState(r.md);
    assert.deepEqual(p.sections.filter(s => s.required).map(s => s.name), REQUIRED_SECTIONS);
    const unmergedIdx = p.sections.findIndex(s => s.unmerged);
    assert.ok(unmergedIdx >= 0 && p.sections.slice(0, unmergedIdx).filter(s => s.required).length === 6, 'required sections precede the unmerged heading');
    assert.ok(r.md.includes(`${heading}\n`), 'heading line kept as written');
    assert.ok(r.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
    assert.equal(shapeState(r.md, CTX).md, r.md, 'idempotent');
  }
});

test('SC14 fit: a 4000-char unit with no whitespace is hard-cut, <= cap, headings intact, terminates', () => {
  const md = build({ cf: ['x'.repeat(4000)] });
  const r = fit(md);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
  const cf = unitTexts(r.md, 'Current focus')[0];
  assert.ok(cf.startsWith('xxxx') && cf.endsWith(ELL));
});

test('SC15 fit: an unrecognised frontmatter is body (preamble text); a later body --- line does not start one', () => {
  const over = { cf: [text(600)], inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')), decisions: Array.from({ length: 8 }, (_, i) => decision('2026-09-20', 150)) };
  const body = build(over).slice(FM.length); // everything after the (valid) frontmatter
  const variants = {
    unclosed: '---\nschema_version: 1\ntype: state\n',
    oversized: `---\nschema_version: 1\ntitle: ${'t'.repeat(650)}\n---\n`,
    nonKeyLine: '---\nschema_version: 1\nnot a key line\n---\n',
  };
  for (const [name, fm] of Object.entries(variants)) {
    const md = fm + body;
    assert.equal(parseState(md).frontmatter, null, `${name}: no frontmatter recognised`);
    const r = fit(md);
    assert.ok(!/^---\n/.test(r.md) || !r.md.includes('schema_version'), `${name}: the block was trimmed as preamble text`);
    assert.ok(r.trims.some(t => t.heading === '(preamble)'), `${name}: reported as (preamble)`);
    assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
    assert.ok(r.md.length <= STATE_CAP_CHARS);
  }
  const later = build({ ...over, tail: `${UNMERGED_SUMMARY_HEADING}\n---\nkey: value\n---\n${text(200)}\n` });
  const r = fit(later);
  assert.ok(r.md.startsWith(FM), 'the real frontmatter is kept');
  assert.ok(!r.md.includes('\nkey: value\n'), 'the later block was content and went with the foreign region');
});

test('SC16 fit: idempotence', () => {
  const once = fit(BASE_OVER());
  const twice = fit(once.md);
  assert.equal(twice.md, once.md);
  assert.deepEqual(twice.trims, []);
});

test('SC17 fit: determinism', () => {
  const md = BASE_OVER();
  assert.deepEqual(fit(md), fit(md));
});

test('SC18 fit: trims reports canonical / (preamble) / (foreign) names, units and chars, at most 8 entries', () => {
  const md = build({ cf: [text(2800)],
    inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')),
    decisions: Array.from({ length: 8 }, (_, i) => decision(`2026-09-${String(24 - i).padStart(2, '0')}`, 150)),
    next: [text(190)], open: [text(190)], env: [text(190)],
    pre: text(100) + '\n', tail: FOREIGN_TAIL() });
  const r = fit(md);
  const allowed = new Set([...REQUIRED_SECTIONS, '(preamble)', '(foreign)']);
  assert.ok(r.trims.length >= 3 && r.trims.length <= 8);
  for (const t of r.trims) {
    assert.ok(allowed.has(t.heading), `heading ${t.heading}`);
    assert.equal(typeof t.units_dropped, 'number');
    assert.equal(typeof t.chars_cut, 'number');
    assert.ok(t.units_dropped > 0 || t.chars_cut > 0);
  }
  assert.equal(r.trims.filter(t => t.heading === '(foreign)').length, 1, 'one aggregated foreign entry');
  assert.equal(r.trims.filter(t => t.heading === '(preamble)').length, 1);
  const cf = r.trims.find(t => t.heading === 'Current focus');
  assert.ok(cf && cf.units_dropped === 0 && cf.chars_cut > 0, 'a cut reports chars, not units');
  assert.ok(!r.md.includes('What happened'));
});

test('SC19 fit: a single-unit cut of an In-flight unit keeps its trailing stamp', () => {
  const over = build({ cf: [text(600)], inflight: [bullet('long', 1500, '2026-09-20')], decisions: [decision('2026-09-20', 190)], next: [text(190)], open: [text(190)], env: [text(190)] });
  const deficit = over.length - STATE_CAP_CHARS;
  assert.ok(deficit > 0 && deficit < 1500 - UNIT_FLOOR_CHARS, `one cut covers the deficit (${deficit})`);
  const r = fit(over);
  const unit = unitTexts(r.md, 'In flight')[0];
  assert.ok(unit.endsWith(`${ELL} [2026-09-20]`), `stamp re-attached after the ellipsis: ${unit.slice(-30)}`);
  assert.ok(unit.length < 1500);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
});

// ---------------------------------------------------------------------------
// SC20–SC23: ensureRequiredSections
// ---------------------------------------------------------------------------
test('SC20 ensure: all present → identity, added: []', () => {
  const md = build();
  const r = ensureRequiredSections(md);
  assert.equal(r.md, md);
  assert.deepEqual(r.added, []);
});

test('SC21 ensure: a missing middle section is inserted before the trailing marker run, never before a heading, in canonical order; Environment goes after an empty Open questions', () => {
  const noDecisions = FM + '\n' + H1 + '\n' + sec('Current focus', [text(50)]) + sec('In flight', ['- a [2026-09-20]']) + sec('Next actions', ['- n']) + sec('Open questions', ['- q']) + sec('Environment', ['- e'])
    + `\n\n${MARKER_STATE_MERGE_UNAVAILABLE}`;
  const a = ensureRequiredSections(noDecisions);
  assert.deepEqual(a.added, ['Recent decisions']);
  assert.ok(a.md.endsWith(`## Environment\n- e\n## Recent decisions\n(none)\n\n\n${MARKER_STATE_MERGE_UNAVAILABLE}`), a.md.slice(-120));
  assert.ok(a.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
  const endsOpen = FM + '\n' + H1 + '\n' + sec('Current focus', [text(50)]) + sec('In flight', ['- a']) + sec('Recent decisions', ['- 2026-09-20: d']) + sec('Next actions', ['- n']) + '## Open questions\n';
  const b = ensureRequiredSections(endsOpen);
  assert.deepEqual(b.added, ['Environment']);
  assert.ok(b.md.endsWith('## Open questions\n## Environment\n(none)\n'));
  const twoMissing = FM + '\n' + H1 + '\n' + sec('Current focus', [text(50)]) + sec('In flight', ['- a']) + sec('Next actions', ['- n']) + sec('Open questions', ['- q']) + `\n${MARKER_LLM_MERGE_FAILED}\n`;
  const c = ensureRequiredSections(twoMissing);
  assert.deepEqual(c.added, ['Recent decisions', 'Environment']);
  assert.ok(c.md.endsWith(`## Open questions\n- q\n## Recent decisions\n(none)\n## Environment\n(none)\n\n${MARKER_LLM_MERGE_FAILED}\n`), c.md.slice(-150));
});

test('SC22 ensure: no sections at all → all six, marker still last', () => {
  const md = FM + '\n' + H1 + '\n' + text(200) + `\n\n${MARKER_STATE_MERGE_UNAVAILABLE}`;
  const r = ensureRequiredSections(md);
  assert.deepEqual(r.added, REQUIRED_SECTIONS);
  assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
  assert.ok(r.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
  assert.ok(r.md.startsWith(FM + '\n' + H1 + '\n' + text(200)), 'existing text untouched');
});

test('SC23 ensure: case-insensitive match; "## In flight (12)" is foreign; an In flight after the unmerged heading is foreign and the required one is added ahead of it', () => {
  const lower = FM + '\n' + H1 + '\n' + sec('Current focus', ['c']) + sec('in flight', ['- a']) + sec('Recent decisions', ['- 2026-09-20: d']) + sec('Next actions', ['- n']) + sec('Open questions', ['- q']) + sec('Environment', ['- e']);
  assert.deepEqual(ensureRequiredSections(lower).added, []);
  assert.ok(section(lower, 'In flight'), 'parseState reports the lower-case heading as In flight');
  const suffixed = lower.replace('## in flight\n', '## In flight (12)\n');
  const a = ensureRequiredSections(suffixed);
  assert.deepEqual(a.added, ['In flight']);
  assert.ok(a.md.includes('## In flight (12)\n'), 'the foreign heading is untouched');
  const after = FM + '\n' + H1 + '\n' + sec('Current focus', ['c']) + sec('Recent decisions', ['- 2026-09-20: d']) + sec('Next actions', ['- n']) + sec('Open questions', ['- q']) + sec('Environment', ['- e'])
    + `${UNMERGED_SUMMARY_HEADING}\n${text(50)}\n## In flight\n- summary item\n${MARKER_STATE_MERGE_UNAVAILABLE}\n`;
  const b = ensureRequiredSections(after);
  assert.deepEqual(b.added, ['In flight']);
  const p = parseState(b.md);
  const required = p.sections.filter(s => s.required);
  assert.equal(required.length, 6);
  const unmergedIdx = p.sections.findIndex(s => s.unmerged);
  assert.ok(p.sections.findIndex(s => s.required && s.name === 'In flight') < unmergedIdx, 'required In flight sits ahead of the unmerged heading');
  const foreignInFlight = p.sections.filter(s => !s.required && /^## In flight/.test(s.heading));
  assert.equal(foreignInFlight.length, 1);
  assert.ok(b.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
});

// ---------------------------------------------------------------------------
// SC24–SC25: ageInFlight
// ---------------------------------------------------------------------------
test('SC24 age: 14-day ageing before the supplied date; future = later than now + 1 day; delayed chunk; asOf without now throws; invalid dates and continuation stamps are not stamps', () => {
  const md = build({ inflight: [
    '- A aged [2026-09-10]', '- B exactly fourteen [2026-09-11]', '- C unstamped', '- D future [2026-09-27]',
    '- E exactly now plus one [2026-09-26]', '- F invalid [2026-02-31]', '- G continuation\n  sub-line [2026-09-01]',
  ] });
  const r = ageInFlight(md, CTX);
  assert.equal(r.aged, 1);
  assert.equal(r.aged_future, 1);
  const kept = unitTexts(r.md, 'In flight');
  assert.deepEqual(kept.map(u => u.slice(2, 3)), ['B', 'C', 'E', 'F', 'G']);
  assert.ok(kept[4].includes('sub-line [2026-09-01]'), 'continuation line untouched');
  const delayed = build({ inflight: ['- H [2026-09-24]', '- I [2026-09-27]', '- J [2026-08-31]'] });
  const d = ageInFlight(delayed, { asOf: '2026-09-15T00:00:00Z', now: new Date('2026-09-25T00:00:00Z') });
  assert.deepEqual(unitTexts(d.md, 'In flight'), ['- H [2026-09-24]']);
  assert.equal(d.aged, 1);
  assert.equal(d.aged_future, 1);
  assert.throws(() => ageInFlight(md, { asOf: AS_OF }), TypeError);
});

test('SC25 age: no asOf → identity', () => {
  const md = build({ inflight: ['- A [2026-01-01]', '- B [2030-01-01]'] });
  const r = ageInFlight(md);
  assert.equal(r.md, md);
  assert.equal(r.aged, 0);
  assert.equal(r.aged_future, 0);
  const n = ageInFlight(md, { now: NOW });
  assert.equal(n.md, md);
});

// ---------------------------------------------------------------------------
// SC26–SC29: applySectionLimits
// ---------------------------------------------------------------------------
test('SC26 limits: In flight 12 → 8 keeping the 8 newest stamps, unstamped first; a delayed chunk never evicts a later stamp', () => {
  const stamps = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'];
  const units = [bullet('u1', 60), ...stamps.slice(0, 5).map((s, i) => bullet(`s${i}`, 60, s)), bullet('u2', 60), ...stamps.slice(5).map((s, i) => bullet(`t${i}`, 60, s))];
  const md = build({ inflight: units });
  const r = applySectionLimits(md, CTX);
  const kept = unitTexts(r.md, 'In flight');
  assert.equal(kept.length, 8);
  assert.ok(kept.every(u => /\]$/.test(u)), 'unstamped went first');
  assert.deepEqual(kept.map(u => u.slice(-11, -1)), stamps.slice(2), 'the 8 newest stamps, in original order');
  assert.deepEqual(r.bounded, [{ heading: 'In flight', dropped: 4 }]);
  const nine = build({ inflight: ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-24', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'].map((s, i) => bullet(`n${i}`, 60, s)) });
  const d = applySectionLimits(nine, { asOf: '2026-09-15T00:00:00Z', now: new Date('2026-09-25T00:00:00Z') });
  const keptNine = unitTexts(d.md, 'In flight').map(u => u.slice(-11, -1));
  assert.equal(keptNine.length, 8);
  assert.ok(keptNine.includes('2026-09-24'));
  assert.ok(!keptNine.includes('2026-09-16'));
});

test('SC27 limits: Recent decisions 10 → 8 keeping the 8 largest dates; a date later than now + 1 counts as undated and goes first; delayed chunk', () => {
  const dates = ['2026-09-24', '2026-09-23', '2026-09-22', '2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18', '2026-09-17', '2026-09-16', '2026-09-15'];
  const md = build({ decisions: dates.map(d => decision(d, 60)) });
  const r = applySectionLimits(md, CTX);
  assert.deepEqual(unitTexts(r.md, 'Recent decisions').map(u => u.slice(2, 12)), dates.slice(0, 8));
  assert.deepEqual(r.bounded, [{ heading: 'Recent decisions', dropped: 2 }]);
  const withFuture = build({ decisions: [...dates.slice(0, 4), decision('2027-01-01', 60), ...dates.slice(4, 8).map(d => decision(d, 60))].map(d => typeof d === 'string' ? decision(d, 60) : d) });
  const f = applySectionLimits(withFuture, CTX);
  const keptF = unitTexts(f.md, 'Recent decisions').map(u => u.slice(2, 12));
  assert.equal(keptF.length, 8);
  assert.ok(!keptF.includes('2027-01-01'), 'the future-dated entry went first');
  const delayed = build({ decisions: ['2026-09-16', '2026-09-17', '2026-09-24', '2026-09-27', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'].map(d => decision(d, 60)) });
  const d = applySectionLimits(delayed, { asOf: '2026-09-15T00:00:00Z', now: new Date('2026-09-25T00:00:00Z') });
  const keptD = unitTexts(d.md, 'Recent decisions').map(u => u.slice(2, 12));
  assert.equal(keptD.length, 8);
  assert.ok(keptD.includes('2026-09-24'), '09-24 is dated and kept');
  assert.ok(!keptD.includes('2026-09-27'), '09-27 is undated and went first');
});

test('SC28 limits: Next actions and Open questions from the top, Environment from the tail; blank units and (none) go first and do not count', () => {
  const md = build({
    next: ['', '(none)', ...Array.from({ length: 7 }, (_, i) => `- n${i + 1}`)],
    open: Array.from({ length: 7 }, (_, i) => `- q${i + 1}`),
    env: Array.from({ length: 5 }, (_, i) => `- e${i + 1}`),
  });
  const r = applySectionLimits(md, CTX);
  assert.deepEqual(unitTexts(r.md, 'Next actions'), ['- n2', '- n3', '- n4', '- n5', '- n6', '- n7']);
  assert.deepEqual(unitTexts(r.md, 'Open questions'), ['- q3', '- q4', '- q5', '- q6', '- q7']);
  assert.deepEqual(unitTexts(r.md, 'Environment'), ['- e1', '- e2', '- e3']);
  assert.deepEqual(r.bounded.map(b => b.heading), ['Next actions', 'Open questions', 'Environment']);
  assert.equal(r.bounded[0].dropped, 3);
  const within = build({ next: ['(none)', '- n1', '- n2', '- n3', '- n4', '- n5', '- n6'] });
  assert.equal(applySectionLimits(within, CTX).md, within, 'a placeholder does not count toward the limit');
});

test('SC29 limits: within limits → identity, bounded: []', () => {
  const md = build({
    inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 60, `2026-09-${String(14 + i).padStart(2, '0')}`)),
    decisions: Array.from({ length: 8 }, (_, i) => decision(`2026-09-${String(24 - i).padStart(2, '0')}`, 60)),
    next: Array.from({ length: 6 }, (_, i) => `- n${i}`), open: Array.from({ length: 5 }, (_, i) => `- q${i}`), env: ['- e1', '- e2', '- e3'],
  });
  const r = applySectionLimits(md, CTX);
  assert.equal(r.md, md);
  assert.deepEqual(r.bounded, []);
});

// ---------------------------------------------------------------------------
// SC30–SC46: shapeState, fit edge cases, parseState, preconditions
// ---------------------------------------------------------------------------
test('SC30 shapeState: order ensure → age → limits → fit, and the report shape', () => {
  const md = FM + '\n' + H1 + '\n' + sec('Current focus', [text(2800)])
    + sec('In flight', ['- old [2026-08-01]', ...Array.from({ length: 10 }, (_, i) => bullet(`i${i}`, 80, `2026-09-${String(12 + i).padStart(2, '0')}`))])
    + sec('Recent decisions', [decision('2026-09-20', 80)]) + sec('Next actions', ['- n']) + sec('Open questions', ['- q']);
  const r = shapeState(md, CTX);
  assert.deepEqual(Object.keys(r.report).sort(), ['added', 'aged', 'aged_future', 'bounded', 'trims'].sort());
  assert.deepEqual(r.report.added, ['Environment']);
  assert.equal(r.report.aged, 1);
  assert.equal(r.report.aged_future, 0);
  assert.deepEqual(r.report.bounded, [{ heading: 'In flight', dropped: 2 }]);
  assert.ok(r.report.trims.length > 0);
  const manual = fitStateToCap(applySectionLimits(ageInFlight(ensureRequiredSections(md).md, CTX).md, CTX).md, { cap: STATE_CAP_CHARS, ...CTX });
  assert.equal(r.md, manual.md, 'shapeState equals the four steps in sequence');
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  assert.equal(shapeState(r.md, CTX).md, r.md, 'idempotent');
});

test('SC31 fit: a Current focus whose last whitespace falls at index 600 terminates with the paragraph <= 600 and the doc <= cap', () => {
  const cf = 'a'.repeat(600) + ' ' + 'b'.repeat(1900);
  const md = build({ cf: [cf], inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')),
    decisions: Array.from({ length: 8 }, (_, i) => decision(`2026-09-${String(24 - i).padStart(2, '0')}`, 200)) });
  assert.ok(md.length - STATE_CAP_CHARS > cf.length - CURRENT_FOCUS_CEIL_CHARS, 'the deficit is still positive after a cut to the ceiling');
  const r = fit(md);
  const out = unitTexts(r.md, 'Current focus')[0];
  assert.ok(out.length <= CURRENT_FOCUS_CEIL_CHARS, `paragraph ${out.length}`);
  assert.ok(out.endsWith(ELL));
  assert.ok(r.md.length <= STATE_CAP_CHARS);
});

test('SC32 fit: after every unit is exhausted the remaining units are removed one at a time until <= cap; the skeleton is intact', () => {
  const md = build({ cf: [text(190)], inflight: [bullet('a', 190, '2026-09-20')], decisions: [decision('2026-09-20', 190)], next: [text(190)], open: [text(190)], env: [text(190)] });
  const cap = 1200;
  assert.ok(md.length > cap && md.length < cap + 2 * 191, `deficit needs two whole-unit removals (${md.length})`);
  const r = fitStateToCap(md, { cap, ...CTX });
  assert.ok(r.md.length <= cap);
  assertSkeletonInOrder(r.md);
  assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
  assert.equal(unitTexts(r.md, 'Recent decisions').length, 0, 'first in value order emptied');
  assert.equal(unitTexts(r.md, 'Environment').length, 0, 'second in value order emptied');
  assert.equal(unitTexts(r.md, 'In flight').length, 1);
  assert.equal(unitTexts(r.md, 'Current focus').length, 1);
});

test('SC33 fit: continuations go first, then the cut; chars_cut reconciles exactly (continuation-only shape; step-2 shape)', () => {
  // (i) an In-flight unit with 2.5k of indented sub-bullets loses its continuations first, then is cut
  const subs = Array.from({ length: 100 }, (_, i) => `  - sub ${String(i).padStart(2, '0')}: ${text(13)}`);
  const first = bullet('big', 2013, '2026-09-20');
  const md = build({ cf: [text(100)], inflight: [[first, ...subs].join('\n')], decisions: [decision('2026-09-20', 100)], next: [text(2100)], open: [text(100)], env: [text(100)] });
  const contChars = subs.reduce((n, l) => n + l.length, 0);
  assert.ok(contChars >= 2500);
  assert.ok(md.length - STATE_CAP_CHARS > contChars + (2000 - UNIT_FLOOR_CHARS), 'the deficit forces the first-line cut too');
  const r = fit(md);
  const unit = unitTexts(r.md, 'In flight')[0];
  assert.ok(!unit.includes('\n'), 'continuations gone');
  assert.ok(unit.endsWith(`${ELL} [2026-09-20]`), 'first line cut, stamp re-attached');
  const keptPrefix = unit.length - ELL.length - ' [2026-09-20]'.length;
  const t = r.trims.find(x => x.heading === 'In flight');
  assert.equal(t.units_dropped, 0);
  assert.equal(t.chars_cut, contChars + (2000 - keptPrefix), 'chars_cut = continuations + first-line text cut (stamp and ellipsis not counted)');
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  // (ii) a Recent-decisions unit whose continuation alone covers the deficit keeps its first line byte-identical, no ellipsis
  const firstLine = '- 2023-10-06: Kept decision.';
  const cont = '  ' + 'x'.repeat(3100);
  const md2 = build({ cf: [text(100)], inflight: [bullet('a', 100, '2026-09-20')], decisions: [`${firstLine}\n${cont}`], next: [text(100)], open: [text(100)], env: [text(100)] });
  assert.ok(md2.length > STATE_CAP_CHARS && md2.length - STATE_CAP_CHARS < cont.length);
  const r2 = fit(md2);
  assert.deepEqual(unitTexts(r2.md, 'Recent decisions'), [firstLine]);
  const t2 = r2.trims.find(x => x.heading === 'Recent decisions');
  assert.deepEqual(t2, { heading: 'Recent decisions', units_dropped: 0, chars_cut: cont.length });
  // (iii) when step 2 also runs, chars_cut = continuation + first line length − kept prefix
  const long = `- 2026-09-20: ${text(986)}`; // 1000 chars
  const cont3 = '  ' + text(498); // 500 chars
  const md3 = build({ cf: [text(100)], inflight: [bullet('a', 100, '2026-09-20')], decisions: [`${long}\n${cont3}`], next: [text(1500)], open: [text(100)], env: [text(100)] });
  const deficit3 = md3.length - STATE_CAP_CHARS;
  assert.ok(deficit3 > cont3.length + 1 && deficit3 < cont3.length + 1 + (1000 - UNIT_FLOOR_CHARS), `deficit forces a first-line cut (${deficit3})`);
  const r3 = fit(md3);
  const out3 = unitTexts(r3.md, 'Recent decisions')[0];
  assert.ok(out3.endsWith(ELL) && !out3.includes('\n'));
  const kept3 = out3.length - ELL.length;
  assert.ok(long.startsWith(out3.slice(0, kept3)), 'the kept part is a prefix of the first line');
  const t3 = r3.trims.find(x => x.heading === 'Recent decisions');
  assert.equal(t3.chars_cut, cont3.length + (long.length - kept3));
});

test('SC34 fit: a 60k-char repetition doc (2k units) is shaped in under 1 s, <= cap, skeleton in order', () => {
  const md = build({ inflight: Array.from({ length: 2000 }, (_, i) => bullet(`r${i}`, 30, '2026-09-20')), tail: `\n${MARKER_STATE_MERGE_UNAVAILABLE}` });
  assert.ok(md.length >= 60000);
  const t0 = performance.now();
  const r = fit(md);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  assertSkeletonInOrder(r.md);
  assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
  assert.ok(r.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
});

test('SC35 fit: a 3.5k single-line HTML comment (not a marker) is content and is cut like any unit', () => {
  const comment = `<!-- ${text(3490)} -->`;
  const md = build({ cf: [comment] });
  const r = fit(md);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  const cf = unitTexts(r.md, 'Current focus')[0];
  assert.ok(cf.startsWith('<!-- ') && cf.endsWith(ELL) && cf.length < comment.length);
});

test('SC36 shapeState: 30 accumulated degrade blocks (built by accumulation, each with a required-named ## In flight line) → <= cap, marker last, six required ahead of the first unmerged heading', () => {
  let md = build({ inflight: ['- a [2026-09-20]'] });
  for (let i = 0; i < 30; i++) {
    md = md + `\n\n${UNMERGED_SUMMARY_HEADING}\n\n${text(300)}\n\n## In flight\n- summary item ${i}\n\n${MARKER_STATE_MERGE_UNAVAILABLE}`;
    md = shapeState(md, CTX).md;
    assert.ok(md.length <= STATE_CAP_CHARS, `block ${i}: ${md.length}`);
    assert.ok(md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE), `block ${i}: marker last`);
    const p = parseState(md);
    assert.deepEqual(p.sections.filter(s => s.required).map(s => s.name), REQUIRED_SECTIONS, `block ${i}`);
    const unmergedIdx = p.sections.findIndex(s => s.unmerged);
    assert.ok(unmergedIdx > 0 && p.sections.slice(0, unmergedIdx).filter(s => s.required).length === 6, `block ${i}: required ahead of the first unmerged heading`);
  }
  assert.equal(unitTexts(md, 'In flight')[0], '- a [2026-09-20]', 'the real In flight never absorbed a summary item');
});

test('SC37 fit: a CRLF document — frontmatter recognised, stamps read, CRs preserved on untouched lines, String.length <= 3000', () => {
  const lf = build({ cf: [text(600)], inflight: [...STAMPS12.map((s, i) => bullet(String.fromCharCode(65 + i), 150, s)), '- old one [2026-08-01]'], decisions: [decision('2026-09-20', 190)], next: [text(190)], open: [text(190)], env: [text(100)] });
  const md = lf.replace(/\n/g, '\r\n');
  const p = parseState(md);
  assert.ok(p.frontmatter, 'frontmatter recognised');
  assert.equal(section(md, 'In flight').units.at(-1).stamp, '2026-08-01', 'stamp read despite the CR');
  const aged = ageInFlight(md, CTX);
  assert.equal(aged.aged, 1);
  const r = fit(md);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  assert.ok(r.md.startsWith(FM.replace(/\n/g, '\r\n')), 'CRs preserved on the frontmatter');
  for (const n of REQUIRED_SECTIONS) assert.ok(r.md.includes(`## ${n}\r\n`), `${n} heading keeps its CR`);
  assert.ok(!/[^\r]\n/.test(r.md.slice(0, r.md.indexOf('## In flight'))), 'no bare LF introduced before the trimmed section');
});

test('SC38 effectiveAsOf: a year ahead → now; 1970 → now − 14 d; garbage → now; absent → now', () => {
  const now = new Date('2026-09-25T12:00:00.000Z');
  assert.equal(effectiveAsOf('2027-09-25T12:00:00.000Z', now), now.toISOString());
  assert.equal(effectiveAsOf('1970-01-01T00:00:00Z', now), '2026-09-11T12:00:00.000Z');
  assert.equal(effectiveAsOf('not a date', now), now.toISOString());
  assert.equal(effectiveAsOf(undefined, now), now.toISOString());
  assert.equal(effectiveAsOf('2026-09-20T00:00:00Z', now), '2026-09-20T00:00:00.000Z', 'inside the window: unchanged');
  assert.equal(effectiveAsOf(new Date('2026-09-20T00:00:00Z'), now.toISOString()), '2026-09-20T00:00:00.000Z', 'Dates and ISO strings both accepted');
});

test('SC39 fit: foreign sections are removed last-in-document first, preamble text before them', () => {
  const md = build({ cf: [text(600)], inflight: Array.from({ length: 8 }, (_, i) => bullet(String(i), 150, '2026-09-20')), decisions: Array.from({ length: 2 }, (_, i) => decision('2026-09-20', 150)),
    pre: `${text(100)}\n${text(100)}\n`,
    tail: `## Alpha\n${text(100)}\n${text(100)}\n${text(100)}\n## Beta\n${text(100)}\n${text(100)}\n` });
  const deficit = md.length - STATE_CAP_CHARS;
  const preAndBeta = 202 + '## Beta\n'.length + 202;
  assert.ok(deficit > preAndBeta && deficit <= preAndBeta + 101, `deficit removes preamble + Beta + one Alpha unit (${deficit})`);
  const r = fit(md);
  assert.equal(parseState(r.md).preamble.units.filter(u => !u.blank).length, 0, 'preamble text gone');
  assert.ok(!r.md.includes('## Beta'), 'Beta (later) gone, heading included');
  const alpha = parseState(r.md).sections.find(s => s.heading === '## Alpha');
  assert.ok(alpha, 'Alpha (earlier) still there');
  assert.equal(alpha.units.length, 2 + 1, 'Alpha lost exactly its last unit (heading line counts as its last unit)');
  assert.ok(r.md.length <= STATE_CAP_CHARS);
});

test('SC40 fit: 60k of blank lines after a heading → <= cap, terminates, skeleton intact', () => {
  const md = build({ inflight: ['\n'.repeat(59999)] });
  assert.ok(md.length > 60000);
  const r = fit(md);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
  assertSkeletonInOrder(r.md);
});

test('SC41 fit: a loose nested list (- a, blank, 200 × "  - b") → every sub-bullet is in a unit, <= cap, terminates', () => {
  const loose = ['- a', '', ...Array.from({ length: 200 }, (_, i) => `  - b${i} ${text(20)}`)].join('\n');
  const md = build({ inflight: [loose] });
  const units = section(md, 'In flight').units;
  assert.equal(units.length, 1, 'one unit');
  assert.equal(units[0].lines.length, 202, 'every sub-bullet in it');
  const r = fit(md);
  assert.ok(r.md.length <= STATE_CAP_CHARS);
  assert.deepEqual(requiredNames(r.md), REQUIRED_SECTIONS);
});

test('SC42 fit: a marker copy indented by 3k spaces is content (before or after the real marker); the real marker survives as the last line', () => {
  const padded = ' '.repeat(3000) + MARKER_STATE_MERGE_UNAVAILABLE;
  const before = build({ tail: `${UNMERGED_SUMMARY_HEADING}\n${padded}\n${text(100)}\n${MARKER_STATE_MERGE_UNAVAILABLE}` });
  const a = fit(before);
  assert.ok(!a.md.includes(padded));
  assert.ok(a.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
  assert.ok(a.md.length <= STATE_CAP_CHARS);
  const after = build({ tail: `${UNMERGED_SUMMARY_HEADING}\n${text(100)}\n${MARKER_STATE_MERGE_UNAVAILABLE}\n${padded}` });
  const b = fit(after);
  assert.ok(!b.md.includes(padded));
  assert.ok(b.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
  assert.ok(b.md.length <= STATE_CAP_CHARS);
});

test('SC43 fit: a decision dated a year after now is removed first in phase 3; a delayed chunk keeps 09-24; with neither asOf nor now, date order', () => {
  const dates = ['2026-09-24', '2026-09-23', '2026-09-22', '2027-09-25', '2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18'];
  const md = build({ cf: [text(600)], inflight: [bullet('a', 190, '2026-09-20')], decisions: dates.map(d => decision(d, 200)), next: [text(190)], open: [text(190)], env: [text(100)] });
  const deficit = md.length - STATE_CAP_CHARS;
  assert.ok(deficit > 0 && deficit <= 201, `one removal (${deficit})`);
  const r = fit(md);
  const kept = unitTexts(r.md, 'Recent decisions').map(u => u.slice(2, 12));
  assert.equal(kept.length, 7);
  assert.ok(!kept.includes('2027-09-25'), 'the future-dated entry went first');
  const delayed = fitStateToCap(md, { cap: STATE_CAP_CHARS, asOf: '2026-09-15T00:00:00Z', now: new Date('2026-09-25T00:00:00Z') });
  const keptD = unitTexts(delayed.md, 'Recent decisions').map(u => u.slice(2, 12));
  assert.ok(keptD.includes('2026-09-24') && !keptD.includes('2027-09-25'));
  const neither = fitStateToCap(md, { cap: STATE_CAP_CHARS });
  const keptN = unitTexts(neither.md, 'Recent decisions').map(u => u.slice(2, 12));
  assert.ok(keptN.includes('2027-09-25'), 'with no clock the year-ahead date is just the largest date');
  assert.ok(!keptN.includes('2026-09-18'), 'the smallest date went instead');
});

test('SC44 parseState: every content line is in exactly one unit; a skeleton line inside a span is skipped; sub-bullets do not add units; a loose list is one unit', () => {
  const md = build({
    cf: ['Focus paragraph.', '', 'Second paragraph.'],
    inflight: ['- one\n  - sub a\n  - sub b', `- two\n  ${MARKER_LLM_MERGE_FAILED}\n  - sub c`, '- three'],
    decisions: ['- 2026-09-20: d\n  more'],
    next: ['- a', '', ...Array.from({ length: 3 }, (_, i) => `  - b${i}`)].map(String),
    pre: `${text(40)}\n\n${text(40)}\n`,
    tail: `${UNMERGED_SUMMARY_HEADING}\n${text(40)}\n\n<!-- plain comment -->\n${MARKER_STATE_MERGE_UNAVAILABLE}`,
  });
  const p = parseState(md);
  const allLines = md.split('\n');
  const skeleton = new Set([...FM_LINES, H1, ...REQUIRED_SECTIONS.map(n => `## ${n}`), `  ${MARKER_LLM_MERGE_FAILED}`, MARKER_STATE_MERGE_UNAVAILABLE]);
  const contentCount = allLines.filter(l => !skeleton.has(l)).length;
  const units = [...p.preamble.units, ...p.sections.flatMap(s => s.units)];
  const unitLines = units.reduce((n, u) => n + u.lines.length, 0);
  const foreignHeadingLines = p.sections.filter(s => !s.required).length; // a foreign heading line is its section's last unit
  assert.equal(unitLines, contentCount, 'every content line is in exactly one unit (foreign heading lines included)');
  assert.equal(foreignHeadingLines, 1);
  const inflight = section(md, 'In flight').units;
  assert.equal(inflight.length, 3, 'bullet count, not line count');
  assert.ok(!inflight[1].lines.includes(`  ${MARKER_LLM_MERGE_FAILED}`), 'the skeleton line inside the span is skipped');
  assert.deepEqual(inflight[1].lines, ['- two', '  - sub c']);
  assert.equal(section(md, 'Next actions').units.length, 1, 'a loose nested list is ONE unit');
  assert.equal(section(md, 'Current focus').units.length, 2);
  assert.equal(p.h1, H1);
  assert.equal(p.frontmatter.lines.length, FM_LINES.length);
});

test('SC45 preconditions: cap < 1200 → RangeError from fit and shapeState; cap = 1200 on a skeleton-only doc is unchanged; asOf without now → TypeError everywhere', () => {
  const md = build();
  assert.throws(() => fitStateToCap(md, { cap: 1199, ...CTX }), RangeError);
  assert.throws(() => shapeState(md, { cap: 1199, ...CTX }), RangeError);
  const skeleton = FM + '\n' + H1 + '\n' + REQUIRED_SECTIONS.map(n => `## ${n}\n`).join('') + MARKER_STATE_MERGE_UNAVAILABLE + '\n';
  const r = fitStateToCap(skeleton, { cap: 1200, ...CTX });
  assert.equal(r.md, skeleton);
  assert.deepEqual(r.trims, []);
  for (const fn of [ageInFlight, applySectionLimits, fitStateToCap, shapeState]) {
    assert.throws(() => fn(md, { asOf: AS_OF }), TypeError, fn.name);
  }
});

test('SC46 shapeState: the only ## In flight between two unmerged headings — scaffold ahead of the first, phase 1 removes the last block only, six required, inner In flight foreign, idempotent', () => {
  const head = FM + '\n' + H1 + '\n' + sec('Current focus', [text(300)]) + sec('Recent decisions', [decision('2026-09-20', 100)]) + sec('Next actions', ['- n']) + sec('Open questions', ['- q']) + sec('Environment', ['- e']);
  const block1 = `${UNMERGED_SUMMARY_HEADING}\n${text(400)}\n## In flight\n- foreign item\n`;
  const block2 = `${UNMERGED_SUMMARY_HEADING}\n${text(1900)}\n${MARKER_STATE_MERGE_UNAVAILABLE}\n`;
  const md = head + block1 + block2;
  const scaffolded = ensureRequiredSections(md).md;
  const deficit = scaffolded.length - STATE_CAP_CHARS;
  assert.ok(deficit > 0 && deficit < 1900, `over the cap by less than the last block (${deficit})`);
  const r = shapeState(md, CTX);
  assert.deepEqual(r.report.added, ['In flight']);
  assert.ok(r.md.includes(text(400)) && r.md.includes('- foreign item'), 'the first block survives');
  assert.ok(!r.md.includes(text(1900)), 'the last block was removed');
  const p = parseState(r.md);
  assert.deepEqual(p.sections.filter(s => s.required).map(s => s.name).sort(), [...REQUIRED_SECTIONS].sort(), 'six required sections (document order: the scaffold sits after Environment)');
  const inner = p.sections.filter(s => !s.required && s.heading === '## In flight');
  assert.equal(inner.length, 1, 'the inner In flight is foreign');
  assert.ok(p.sections.findIndex(s => s.required && s.name === 'In flight') < p.sections.findIndex(s => s.unmerged));
  assert.equal(shapeState(r.md, CTX).md, r.md, 'idempotent');
  assert.ok(r.md.trimEnd().endsWith(MARKER_STATE_MERGE_UNAVAILABLE));
});
