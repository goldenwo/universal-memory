// server/test/control-page.test.mjs — U4a (#171 Stage B): the operator page's
// shell, ops row and capture-freshness tile, plus the pure verdict function the
// cron check must agree with.
//
// Acceptance discharged here (spec §8):
//   • A6  — hostile surface names render inert AS MAP KEYS (element text only;
//           nothing untrusted ever reaches an attribute value).
//   • A11 — parse-based no-active-content assertion on the RENDERED string.
//   • A12 — the page↔cron cross-check: one fixture table, fed to BOTH the pure
//           captureVerdict() and the SHIPPED um-alert.sh python (invoked for
//           real, MOCK_BIN curl, no --max-age-hours so the payload-threshold
//           path is the one under test). Verdict ≡ exit code, per fixture.
//   • A17 — both predicates rendered; the four payload states map exactly.
//   • A23 — the "active but landing nothing" red rule, and the deduped:1
//           control that must stay green, with the aggregate line unchanged.
//   • A24 — the one-shot legend is STATIC: no surface-name branch anywhere.
//
// Everything the page renders is a pure function of the payload — no clock, no
// env — so every case here is a plain object in, a string out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderControlPage, captureVerdict, BRAND_LOCKUP_SVG, brandCss } from '../lib/control-page.mjs';
import { renderConsentPage } from '../lib/oauth/consent.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const CSRF = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';

const CONTROL_PAGE_SRC = fileURLToPath(new URL('../lib/control-page.mjs', import.meta.url));
const UM_ALERT = fileURLToPath(
  new URL('../../plugins/claude-code/universal-memory/bin/um-alert.sh', import.meta.url),
);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function surface({
  last_day_seen = '2026-07-28',
  freshness_hours = 0,
  events_today = 4,
  errors_today = 0,
  stored = 3,
  abstained = 0,
  deduped = 0,
  superseded = 0,
  error = 0,
  // spec §7 (2026-08-15 instrumented-truth fix): outcomes_7d's 6th key, and
  // the additive turns_7d volume label riding alongside it.
  failed = 0,
  turns_7d = 0,
} = {}) {
  return {
    last_day_seen,
    freshness_hours,
    events_today,
    errors_today,
    outcomes_7d: {
      stored, abstained, deduped, superseded, error, failed,
    },
    turns_7d,
  };
}

// A complete buildStats()-shaped payload. `capture` is passed explicitly by
// every test so the four payload states are always written out in full.
function makeStats(overrides = {}) {
  return {
    schema_version: 1,
    generated_at: '2026-07-28T12:00:00.000Z',
    capture_freshness_threshold_hours: 26,
    server: {
      version: '1.10.2',
      uptime_s: 11532,
      writes_enabled: true,
      mount_mode: 'rw',
    },
    corpus: {
      points: 270,
      points_by_project: { 'universal-memory': 200, '(unknown)': 70 },
      scan_saturated: false,
      growth_7d: {},
      growth_docs_7d: {},
      derived_from: 'extraction-counters',
    },
    capture: { 'claude-code-plugin': surface() },
    // Task 10 (spec §6): real payloads carry `layers` unconditionally (even
    // as `{}`) from this version forward — the empty, healthy default here
    // mirrors that so pre-existing fixtures that don't care about layers get
    // the quiet "no projects with captures yet" state, not a false
    // "cannot assess" banner from an absent key a real server never omits.
    layers: {},
    recall: {
      searches_today: 3,
      searches_7d: 20,
      latency_since_boot: { p50_ms: 40, p95_ms: 120, n: 12, label: 'serving latency' },
    },
    ...overrides,
  };
}

const render = (stats) => renderControlPage({ stats, nonce: NONCE, csrf: CSRF });

// ---------------------------------------------------------------------------
// A tiny HTML tag scanner — A11 must be PARSE-based, not a whole-document
// regex. Untrusted text is entity-escaped, so `<` can only ever come from the
// template itself; scanning `<…>` regions therefore sees exactly the real tags.
// A raw-document regex would false-positive on a hostile surface NAME rendered
// (harmlessly) as text, e.g. `x onerror=alert(1)` — which is precisely the
// payload A6 requires the page to render.
// ---------------------------------------------------------------------------

function scanTags(html) {
  const tags = [];
  const re = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let m;
  while ((m = re.exec(html)) !== null) tags.push({ name: m[1].toLowerCase(), attrs: m[2] });
  return tags;
}

function attrPairs(attrs) {
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(attrs)) !== null) out.push([m[1].toLowerCase(), m[2]]);
  return out;
}

function styleBlocks(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

// U4b: scopes an assertion to one <h2>-headed <section class="tile"> so a
// hostile-string test can check "this tile" without accidentally matching
// escaped text a NEIGHBOURING tile happens to render.
function sectionByHeading(html, heading) {
  const re = new RegExp(`<h2>${heading}</h2>([\\s\\S]*?)</section>`);
  const m = re.exec(html);
  assert.ok(m, `section "${heading}" found`);
  return m[1];
}

// U4b: a null-prototype map built via bracket assignment, exactly like the
// real `points_by_project`/`capture` buildStats() emits (Object.create(null)
// — PR #177) — so `__proto__`/`constructor` land as ordinary OWN properties
// instead of hitting an inherited accessor or value.
function hostileMap(pairs) {
  const m = Object.create(null);
  for (const [k, v] of pairs) m[k] = v;
  return m;
}

// The shared A11 sweep — U4b extends the fixtures it runs over, not this body.
function assertNoActiveContent(html, label) {
  assert.doesNotMatch(html, /<script/i, `${label}: no <script>`);
  const tags = scanTags(html);
  assert.ok(tags.length > 10, `${label}: the scanner actually found tags`);
  for (const { name, attrs } of tags) {
    assert.notEqual(name, 'script', `${label}: no script element`);
    // Every attribute value is FULLY double-quoted (esc() is only sound there
    // and in element text — an unquoted value breaks out on whitespace).
    const withoutValues = attrs.replace(/"[^"]*"/g, '""');
    assert.doesNotMatch(withoutValues, /=\s*(?!")/, `${label}: <${name}> has an unquoted attribute value`);
    for (const [attr, value] of attrPairs(attrs)) {
      assert.doesNotMatch(attr, /^on/, `${label}: <${name}> carries an on* handler (${attr})`);
      assert.notEqual(attr, 'style', `${label}: <${name}> carries a style= attribute (the CSP nonce does not cover them)`);
      if (attr === 'src') {
        assert.equal(value, '/favicon.svg', `${label}: unexpected src= ${value}`);
      }
      if (attr === 'href') {
        assert.ok(
          value === '/favicon.svg' || value === '/control' || value.startsWith('#'),
          `${label}: unexpected href ${value}`,
        );
      }
      if (attr === 'action') {
        assert.match(value, /^\/control(\/unlock|\/logout)?$/, `${label}: unexpected form action ${value}`);
      }
    }
  }
  const styles = styleBlocks(html);
  assert.equal(styles.length, 1, `${label}: exactly one inline <style> block`);
  assert.doesNotMatch(styles[0], /@import/i, `${label}: no CSS @import`);
  assert.doesNotMatch(styles[0], /url\(/i, `${label}: no url() in CSS`);
  assert.doesNotMatch(styles[0], /</, `${label}: nothing tag-shaped inside the raw-text <style> block`);
}

// ---------------------------------------------------------------------------
// captureVerdict — the pure function A12 cross-checks (unit half of A17)
// ---------------------------------------------------------------------------

test('A17 (unit): captureVerdict maps the four payload states exactly', () => {
  // capture: null (+ counters-unavailable) ⇒ ERROR / grey.
  assert.deepEqual(
    { verdict: captureVerdict(null, 26).verdict, state: captureVerdict(null, 26).state },
    { verdict: 'ERROR', state: 'grey' },
  );
  assert.equal(captureVerdict(undefined, 26).verdict, 'ERROR');
  // capture: {} (db present, no capture.% rows) ⇒ STALE / red — NOT neutral.
  const never = captureVerdict({}, 26);
  assert.equal(never.verdict, 'STALE');
  assert.equal(never.state, 'red');
  assert.equal(never.reason, 'never-written');
  // min(freshness) <= threshold ⇒ FRESH / green.
  const fresh = captureVerdict({ a: surface({ freshness_hours: 26 }), b: surface({ freshness_hours: 99 }) }, 26);
  assert.equal(fresh.verdict, 'FRESH');
  assert.equal(fresh.state, 'green');
  assert.equal(fresh.surface, 'a', 'the min() quantifier picks the freshest surface');
  // min(freshness) > threshold ⇒ STALE / red.
  const stale = captureVerdict({ a: surface({ freshness_hours: 150.5 }), b: surface({ freshness_hours: 26.1 }) }, 26);
  assert.equal(stale.verdict, 'STALE');
  assert.equal(stale.surface, 'b', 'the freshest surface is still the one named');
});

test('A17 (unit): captureVerdict mirrors the cron parser on shape/threshold edges', () => {
  // A non-dict capture is a shape error, not staleness (um-alert exits 2).
  assert.equal(captureVerdict([], 26).verdict, 'ERROR');
  assert.equal(captureVerdict('nope', 26).verdict, 'ERROR');
  // One unusable freshness value poisons the whole verdict — python's
  // min(key=float) raises on the first bad surface it touches.
  assert.equal(captureVerdict({ a: surface({ freshness_hours: 'x' }) }, 26).verdict, 'ERROR');
  assert.equal(captureVerdict({ a: { last_day_seen: '2026-07-28' } }, 26).verdict, 'ERROR');
  assert.equal(captureVerdict({ a: 5 }, 26).verdict, 'ERROR');
  assert.equal(
    captureVerdict({ ok: surface({ freshness_hours: 0 }), bad: surface({ freshness_hours: null }) }, 26).verdict,
    'ERROR',
    'a bad surface anywhere in the map is an ERROR, not a min() that ignores it',
  );
  // A deliberate threshold of 0 is honored (never coerced to the fallback).
  assert.equal(captureVerdict({ a: surface({ freshness_hours: 0 }) }, 0).verdict, 'FRESH');
  assert.equal(captureVerdict({ a: surface({ freshness_hours: 0.5 }) }, 0).verdict, 'STALE');
  // Absent/garbage threshold falls back to 26, exactly as the cron python does
  // for an old server that never emitted the field.
  assert.equal(captureVerdict({ a: surface({ freshness_hours: 26 }) }, undefined).verdict, 'FRESH');
  assert.equal(captureVerdict({ a: surface({ freshness_hours: 26.1 }) }, undefined).verdict, 'STALE');
  assert.equal(captureVerdict({ a: surface({ freshness_hours: 26 }) }, 'nonsense').verdict, 'FRESH');
});

// Every row is a MEASURED python `float()` result (see the pyFloat table in
// control-page.mjs); the same inputs also go through A12, where the real script
// adjudicates rather than this table asserting what python "probably" does.
test('captureVerdict coerces freshness the way python float() does, not the way Number() does', () => {
  const v = (freshness, threshold = 26) => captureVerdict({ a: surface({ freshness_hours: freshness }) }, threshold).verdict;

  // Number('') === 0 would have read a blank field as perfectly fresh.
  assert.equal(v(''), 'ERROR');
  assert.equal(v('   '), 'ERROR');
  // Radix-prefixed strings: python raises, Number() happily returns 16/5/15.
  assert.equal(v('0x10'), 'ERROR');
  assert.equal(v('0b101'), 'ERROR');
  assert.equal(v('0o17'), 'ERROR');
  // …and a bare '.' has no digits at all.
  assert.equal(v('.'), 'ERROR');
  // inf/nan are VALUES to python, not failures — the old isFinite guard called
  // them ERROR while cron called them STALE.
  assert.equal(v('inf'), 'STALE');
  assert.equal(v('Infinity'), 'STALE');
  assert.equal(v('+Infinity'), 'STALE');
  assert.equal(v('nan'), 'STALE', 'every NaN comparison is false, so nan > threshold ⇒ STALE on both sides');
  assert.equal(v('NaN'), 'STALE');
  assert.equal(v('-inf'), 'FRESH', '-inf is trivially within any threshold');
  // PEP 515 underscores parse in python and are NaN to Number().
  assert.equal(v('1_0'), 'FRESH');
  assert.equal(v('1_000.5'), 'STALE');
  // Ordinary forms python and JS already agree on stay agreeing.
  for (const [input, expected] of [['26', 'FRESH'], ['26.1', 'STALE'], ['  26  ', 'FRESH'],
    ['1e3', 'STALE'], ['+1', 'FRESH'], ['.5', 'FRESH'], ['5.', 'FRESH']]) {
    assert.equal(v(input), expected, `freshness_hours ${JSON.stringify(input)}`);
  }
  // A NaN threshold makes every comparison false ⇒ STALE, on both sides.
  assert.equal(v(0, 'nan'), 'STALE');
  assert.equal(v(999, 'inf'), 'FRESH');
});

test('a non-finite freshness is grey per-surface, never allowed to slide into green', () => {
  // NaN fails EVERY comparison, so `hours > threshold` is false — without an
  // explicit guard the row would fall through to the fresh branch while cron
  // calls the same payload STALE.
  const nan = render(makeStats({ capture: { a: surface({ freshness_hours: 'nan' }) } }));
  assert.match(nan, /<td class="s-grey">cannot assess — no usable freshness value<\/td>/);
  assert.doesNotMatch(nan, /<td class="s-green">/);
  assert.match(nan, /<td>nan<\/td>/, 'the raw value renders WITHOUT an hours unit');

  const inf = render(makeStats({ capture: { a: surface({ freshness_hours: 'inf' }) } }));
  assert.match(inf, /<td class="s-red">stale — no capture within 26h<\/td>/);
  assert.match(inf, /<td>inf<\/td>/);

  // …and an unparseable uptime never becomes "Infinityd Infinityh".
  const badUptime = render(makeStats({
    server: { version: '1.0', uptime_s: 'inf', writes_enabled: true, mount_mode: 'rw' },
  }));
  assert.doesNotMatch(badUptime, /Infinity/);
});

test('captureVerdict treats an own __proto__ surface as an ordinary row', () => {
  const capture = JSON.parse('{"__proto__":{"last_day_seen":"2026-07-28","freshness_hours":1},'
    + '"constructor":{"last_day_seen":"2026-07-28","freshness_hours":2}}');
  const v = captureVerdict(capture, 26);
  assert.equal(v.verdict, 'FRESH');
  assert.equal(v.surface, '__proto__');
});

// ---------------------------------------------------------------------------
// A17 (render) — BOTH predicates on the page
// ---------------------------------------------------------------------------

test('A17: the tile renders BOTH the per-surface colours AND the aggregate cron verdict', () => {
  const html = render(makeStats({
    capture: {
      'claude-code-plugin': surface({ freshness_hours: 0, last_day_seen: '2026-07-28' }),
      'discord-bot': surface({ freshness_hours: 150.5, last_day_seen: '2026-07-21', stored: 0 }),
    },
  }));
  // Aggregate line: min() ⇒ FRESH, and it SAYS min() so the quantifier is not
  // left to the reader.
  assert.match(html, /Cron verdict: FRESH/);
  assert.match(html, /min\(\)/);
  // Per-surface: one green row, one red row — each with words, not just colour.
  assert.match(html, /<td class="s-green">fresh<\/td>/);
  assert.match(html, /<td class="s-red">stale — no capture within 26h<\/td>/);
  // A dead surface is never filtered out.
  assert.match(html, /discord-bot/);
  assert.match(html, /150\.5h/);
  assert.match(html, /2026-07-21/);
});

test('an ERROR verdict names WHICH failure it is, in the line and the banner', () => {
  // All three are ERROR/grey, but they call for different operator actions —
  // "the counters are unavailable" is a false diagnosis when the counters are
  // live and one surface reports garbage.
  const countersDown = render(makeStats({ capture: null, degraded: ['counters-unavailable'] }));
  assert.match(countersDown, /Cron verdict: cannot assess — the capture counters are unavailable/);
  assert.match(countersDown, /Cannot assess: the capture counters are unavailable, so no surface can be checked/);

  const badShape = render(makeStats({ capture: [] }));
  assert.match(badShape, /Cron verdict: cannot assess — the capture section is malformed/);
  assert.match(badShape, /Cannot assess: the capture section is malformed/);
  assert.doesNotMatch(badShape, /counters are unavailable/, 'a malformed section is not a dark counters db');

  // A LIVE table with one unusable value: the rows still render, and the line
  // points at them instead of blaming the counters.
  const badFreshness = render(makeStats({
    capture: {
      good: surface({ freshness_hours: 0 }),
      broken: surface({ freshness_hours: 'not-a-number' }),
    },
  }));
  assert.match(badFreshness, /Cron verdict: cannot assess — a surface reports an unusable freshness value — see the rows below/);
  assert.doesNotMatch(badFreshness, /counters are unavailable/);
  assert.doesNotMatch(badFreshness, /class="banner/, 'the table renders; there is no dead-end banner');
  assert.match(badFreshness, /<td class="s-grey">cannot assess — no usable freshness value<\/td>/);
  assert.match(badFreshness, /<td class="s-green">fresh<\/td>/, 'the healthy sibling row is unaffected');
});

test('A17: capture:null renders grey "cannot assess"; capture:{} renders red "never written"', () => {
  const grey = render(makeStats({ capture: null, degraded: ['counters-unavailable'] }));
  assert.match(grey, /Cron verdict: cannot assess/);
  assert.match(grey, /class="verdict s-grey"/);
  assert.doesNotMatch(grey, /Cron verdict: (FRESH|STALE)/);

  const red = render(makeStats({ capture: {} }));
  assert.match(red, /Cron verdict: STALE/);
  assert.match(red, /class="verdict s-red"/);
  assert.match(red, /capture has never written/i);
});

test('A17: writes_enabled:false explains the tile instead of leaving an unexplained red', () => {
  const html = render(makeStats({
    server: { version: '1.10.2', uptime_s: 10, writes_enabled: false, mount_mode: 'ro' },
    capture: { 'claude-code-plugin': surface({ freshness_hours: 150.5 }) },
  }));
  assert.match(html, /capture disabled \(writes off\)/);
  // NOT a general "writes-off implies the whole page is red-free" invariant —
  // a fixture with a non-zero pipeline `error` count (MED-1's own s-red gate)
  // would legitimately still render red regardless of writes_enabled; this
  // page-wide regex would simply be fixture-true by accident of ALSO having
  // error:0. This fixture's surface() default IS `error: 0` (no other red
  // source exists for it), so what this assertion actually proves is
  // narrower: the freshness tile's own writes-off branch contributes no red
  // row of its own — not that writes-off makes red impossible elsewhere.
  assert.doesNotMatch(html, /<td class="s-red">/, 'the freshness tile adds no red row while writes are off (fixture has error:0, so no red renders anywhere)');
  // The cron verdict is what um-alert would compute — writes_enabled is not an
  // input to it, so the aggregate line still says STALE.
  assert.match(html, /Cron verdict: STALE/);
});

test('clock skew: a future last_day_seen is flagged rather than trusted', () => {
  const html = render(makeStats({
    generated_at: '2026-07-28T12:00:00.000Z',
    capture: { 'claude-code-plugin': surface({ last_day_seen: '2026-07-30', freshness_hours: 0 }) },
  }));
  assert.match(html, /future timestamp \(clock skew\?\)/);
  // Still green (the clamp is a lower bound), but the reader is warned.
  assert.match(html, /<td class="s-green">fresh<\/td>/);

  const normal = render(makeStats());
  assert.doesNotMatch(normal, /clock skew/);
});

// ---------------------------------------------------------------------------
// A23 — "active but landing nothing"
// ---------------------------------------------------------------------------

test('A23: freshness inside threshold + nothing landed in 7d ⇒ red "active but landing nothing"', () => {
  const landingNothing = makeStats({
    capture: {
      'claude-code-plugin': surface({
        freshness_hours: 0, stored: 0, deduped: 0, superseded: 0, abstained: 41,
      }),
    },
  });
  const html = render(landingNothing);
  assert.match(html, /<td class="s-red">active but landing nothing<\/td>/);
  // The aggregate line renders what um-alert would say — unchanged.
  assert.match(html, /Cron verdict: FRESH/);
});

test('A23: the same fixture with deduped:1 is GREEN — a dedup hit proves the pipeline', () => {
  const landed = makeStats({
    capture: {
      'claude-code-plugin': surface({
        freshness_hours: 0, stored: 0, deduped: 1, superseded: 0, abstained: 41,
      }),
    },
  });
  const html = render(landed);
  assert.match(html, /<td class="s-green">fresh<\/td>/);
  assert.doesNotMatch(html, /landing nothing/);
  assert.match(html, /Cron verdict: FRESH/, 'the aggregate line is identical in both A23 fixtures');

  // superseded is the sibling case — also landing.
  const superseded = render(makeStats({
    capture: {
      'claude-code-plugin': surface({ freshness_hours: 0, stored: 0, superseded: 1, abstained: 41 }),
    },
  }));
  assert.match(superseded, /<td class="s-green">fresh<\/td>/);
});

test('A23: the red rule is per-surface only and never fires on a stale surface', () => {
  // Stale wins: the row reads "stale", not "landing nothing" — the two must not
  // both claim the row, or the operator is told the wrong thing to fix.
  const html = render(makeStats({
    capture: { s: surface({ freshness_hours: 99, stored: 0, deduped: 0, superseded: 0 }) },
  }));
  assert.match(html, /stale — no capture within 26h/);
  assert.doesNotMatch(html, /landing nothing/);
});

test('spec §7 arc pin: landedCount fires red on TURN-ONLY activity — freshness is 0h (turns keep '
  + 'landing) but outcomes_7d is all-zero (nothing actually reaches the vault), reproducing the '
  + 'checkpoint-outage class the "547 stored/7d vs growth 0/day" blindfold hid', () => {
  const html = render(makeStats({
    capture: {
      'claude-code-plugin': surface({
        freshness_hours: 0, events_today: 547, errors_today: 0,
        stored: 0, deduped: 0, superseded: 0, abstained: 0, error: 0, failed: 0,
        turns_7d: 547,
      }),
    },
  }));
  // Before spec §7, outcomes_7d.stored would have been 547 (turn-appends
  // conflated into "stored") and this row would have read green — exactly
  // the blindfold. Landing-only outcomes_7d makes the red rule fire instead.
  assert.match(html, /<td class="s-red">active but landing nothing<\/td>/);
  // The aggregate cron verdict is untouched by this (freshness-only input) —
  // still FRESH, since turns DID keep the surface's freshness alive.
  assert.match(html, /Cron verdict: FRESH/);
  // The pipeline tile's own turns_7d cell shows the volume was real, not zero.
  const section = sectionByHeading(html, 'Classified outcomes \\(7d\\)');
  assert.match(section, /<td>turns: 547<\/td>/);
});

// ---------------------------------------------------------------------------
// A6 — hostile map KEYS
// ---------------------------------------------------------------------------

const HOSTILE_KEYS = [
  '<img src=x onerror=alert(1)>',
  '" onmouseover="alert(1)',
  'a b" c',
  '__proto__',
  'constructor',
  'bidi‮EVIL‬',
];

test('A6: hostile surface names render inert as map keys, with correct counts', () => {
  const capture = Object.create(null);
  HOSTILE_KEYS.forEach((k, i) => {
    capture[k] = surface({ freshness_hours: i, events_today: 100 + i, errors_today: i });
  });
  const html = render(makeStats({ capture }));

  assertNoActiveContent(html, 'A6 hostile page');

  // Every hostile key rendered as ESCAPED element text…
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
  assert.match(html, /__proto__/);
  assert.match(html, /constructor/);
  // …with the bidi override STRIPPED, not merely escaped (entity escaping does
  // nothing to a character that visually reorders the row).
  assert.ok(!html.includes('‮'), 'the bidi override is stripped');
  assert.match(html, /bidiEVIL/);

  // …and nothing untrusted reached an ATTRIBUTE at all: the page's sink policy
  // is element text only, which is strictly stronger than "stays inside its
  // quoted attribute".
  for (const { attrs } of scanTags(html)) {
    for (const [, value] of attrPairs(attrs)) {
      for (const hostile of HOSTILE_KEYS) {
        assert.ok(!value.includes(hostile), `hostile key leaked into an attribute: ${value}`);
      }
      assert.ok(!value.includes('onmouseover'), `attribute value carries a handler payload: ${value}`);
    }
  }

  // Counts are the ones the payload carried — __proto__/constructor are
  // ordinary rows, not prototype lookups that render inherited garbage.
  for (let i = 0; i < HOSTILE_KEYS.length; i++) {
    assert.match(html, new RegExp(`<td>${100 + i}</td>`), `events_today ${100 + i} rendered`);
  }
  const tbody = /Last day seen \(UTC\)[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  assert.ok(tbody, 'the freshness table rendered a tbody');
  const rows = [...tbody[1].matchAll(/<tr>/g)].length;
  assert.equal(rows, HOSTILE_KEYS.length, 'one row per surface, none swallowed by the prototype');
});

// ---------------------------------------------------------------------------
// A11 — no active content, over benign AND hostile payloads
// ---------------------------------------------------------------------------

test('A11: the shell carries no active content and only same-origin references', () => {
  assertNoActiveContent(render(makeStats()), 'healthy page');
  assertNoActiveContent(render(makeStats({ capture: null, degraded: ['counters-unavailable', 'corpus-unavailable'] })), 'degraded page');
  assertNoActiveContent(render(makeStats({ capture: {} })), 'never-written page');
});

test('A11: the <style> block interpolates the nonce and nothing else', () => {
  const a = render(makeStats());
  const b = render(makeStats({ capture: { '<script>x</script>': surface() } }));
  assert.equal(styleBlocks(a)[0], styleBlocks(b)[0], 'the CSS body is a compile-time constant');
  assert.match(a, new RegExp(`<style nonce="${NONCE.replace(/[.*+?^$()|[\]\\]/g, '\\$&')}">`));
});

test('the document is a complete light-mode HTML page wider than the consent card', () => {
  const html = render(makeStats());
  assert.ok(html.startsWith('<!doctype html>'), 'a full document, not a fragment');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /system-ui, sans-serif/);
  assert.doesNotMatch(html, /prefers-color-scheme/, 'light mode only — the repo has no second theme');
  const maxWidth = /max-width: (\d+)rem/.exec(html);
  assert.ok(maxWidth && Number(maxWidth[1]) > 34, 'wider than the consent/unlock card (34rem)');
});

test('the brand lockup is ONE shared constant, not a second copy (spec §6 / R1 N5)', () => {
  // Both server-rendered pages import the same export; a future edit that
  // pastes a literal copy into either template fails here.
  assert.ok(render(makeStats()).includes(BRAND_LOCKUP_SVG), 'the control page renders the shared lockup');
  assert.ok(
    renderConsentPage({ clientName: 'c', redirectHost: 'h', authzId: 'a', csrf: 'x', needsToken: true })
      .includes(BRAND_LOCKUP_SVG),
    'the consent page renders the SAME shared lockup',
  );
  assert.equal(
    (readFileSync(CONTROL_PAGE_SRC, 'utf8').match(/data-brand="um-lockup"/g) ?? []).length, 1,
    'the lockup markup is written down exactly once',
  );
});

// ---------------------------------------------------------------------------
// A24 — the one-shot legend is STATIC
// ---------------------------------------------------------------------------

test('A24: no surface-name branch exists in the module', () => {
  const src = readFileSync(CONTROL_PAGE_SRC, 'utf8');
  // The real surfaces this deployment sees. None may appear in the module at
  // all — not in a comparison, not in a lookup table, not in a comment that a
  // later edit could turn into one.
  for (const name of ['claude-code-plugin', 'discord-bot', 'codex', 'custom-gpt', 'desktop', 'openclaw']) {
    assert.ok(!src.includes(name), `control-page.mjs must not mention the surface name "${name}"`);
  }
});

test('A24: the one-shot legend is byte-identical regardless of which surfaces exist', () => {
  const legendOf = (html) => {
    const m = /<p class="legend">([\s\S]*?)<\/p>/.exec(html);
    assert.ok(m, 'the legend is rendered');
    return m[1];
  };
  const a = legendOf(render(makeStats({ capture: { 'backfill-one-shot': surface({ freshness_hours: 900 }) } })));
  const b = legendOf(render(makeStats({ capture: { zz: surface({ freshness_hours: 0 }) } })));
  assert.equal(a, b, 'the legend never branches on a surface name');
  assert.match(a, /one-shot/i);
});

// ---------------------------------------------------------------------------
// Ops row (spec §4 / C3)
// ---------------------------------------------------------------------------

test('the ops row renders version/uptime/writes/mount/schema and a healthy degraded state', () => {
  const html = render(makeStats());
  assert.match(html, /1\.10\.2/);
  assert.match(html, /3h 12m/, 'uptime_s is humanised');
  assert.match(html, /writes enabled/i);
  assert.match(html, />rw</);
  assert.match(html, /healthy/i);
  assert.doesNotMatch(html, /undefined/, 'never the string "undefined"');
  // generated_at is rendered in full and explicitly UTC.
  assert.match(html, /2026-07-28T12:00:00\.000Z/);
  assert.match(html, /UTC/);
});

test('the ops row names every degraded flag, including corpus-unavailable', () => {
  const html = render(makeStats({
    capture: null,
    recall: { searches_today: null, searches_7d: null, latency_since_boot: { p50_ms: null, p95_ms: null, n: 0, label: 'serving latency' } },
    degraded: ['corpus-unavailable', 'counters-unavailable'],
  }));
  assert.match(html, /corpus-unavailable/);
  assert.match(html, /counters-unavailable/);
  // The nullable recall counters get an explicit degraded presentation — never
  // a zero, and never an empty cell that reads like one.
  assert.match(html, /recall counters/i);
  assert.match(html, /cannot assess/i);
  assert.doesNotMatch(html, /undefined/);
});

test('a malformed degraded field is "cannot assess", never announced as healthy', () => {
  // Announcing health on the strength of a field it failed to parse is the one
  // thing this row must never do.
  for (const bad of ['counters-unavailable', 42, {}, true]) {
    const html = render(makeStats({ degraded: bad }));
    assert.match(html, /cannot assess — the degraded field is malformed/, `degraded: ${JSON.stringify(bad)}`);
    assert.doesNotMatch(html, /healthy/, `degraded: ${JSON.stringify(bad)} must not read healthy`);
  }
  // Absent and empty-array both mean healthy — those ARE understood.
  assert.match(render(makeStats()), /healthy — every source reporting/);
  assert.match(render(makeStats({ degraded: [] })), /healthy — every source reporting/);
});

test('a wholly MISSING recall section reads the same "cannot assess" as recall:null', () => {
  // `{}.searches_today` is undefined, not null — a null-only check rendered
  // nothing at all here, i.e. silence where the payload had no answer.
  const explicitNull = render(makeStats({
    recall: { searches_today: null, searches_7d: null, latency_since_boot: { p50_ms: null, p95_ms: null, n: 0, label: 'x' } },
  }));
  const missing = render(makeStats({ recall: undefined }));
  const absentKey = render({ schema_version: 1, capture: {} });
  for (const [label, html] of [['explicit null', explicitNull], ['missing', missing], ['no section', absentKey]]) {
    assert.match(html, /Recall counters/, `${label}: the row is present`);
    assert.match(html, /cannot assess — search counters unavailable/, `${label}: and says so`);
  }
  // A healthy recall section renders no such row.
  assert.doesNotMatch(render(makeStats()), /Recall counters/);
});

test('missing/blank payload sections degrade to em dashes, never "undefined" or a bare 0', () => {
  const html = render({ schema_version: 1, capture: null });
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /NaN/);
  assert.match(html, /—/, 'absent values render as an em dash, not an empty cell');
});

test('R1 S-N3: the empty-state branch precedes the escaper — null never renders like 0', () => {
  const zero = render(makeStats({
    capture: { s: surface({ freshness_hours: 0, events_today: 0, errors_today: 0, stored: 1 }) },
  }));
  assert.match(zero, /<td>0<\/td>/, 'a real zero renders as 0');
  assert.match(zero, /<td>0h<\/td>/, 'a real zero freshness renders as 0h');

  const absent = render(makeStats({
    capture: {
      s: { last_day_seen: null, freshness_hours: null, events_today: null, errors_today: null },
    },
  }));
  // esc(null) is '' — an empty cell would read exactly like a zero, which is
  // the distinction this page exists to show.
  assert.doesNotMatch(absent, /<td><\/td>/, 'no empty cell masquerading as a value');
  assert.match(absent, /<td class="s-grey">cannot assess — no usable freshness value<\/td>/);
  assert.match(absent, /<td>—<\/td>/);
});

test('a surface with no outcomes_7d is not falsely reddened as "landing nothing"', () => {
  // The rule needs all three landing counts; when they are unreadable the row
  // is left as its freshness says, not guessed at.
  const html = render(makeStats({
    capture: { s: { last_day_seen: '2026-07-28', freshness_hours: 0, events_today: 1, errors_today: 0 } },
  }));
  assert.match(html, /<td class="s-green">fresh<\/td>/);
  assert.doesNotMatch(html, /landing nothing/);
});

test('hostile ops-row values render inert too (version / mount_mode / degraded / generated_at)', () => {
  const html = render(makeStats({
    generated_at: '<script>alert(1)</script>',
    schema_version: '"><img src=x onerror=alert(1)>',
    server: {
      version: '1.0 <script>alert(1)</script>',
      uptime_s: 'not-a-number',
      writes_enabled: 'maybe',
      mount_mode: '" onmouseover="alert(1)',
    },
    degraded: ['corpus-unavailable', '<img src=x onerror=alert(1)>'],
    capture: {},
  }));
  assertNoActiveContent(html, 'hostile ops row');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
  // Unparseable uptime / non-boolean writes flag degrade, never crash or lie.
  assert.doesNotMatch(html, /undefined/);
  assert.doesNotMatch(html, /NaN/);
});

test('the page carries the logout form U5 wires the CSRF token into', () => {
  const html = render(makeStats());
  assert.match(html, /<form method="post" action="\/control\/logout">/);
  assert.match(html, new RegExp(`<input type="hidden" name="csrf" value="${CSRF}">`));
  assert.match(html, /<a href="\/control">Refresh<\/a>/);
  assert.doesNotMatch(html, /http-equiv/i, 'no meta refresh — reloading is a navigation (spec §4)');
});

// ---------------------------------------------------------------------------
// U4a re-review carry-ins
// ---------------------------------------------------------------------------

test('carry-in 1: a NaN threshold reads cannot-assess per-surface, matching the STALE aggregate '
  + '(never a green row under a red banner)', () => {
  // The exact "nan threshold — nothing is within it" A12 fixture payload,
  // rendered through the page rather than just checked against um-alert.sh's
  // exit code: before the fix, `hours > NaN` was false, so this surface fell
  // through to green while captureVerdict's `<=` (also always false against
  // NaN) called the SAME payload STALE.
  const html = render(makeStats({
    capture_freshness_threshold_hours: 'nan',
    capture: { a: surface({ freshness_hours: 0, stored: 1 }) },
  }));
  assert.match(html, /Cron verdict: STALE/);
  assert.match(html, /<td class="s-grey">cannot assess — the freshness threshold is unusable<\/td>/);
  assert.doesNotMatch(html, /<td class="s-green">/);
});

test('carry-in 1: an Infinity threshold is ALSO cannot-assess per-surface, not guessed at', () => {
  const html = render(makeStats({
    capture_freshness_threshold_hours: 'inf',
    capture: { a: surface({ freshness_hours: 999, stored: 1 }) },
  }));
  assert.match(html, /Cron verdict: FRESH/, 'aggregate: everything is within an infinite threshold');
  assert.match(html, /<td class="s-grey">cannot assess — the freshness threshold is unusable<\/td>/);
});

test('carry-in 2 (fix round 1): brandCss() is a REAL single source — both pages call it, '
  + 'only margin-bottom parameterized, .brand-name/.brand-sub pinned identical', () => {
  const controlStyle = styleBlocks(render(makeStats()))[0];
  const consentStyle = styleBlocks(
    renderConsentPage({ clientName: 'c', redirectHost: 'h', authzId: 'a', csrf: 'x', needsToken: true }),
  )[0];

  // Each page actually calls brandCss() with its OWN margin — not a hand
  // copy that happens to match right now.
  assert.ok(controlStyle.includes(brandCss('0.5rem')), 'control-page STYLE calls brandCss(\'0.5rem\')');
  assert.ok(consentStyle.includes(brandCss('1rem')), 'consent calls brandCss(\'1rem\')');

  // .brand-name/.brand-sub never vary with the margin argument — pinned
  // identical across BOTH pages, derived from the LIVE function (not a
  // second hardcoded string here), so a future edit to brandCss() that only
  // lands in one page's call site is caught rather than silently diverging.
  const sharedTail = brandCss('irrelevant-to-this-slice').split('\n').slice(1).join('\n');
  assert.ok(controlStyle.includes(sharedTail), 'control-page renders the shared .brand-name/.brand-sub verbatim');
  assert.ok(consentStyle.includes(sharedTail), 'consent renders the shared .brand-name/.brand-sub verbatim');
});

// ---------------------------------------------------------------------------
// Layers tile — per-layer freshness (Task 10, spec §6)
// ---------------------------------------------------------------------------

test('layers tile: empty state — no projects with captures yet', () => {
  const html = render(makeStats({ layers: {} }));
  assert.match(html, /Per-layer freshness/);
  assert.match(html, /no projects with captures yet/);
  assert.doesNotMatch(html.split('Per-layer freshness')[1].split('</section>')[0], /class="banner/,
    'the empty-but-healthy state is not a banner');
});

test('layers tile: present, zero stale — a distinct healthy state from "no projects yet"', () => {
  const html = render(makeStats({
    layers: {
      'edge-catcher': {
        last_capture_at: '2026-08-15T09:00:00.000Z',
        last_summary_at: '2026-08-15T08:00:00.000Z',
        last_state_at: '2026-08-15T08:00:00.000Z',
        pending_bytes: 0,
        stale: false,
        lag_hours: 1,
      },
    },
  }));
  assert.match(html, /no stale projects/);
  assert.doesNotMatch(html, /edge-catcher/, 'nothing else — a fresh project is not itemized in this tile');
});

test('layers tile: stale projects render red with their lag and pending bytes; fresh siblings are not listed', () => {
  const html = render(makeStats({
    layers: {
      'universal-memory': {
        last_capture_at: '2026-08-04T09:00:00.000Z',
        last_summary_at: '2026-07-30T08:00:00.000Z',
        last_state_at: null,
        pending_bytes: 7000,
        stale: true,
        lag_hours: 121.0,
      },
      'edge-catcher': {
        last_capture_at: '2026-08-15T09:00:00.000Z',
        last_summary_at: '2026-08-15T08:00:00.000Z',
        last_state_at: '2026-08-15T08:00:00.000Z',
        pending_bytes: 0,
        stale: false,
        lag_hours: 1,
      },
    },
  }));
  assert.match(html, /1 stale project/);
  assert.match(html, /universal-memory/);
  assert.match(html, /121h/);
  assert.match(html, /7000/);
  assert.doesNotMatch(html, /<th scope="row">edge-catcher<\/th>/, 'the fresh sibling is not itemized — stale-only, per spec §6');
});

test('layers tile: an infinite lag (never-checkpointed project) renders the ∞ glyph, not "Infinityh" or a crash', () => {
  const html = render(makeStats({
    layers: {
      tmp: {
        last_capture_at: '2026-08-04T09:00:00.000Z',
        last_summary_at: null,
        last_state_at: null,
        pending_bytes: 999999,
        stale: true,
        lag_hours: 'Infinity',
      },
    },
  }));
  assert.match(html, /∞/);
  assert.doesNotMatch(html, /Infinityh/);
});

test('layers tile: a malformed layers section (not an object) is "cannot assess", never crashes or fabricates a project list', () => {
  const html = render(makeStats({ layers: [] }));
  assert.match(html, /Per-layer freshness/);
  assert.match(html, /Cannot assess: the layers section is malformed/);
});

test('layers tile: hostile project names render inert as map keys', () => {
  const html = render(makeStats({
    layers: {
      '<img src=x onerror=alert(1)>': {
        last_capture_at: '2026-08-04T09:00:00.000Z',
        last_summary_at: null,
        last_state_at: null,
        pending_bytes: 999,
        stale: true,
        lag_hours: 10,
      },
    },
  }));
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ---------------------------------------------------------------------------
// U4b — Pipeline tile: "classified outcomes (7d)" (A20)
// ---------------------------------------------------------------------------

test('A20: the pipeline tile is labelled "classified outcomes (7d)", has no residual, '
  + 'and colours only the error/failed outcomes', () => {
  const html = render(makeStats({
    capture: {
      a: surface({
        stored: 3, abstained: 41, deduped: 1, superseded: 0, error: 2, failed: 1, turns_7d: 12,
      }),
    },
  }));
  const section = sectionByHeading(html, 'Classified outcomes \\(7d\\)');
  assert.match(section, /stored: 3/);
  assert.match(section, /abstained: 41/);
  assert.match(section, /deduped: 1/);
  assert.match(section, /superseded: 0/);
  assert.match(section, /error: 2/);
  assert.match(section, /failed: 1/);
  // error/failed are the ONLY outcomes coloured (spec §7's OUTCOME_KEYS
  // ripple); each count is named as text, so colour is never the sole
  // carrier (spec §6).
  assert.match(section, /<td class="s-red">error: 2<\/td>/);
  assert.match(section, /<td class="s-red">failed: 1<\/td>/);
  assert.doesNotMatch(section, /<td class="s-red">abstained/);
  assert.doesNotMatch(section, /<td class="s-green">/, 'no outcome renders in the success-green colour');
  assert.doesNotMatch(html, /events_7d/i, 'no residual — there is no events_7d in the payload');
  // turns_7d (additive, spec §7) rides the same row, its own cell, never coloured.
  assert.match(section, /<td>turns: 12<\/td>/);
});

test('pipeline tile: capture:null/malformed is cannot-assess; capture:{} is never-written — same '
  + 'guard shape as the freshness tile, because it is the SAME capture section', () => {
  const grey = sectionByHeading(
    render(makeStats({ capture: null, degraded: ['counters-unavailable'] })),
    'Classified outcomes \\(7d\\)',
  );
  assert.match(grey, /cannot assess/i);

  const red = sectionByHeading(render(makeStats({ capture: {} })), 'Classified outcomes \\(7d\\)');
  assert.match(red, /never written/i);
});

test('pipeline tile: a surface with malformed/missing outcomes_7d (and turns_7d) renders em '
  + 'dashes, never a crash or a false zero', () => {
  const html = render(makeStats({
    capture: { a: { last_day_seen: '2026-07-28', freshness_hours: 0, events_today: 1, errors_today: 0 } },
  }));
  const section = sectionByHeading(html, 'Classified outcomes \\(7d\\)');
  assert.match(section, /stored: —/);
  assert.match(section, /error: —/);
  assert.match(section, /failed: —/);
  assert.match(section, /turns: —/, 'a missing turns_7d renders an em dash too, never a false 0');
  // MED-1 (fix round 1): an unusable count is never error-coloured either —
  // this module's contract is absent ⇒ em dash, unusable ⇒ grey elsewhere,
  // never a false red. Applies to 'failed' the same way it applies to 'error'.
  assert.doesNotMatch(section, /<td class="s-red">error/);
  assert.doesNotMatch(section, /<td class="s-red">failed/);
});

test('MED-1 (fix round 1): a healthy zero-error surface renders plain, not a red "error: 0" '
  + 'block; a hostile non-numeric error count is never coloured either', () => {
  const healthy = sectionByHeading(
    render(makeStats({ capture: { a: surface({ stored: 5, error: 0 }) } })),
    'Classified outcomes \\(7d\\)',
  );
  assert.match(healthy, /error: 0/);
  assert.doesNotMatch(healthy, /<td class="s-red">error/, 'a real ZERO error count must not read as an alarm');

  const hostile = sectionByHeading(
    render(makeStats({ capture: { a: surface({ stored: 5, error: 'not-a-number' }) } })),
    'Classified outcomes \\(7d\\)',
  );
  assert.match(hostile, /error: not-a-number/);
  assert.doesNotMatch(hostile, /<td class="s-red">error/, 'an unparseable count is not coloured red either');

  const real = sectionByHeading(
    render(makeStats({ capture: { a: surface({ stored: 5, error: 3 }) } })),
    'Classified outcomes \\(7d\\)',
  );
  assert.match(real, /<td class="s-red">error: 3<\/td>/, 'a genuine positive error count IS still coloured');
});

test('MED-1 sibling: the same healthy/hostile/real pattern applies to "failed" (spec §7 — the '
  + 'summarizer-throw outcome is a genuine failure too, not a routine gate outcome)', () => {
  const healthy = sectionByHeading(
    render(makeStats({ capture: { a: surface({ stored: 5, failed: 0 }) } })),
    'Classified outcomes \\(7d\\)',
  );
  assert.match(healthy, /failed: 0/);
  assert.doesNotMatch(healthy, /<td class="s-red">failed/, 'a real ZERO failed count must not read as an alarm');

  const hostile = sectionByHeading(
    render(makeStats({ capture: { a: surface({ stored: 5, failed: 'not-a-number' }) } })),
    'Classified outcomes \\(7d\\)',
  );
  assert.match(hostile, /failed: not-a-number/);
  assert.doesNotMatch(hostile, /<td class="s-red">failed/, 'an unparseable count is not coloured red either');

  const real = sectionByHeading(
    render(makeStats({ capture: { a: surface({ stored: 5, failed: 2 }) } })),
    'Classified outcomes \\(7d\\)',
  );
  assert.match(real, /<td class="s-red">failed: 2<\/td>/, 'a genuine positive failed count IS still coloured');
});

// ---------------------------------------------------------------------------
// U4b — Corpus tile (A9's counters-governance half, scan saturation)
// ---------------------------------------------------------------------------

function corpus(overrides = {}) {
  return {
    points: 0,
    points_by_project: {},
    scan_saturated: false,
    growth_7d: {},
    growth_docs_7d: {},
    derived_from: 'extraction-counters',
    ...overrides,
  };
}

test('scan saturation: scan_saturated:true renders the cap literal; it is never inferred from points', () => {
  const saturated = render(makeStats({ corpus: corpus({ points: 10000, scan_saturated: true }) }));
  const satSection = sectionByHeading(saturated, 'Corpus');
  assert.match(satSection, /≥ 10000 \(scan cap\)/);

  const notSaturated = render(makeStats({ corpus: corpus({ points: 10000, scan_saturated: false }) }));
  const plainSection = sectionByHeading(notSaturated, 'Corpus');
  assert.doesNotMatch(plainSection, /scan cap/);
  assert.match(plainSection, /<td>10000<\/td>/);
});

test('a zero-point corpus renders a real zero, distinct from "cannot assess"', () => {
  const section = sectionByHeading(render(makeStats({ corpus: corpus({ points: 0 }) })), 'Corpus');
  assert.match(section, /Points<\/th><td>0<\/td>/);
  assert.doesNotMatch(section, /cannot assess/);
});

test('degraded:["corpus-unavailable"] blanks points/points_by_project/scan_saturated '
  + 'REGARDLESS of their values', () => {
  const html = render(makeStats({
    degraded: ['corpus-unavailable'],
    corpus: corpus({ points: 999, points_by_project: { x: 999 } }),
  }));
  const section = sectionByHeading(html, 'Corpus');
  assert.match(section, /cannot assess/i);
  assert.doesNotMatch(section, /999/, 'the stale non-null value never leaks past the flag');
});

test('M2: a malformed (non-array) degraded field blanks the corpus tile too, not "no flags"', () => {
  // A string/number/bare-object `degraded` is UNKNOWN, not an empty flag
  // list — `Array.isArray(degraded) ? degraded : []` would read it as "no
  // outage" and render the (possibly stale) corpus figures as truth. The ops
  // row already treats this shape as "cannot assess" (degradedPresentation);
  // corpusTile must agree, via the same degradedFlags() helper.
  const html = render(makeStats({
    degraded: 'corpus-unavailable', // malformed: a bare string, not the expected list
    corpus: corpus({ points: 999, points_by_project: { x: 999 } }),
  }));
  const section = sectionByHeading(html, 'Corpus');
  assert.match(section, /cannot assess/i);
  assert.doesNotMatch(section, /999/, 'the stale value never renders as truth just because degraded was unparseable');
});

test('MIN-3 (fix round 1): a flag-driven corpus outage and a shape-driven one get DIFFERENT '
  + 'diagnoses — a malformed corpus section without the flag is not blamed on qdrant', () => {
  const flagDriven = sectionByHeading(
    render(makeStats({ degraded: ['corpus-unavailable'] })),
    'Corpus',
  );
  assert.match(flagDriven, /qdrant could not be read/);

  const shapeDriven = sectionByHeading(render(makeStats({ corpus: [] })), 'Corpus');
  assert.match(shapeDriven, /the corpus section is malformed/);
  assert.doesNotMatch(shapeDriven, /qdrant could not be read/, 'a malformed shape is not a qdrant outage');

  const missing = sectionByHeading(render({ schema_version: 1, capture: {} }), 'Corpus');
  assert.match(missing, /the corpus section is malformed/, 'a wholly absent corpus section is the same shape problem');
});

test('points_by_project: the (unknown) bucket renders as "unattributed", visually distinct; '
  + 'every other bucket (including the $HOME catch-all "desktop") is a normal row', () => {
  const html = render(makeStats({
    corpus: corpus({
      points: 130,
      points_by_project: { 'universal-memory': 100, desktop: 20, '(unknown)': 10 },
    }),
  }));
  const section = sectionByHeading(html, 'Corpus');
  assert.match(section, /<th scope="row" class="unattributed">unattributed<\/th><td>10<\/td>/);
  assert.match(section, /<th scope="row">desktop<\/th><td>20<\/td>/, 'no special-casing for the desktop bucket');
  assert.match(section, /<th scope="row">universal-memory<\/th><td>100<\/td>/);
  assert.doesNotMatch(section, /\(unknown\)/, 'the raw bucket name never leaks — only its friendly label');
});

test('A6 (extended): hostile project names render inert as points_by_project map KEYS', () => {
  const points_by_project = hostileMap([
    ['<img src=x onerror=alert(1)>', 3],
    ['" onmouseover="alert(1)', 2],
    ['__proto__', 5],
    ['constructor', 1],
  ]);
  const html = render(makeStats({ corpus: corpus({ points: 11, points_by_project }) }));
  assertNoActiveContent(html, 'hostile project-name page');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot; onmouseover=&quot;alert\(1\)/);
  const section = sectionByHeading(html, 'Corpus');
  assert.match(section, /__proto__/);
  assert.match(section, /constructor/);
});

// ---------------------------------------------------------------------------
// U4b — Growth tile: TWO independent series (A9)
// ---------------------------------------------------------------------------

test('A9: both growth series render with distinct labels; derived_from is attached to the '
  + 'extraction series only; independent empty states — one suppressed while the other draws', () => {
  const html = render(makeStats({
    corpus: corpus({
      points: 50,
      points_by_project: { p: 50 },
      growth_7d: { '2026-07-22': 2, '2026-07-23': 4 },
      growth_docs_7d: {}, // all-zero, non-null
    }),
  }));
  assert.match(html, /Extraction growth \(7d\)/);
  assert.match(html, /Doc growth \(7d\) — session summaries\/checkpoints/);
  assert.match(html, /source: extraction-counters/);
  assert.match(html, /0 doc writes in 7d/);
  assert.doesNotMatch(html, /0 extractions in 7d/);
  assert.equal((html.match(/<polyline/g) ?? []).length, 1, 'the zero-suppressed doc series draws no polyline');
});

test('A9: a null growth series reads "cannot assess" independently of its live sibling', () => {
  const html = render(makeStats({
    corpus: corpus({
      points: 50,
      growth_7d: null,
      growth_docs_7d: { '2026-07-26': 1, '2026-07-27': 3 },
    }),
  }));
  const extractionBlock = /<h3>Extraction growth \(7d\)<\/h3>\s*<p class="s-grey">cannot assess<\/p>/;
  assert.match(html, extractionBlock);
  assert.doesNotMatch(html, /0 extractions in 7d/);
  assert.equal((html.match(/<polyline/g) ?? []).length, 1, 'the doc series still draws');
});

test('A9: growth is governed by counters-unavailable, NOT corpus-unavailable — qdrant-down with '
  + 'healthy counters still draws both series live while the corpus figures read cannot-assess', () => {
  const html = render(makeStats({
    degraded: ['corpus-unavailable'],
    corpus: corpus({
      points: 999,
      points_by_project: { x: 999 },
      growth_7d: { '2026-07-26': 5, '2026-07-27': 5 },
      growth_docs_7d: { '2026-07-26': 2, '2026-07-27': 2 },
    }),
  }));
  const corpusSection = sectionByHeading(html, 'Corpus');
  assert.match(corpusSection, /cannot assess/i);
  assert.doesNotMatch(corpusSection, /999/);
  assert.match(html, /source: extraction-counters/, 'growth still renders — not blanked by corpus-unavailable');
  assert.equal((html.match(/<polyline/g) ?? []).length, 2, 'both series draw live');
});

test('MIN-2 (fix round 1): a non-finite MEMBER value in a growth series reads "cannot assess", '
  + 'never coerced to a false zero', () => {
  const html = render(makeStats({
    corpus: corpus({
      points: 50,
      growth_7d: { '2026-07-28': 'abc' },
      growth_docs_7d: { '2026-07-26': 1, '2026-07-27': 2 },
    }),
  }));
  const extractionBlock = /<h3>Extraction growth \(7d\)<\/h3>\s*<p class="s-grey">cannot assess<\/p>/;
  assert.match(html, extractionBlock);
  assert.doesNotMatch(html, /0 extractions in 7d/, 'a garbage day count must never render the confident zero-text');
  assert.equal((html.match(/<polyline/g) ?? []).length, 1, 'the doc series is unaffected — the states are independent');
});

test('M1: a null/\'\'/false/[] MEMBER in a growth series reads "cannot assess", never the '
  + 'confident-false-zero a bare Number() coercion would produce', () => {
  // Number(null) === 0, Number('') === 0, Number(false) === 0, Number([]) === 0
  // — all FINITE, so the MIN-2 non-finite guard alone would miss every one of
  // these and silently render "0 extractions in 7d" for a garbage day. pyFloat
  // (which returns null, not 0, for each) is what classifySeries must use.
  for (const [label, badMember] of [['null', null], ["''", ''], ['[]', []], ['false', false]]) {
    const html = render(makeStats({
      corpus: corpus({
        points: 50,
        growth_7d: { '2026-07-28': badMember, '2026-07-27': 3 },
        growth_docs_7d: { '2026-07-26': 1 },
      }),
    }));
    const extractionBlock = /<h3>Extraction growth \(7d\)<\/h3>\s*<p class="s-grey">cannot assess<\/p>/;
    assert.match(html, extractionBlock, `member ${label}: the whole series reads cannot-assess`);
    assert.doesNotMatch(html, /0 extractions in 7d/, `member ${label}: never the confident zero-text`);
  }
});

test('NIT-6 (fix round 1): a single-day (non-array) growth series draws no sparkline — '
  + 'a one-vertex polyline would draw nothing while claiming a live series', () => {
  const html = render(makeStats({
    corpus: corpus({ points: 5, growth_7d: { '2026-07-28': 5 } }),
  }));
  const extractionSection = /<h3>Extraction growth \(7d\)<\/h3>[\s\S]*?<\/div>/.exec(html)[0];
  assert.doesNotMatch(extractionSection, /<polyline/, 'a single point suppresses the sparkline');
  assert.doesNotMatch(extractionSection, /0 extractions in 7d/, 'it is still a LIVE, non-zero series, not the zero-state');
  assert.match(extractionSection, /2026-07-28: 5/, 'the day/value is still listed as text');
});

test('sparkline construction: only VALUES reach the <svg>; hostile day KEYS render as escaped '
  + 'text labels outside it', () => {
  const hostileDay = '<img src=x onerror=alert(1)>" onmouseover="alert(2)';
  const html = render(makeStats({
    corpus: corpus({
      points: 5,
      points_by_project: { p: 5 },
      growth_7d: { [hostileDay]: 7, '2026-07-27': 3 },
    }),
  }));
  assertNoActiveContent(html, 'hostile growth day-key page');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot; onmouseover=&quot;alert\(2\)/);
  const svgMatches = [...html.matchAll(/<polyline points="([^"]*)"/g)];
  assert.ok(svgMatches.length >= 1, 'at least one sparkline drew');
  for (const m of svgMatches) {
    assert.doesNotMatch(m[1], /[^0-9.,\s-]/, 'polyline points are numeric-only — no day key leaked into it');
  }
});

// ---------------------------------------------------------------------------
// U4b — Recall tile
// ---------------------------------------------------------------------------

test('recall tile renders searches_today/7d, p50/p95/n, and the label verbatim', () => {
  const html = render(makeStats({
    recall: {
      searches_today: 7,
      searches_7d: 55,
      latency_since_boot: { p50_ms: 42, p95_ms: 130, n: 9, label: 'serving latency' },
    },
  }));
  const section = sectionByHeading(html, 'Recall');
  assert.match(section, /Searches today<\/th><td>7<\/td>/);
  assert.match(section, /Searches \(7d\)<\/th><td>55<\/td>/);
  assert.match(section, /p50<\/th><td>42<\/td>/);
  assert.match(section, /p95<\/th><td>130<\/td>/);
  assert.match(section, /n<\/th><td>9<\/td>/);
  assert.match(section, /serving latency/);
});

test('recall tile: searches_today\\/7d null render "cannot assess", never a bare 0', () => {
  const html = render(makeStats({
    recall: {
      searches_today: null,
      searches_7d: null,
      latency_since_boot: { p50_ms: 10, p95_ms: 20, n: 4, label: 'x' },
    },
  }));
  const section = sectionByHeading(html, 'Recall');
  assert.match(section, /Searches today<\/th><td><span class="s-grey">cannot assess<\/span><\/td>/);
  assert.match(section, /Searches \(7d\)<\/th><td><span class="s-grey">cannot assess<\/span><\/td>/);
});

test('recall tile: p50_ms null with n:0 reads "no searches since boot", never "0ms" — and a real '
  + 'zero search count still renders as 0', () => {
  const html = render(makeStats({
    recall: {
      searches_today: 0,
      searches_7d: 0,
      latency_since_boot: { p50_ms: null, p95_ms: null, n: 0, label: 'serving latency' },
    },
  }));
  const section = sectionByHeading(html, 'Recall');
  assert.match(section, /no searches since boot/);
  assert.doesNotMatch(section, /0ms/);
  assert.match(section, /Searches today<\/th><td>0<\/td>/);
});

// ---------------------------------------------------------------------------
// U4b — A11 extended to the full page (every new untrusted slot)
// ---------------------------------------------------------------------------

test('A11 (extended): the full page — hostile project names, label, and derived_from — carries '
  + 'no active content and escapes every new untrusted slot', () => {
  const capture = Object.create(null);
  HOSTILE_KEYS.forEach((k, i) => { capture[k] = surface({ freshness_hours: i }); });
  const pointsByProject = hostileMap([
    ['<img src=x onerror=alert(1)>', 3],
    ['" onmouseover="alert(1)', 2],
    ['__proto__', 5],
    ['constructor', 1],
    ['(unknown)', 4],
  ]);
  const html = render(makeStats({
    capture,
    corpus: corpus({
      points: 15,
      points_by_project: pointsByProject,
      growth_7d: { '2026-07-27': 3 },
      growth_docs_7d: { '2026-07-26': 1 },
      derived_from: `<script>alert(1)</script> & "quote" 'apo'`,
    }),
    recall: {
      searches_today: 1,
      searches_7d: 2,
      latency_since_boot: {
        p50_ms: 10, p95_ms: 20, n: 3,
        label: `<img src=x onerror=alert(1)> label & "q"`,
      },
    },
  }));

  assertNoActiveContent(html, 'U4b hostile kitchen-sink page');

  // derived_from and the recall label both render as escaped TEXT.
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;quote&quot; &#39;apo&#39;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; label &amp; &quot;q&quot;/);
  // project-name keys render escaped too, and never leak into an attribute.
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  for (const { attrs } of scanTags(html)) {
    for (const [, value] of attrPairs(attrs)) {
      assert.ok(!value.includes('onerror'), `attribute value carries a handler payload: ${value}`);
      assert.ok(!value.includes('onmouseover'), `attribute value carries a handler payload: ${value}`);
    }
  }
});

// ---------------------------------------------------------------------------
// A12 — the automated page↔cron cross-check
//
// ONE fixture table, expressed as JSON TEXT so both consumers see byte-identical
// input: the page side JSON.parse()s it, the cron side is served it verbatim by
// a MOCK_BIN curl. The shipped um-alert.sh — including its real python verdict
// block — is invoked as a subprocess; nothing here reimplements it.
//
// um-alert.sh is deliberately run WITHOUT --max-age-hours so the fixtures'
// capture_freshness_threshold_hours is the value BOTH sides read (the whole
// point of the single-sourcing this test guards).
// ---------------------------------------------------------------------------

const EXIT_FOR_VERDICT = { FRESH: 0, STALE: 1, ERROR: 2 };

const A12_FIXTURES = [
  ['capture:null + counters-unavailable',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":null,"degraded":["counters-unavailable"]}'],
  ['capture:{} — never written',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{}}'],
  ['single fresh surface',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":0,"events_today":4,"errors_today":0,"outcomes_7d":{"stored":3,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['one fresh, one long-dead — min() wins',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"dead":{"last_day_seen":"2026-06-01","freshness_hours":1300,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}},"live":{"last_day_seen":"2026-07-28","freshness_hours":0,"events_today":9,"errors_today":0,"outcomes_7d":{"stored":9,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['all surfaces stale',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-21","freshness_hours":150.5,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}},"b":{"last_day_seen":"2026-07-10","freshness_hours":366.2,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['threshold edge — freshness EQUALS the threshold',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-27","freshness_hours":26,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['threshold edge — freshness just OVER the threshold',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-27","freshness_hours":26.1,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['payload threshold 1 — a 2h surface is STALE only if the field is read',
    '{"schema_version":1,"capture_freshness_threshold_hours":1,"capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":2,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['payload threshold 0 — a deliberate zero is not coerced',
    '{"schema_version":1,"capture_freshness_threshold_hours":0,"capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":0.5,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['payload threshold 0 — freshness 0 is still within it',
    '{"schema_version":1,"capture_freshness_threshold_hours":0,"capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":0,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['threshold field ABSENT — both sides fall back to 26 (equal)',
    '{"schema_version":1,"capture":{"a":{"last_day_seen":"2026-07-27","freshness_hours":26,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['threshold field ABSENT — 26.1 is over the fallback (equal)',
    '{"schema_version":1,"capture":{"a":{"last_day_seen":"2026-07-27","freshness_hours":26.1,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['capture is not an object at all',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":[]}'],
  ['a surface with an unusable freshness_hours',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":"not-a-number","events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['a surface missing freshness_hours entirely',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-28","events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['one healthy surface, one broken — the whole verdict is ERROR',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"ok":{"last_day_seen":"2026-07-28","freshness_hours":0,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}},"bad":{"last_day_seen":"2026-07-28","freshness_hours":null,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['hostile surface names (attacker-controlled map keys)',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"<img src=x onerror=alert(1)>":{"last_day_seen":"2026-07-28","freshness_hours":0,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}},"__proto__":{"last_day_seen":"2026-07-20","freshness_hours":190,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['abstained-only surface — page reds it, cron still calls it FRESH',
    '{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":0,"events_today":41,"errors_today":0,"outcomes_7d":{"stored":0,"abstained":41,"deduped":0,"superseded":0,"error":0}}}}'],
  // ---- float() coercion: every one of these is a place bare Number() and
  // python float() DISAGREE, so the real script — not a hand-written
  // expectation — decides what the page must do.
  ...[
    ['blank freshness string (Number("") is 0 — would read FRESH)', '""'],
    ['numeric-string freshness at the threshold', '"26"'],
    ['numeric-string freshness over the threshold', '"26.1"'],
    ['hex-prefixed freshness (Number("0x10") is 16)', '"0x10"'],
    ['binary-prefixed freshness (Number("0b101") is 5)', '"0b101"'],
    ['octal-prefixed freshness (Number("0o17") is 15)', '"0o17"'],
    ['bare "." freshness — no digits at all', '"."'],
    ['inf freshness (Number("inf") is NaN, float("inf") is inf)', '"inf"'],
    ['Infinity freshness', '"Infinity"'],
    ['-inf freshness — trivially within any threshold', '"-inf"'],
    ['nan freshness (all comparisons false)', '"nan"'],
    ['PEP 515 underscored freshness (Number("1_0") is NaN)', '"1_0"'],
    ['whitespace-padded numeric-string freshness', '"  26  "'],
  ].map(([label, freshness]) => [label,
    `{"schema_version":1,"capture_freshness_threshold_hours":26,"capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":${freshness},"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}`]),
  // …and the same coercion on the THRESHOLD side, which has its own
  // raise-to-fallback path in the cron python.
  ['inf threshold — everything is within it',
    '{"schema_version":1,"capture_freshness_threshold_hours":"inf","capture":{"a":{"last_day_seen":"2026-06-01","freshness_hours":999,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['nan threshold — nothing is within it',
    '{"schema_version":1,"capture_freshness_threshold_hours":"nan","capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":0,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['malformed threshold string — falls back to 26 on both sides',
    '{"schema_version":1,"capture_freshness_threshold_hours":"0x10","capture":{"a":{"last_day_seen":"2026-07-27","freshness_hours":26,"events_today":0,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
  ['numeric-string threshold',
    '{"schema_version":1,"capture_freshness_threshold_hours":"1","capture":{"a":{"last_day_seen":"2026-07-28","freshness_hours":2,"events_today":1,"errors_today":0,"outcomes_7d":{"stored":1,"abstained":0,"deduped":0,"superseded":0,"error":0}}}}'],
];

// Invoke the SHIPPED um-alert.sh under an isolated HOME with a MOCK_BIN curl
// serving `body` in um-api.sh's wire format (body + __UM_HTTP_CODE__ sentinel).
function runUmAlert(root, label, body) {
  const dir = path.join(root, label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40));
  mkdirSync(dir, { recursive: true });
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const responsePath = path.join(dir, 'response.txt');
  writeFileSync(responsePath, `${body}\n__UM_HTTP_CODE__200\n`);
  const curl = path.join(dir, 'curl');
  writeFileSync(curl, `#!/bin/bash\ncat "${responsePath.replace(/\\/g, '/')}"\nexit 0\n`);
  chmodSync(curl, 0o755);

  const env = { ...process.env };
  // Isolate every tier um-api.sh / um-alert.sh consult, so a developer's real
  // ~/.um config or exported UM_* vars cannot reach the child.
  delete env.UM_LIB_DIR;
  delete env.UM_TOKEN_FILE;
  env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  env.HOME = home;
  env.UM_SERVER_URL = 'http://mock';
  env.UM_ENDPOINT = '';

  // NO --max-age-hours: the payload's own threshold must be the one used.
  // cwd is the throwaway fixture dir, never the repo: um-alert.sh resolves
  // everything from absolute paths, and a child that writes anything relative
  // (a Windows `py` bootstrap will drop a whole runtime into CWD on first run)
  // must not litter the working tree.
  const r = spawnSync('bash', [UM_ALERT], { env, cwd: dir, encoding: 'utf8' });
  assert.equal(r.error, undefined, `${label}: um-alert.sh could not be spawned — ${r.error?.message}`);
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('A12: captureVerdict and the shipped um-alert.sh agree on every fixture', () => {
  const root = tempDir('um-a12-');
  const seen = new Set();
  try {
    for (const [label, body] of A12_FIXTURES) {
      const payload = JSON.parse(body);
      const page = captureVerdict(payload.capture, payload.capture_freshness_threshold_hours);
      const cron = runUmAlert(root, label, body);
      seen.add(cron.code);
      assert.equal(
        cron.code, EXIT_FOR_VERDICT[page.verdict],
        `${label}: page says ${page.verdict} (${page.state}) but um-alert.sh exited ${cron.code} — ${cron.out.trim()}`,
      );
      // …and the page's colour is the taxonomy's. NOT "impossible by
      // construction": the guarantee is exactly this fixture table plus the
      // ONE documented residual in pyFloat (non-ASCII Unicode decimal digits,
      // which python parses and JS does not) — and that residual resolves to
      // page-ERROR/grey where cron may say FRESH, i.e. the page can be more
      // alarming than cron, never less. It is also unreachable in-process.
      assert.equal(page.state, { FRESH: 'green', STALE: 'red', ERROR: 'grey' }[page.verdict], label);
    }
    // A guard on the HARNESS: if the mock ever stopped reaching the real python
    // verdict block, every fixture would collapse to one exit code (2) and the
    // agreement above would be vacuously true.
    assert.deepEqual([...seen].sort(), [0, 1, 2], 'the fixture table drives all three cron exit classes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
