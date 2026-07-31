// server/test/stats.test.mjs — U1 (#171 Stage A): lib/stats.mjs counters reader
// + freshness math. (The eval percentile helper's tests live in
// eval-stats.test.mjs — different module, server/eval/lib/stats.mjs.)
//
// Covers (spec §3 capture contract + §5 A2/A5, plan U1):
//   • Pinned freshness formula, EXACT frozen-clock values (A2): rows today ⇒ 0
//     (clamp); last capture row 3 days ago ⇒ 48 + hours_since_utc_midnight(now).
//   • G2 incident case: a surface with ONLY recall.search rows today and
//     capture.* rows 3 days ago shows the 3-day freshness (scope filter holds).
//   • Scope filter both ways: recall.search rows excluded from every capture
//     aggregate, included in the recall aggregates.
//   • errors_today today-scoped; outcomes_7d 7-day window edge (day 8 out);
//     growth_7d includes superseded, excludes deduped/abstained/error.
//   • A5 shapes: missing db file ⇒ null-shaped; empty db ⇒ empty-but-not-null;
//     unreadable (corrupt) db ⇒ null-shaped, never throws.
//   • Per-surface independence; writer-compat (T5 recordCaptureEvent rows are
//     readable); stale-beyond-window surfaces still reported (alert case).
//
// CLOCK SEAM: every call passes a frozen `now` — nothing here depends on the
// wall clock except the writer-compat test (which only asserts today-shaped
// facts and passes Date.now() as the frozen value).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readCounterStats, freshnessHours } from '../lib/stats.mjs';
import {
  recordCaptureEvent,
  CAPTURE_EVENTS,
  _resetCaptureEventsForTest,
} from '../lib/capture-events.mjs';
import { seedCountersDb } from './helpers/counters-db.mjs';

// ---------- helpers ----------

const MS_PER_DAY = 86_400_000;

// Frozen clock: 2026-07-17T09:30:00Z ⇒ hours_since_utc_midnight = 9.5 exactly.
const NOW = Date.UTC(2026, 6, 17, 9, 30, 0);
const TODAY = '2026-07-17';

function dayStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function daysAgo(n) {
  return dayStr(NOW - n * MS_PER_DAY);
}

async function tempDbPath(prefix = 'um-stats-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return path.join(dir, 'um-counters.db');
}

const EMPTY_OUTCOMES = { stored: 0, abstained: 0, deduped: 0, superseded: 0, error: 0 };

// ---------- freshnessHours: pinned formula (A2 exact values) ----------

test('freshnessHours: last_day_seen today ⇒ 0 (end-of-day is in the future; clamp)', () => {
  assert.equal(freshnessHours(TODAY, NOW), 0);
});

test('freshnessHours: last_day_seen 3 days ago ⇒ exactly 48 + hours_since_utc_midnight(now)', () => {
  // D=3 ⇒ (3−1)*24 + 9.5 = 57.5 — exact, not a range (spec A2).
  assert.equal(freshnessHours(daysAgo(3), NOW), 57.5);
});

test('freshnessHours: last_day_seen yesterday (D=1) ⇒ hours_since_utc_midnight(now) only', () => {
  assert.equal(freshnessHours(daysAgo(1), NOW), 9.5);
});

test('freshnessHours: future last_day_seen (clock skew) clamps to 0, never negative', () => {
  assert.equal(freshnessHours(dayStr(NOW + MS_PER_DAY), NOW), 0);
});

test('freshnessHours rounds to 1 decimal', () => {
  const now = Date.UTC(2026, 6, 17, 9, 20, 0); // 9h20m ⇒ 9.333… ⇒ 9.3
  assert.equal(freshnessHours('2026-07-14', now), 57.3);
});

// ---------- readCounterStats: capture aggregates ----------

test('rows today ⇒ freshness_hours 0, last_day_seen today, events_today counted', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 4 },
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 2 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.equal(stats.available, true);
  const s = stats.capture['claude-code'];
  assert.equal(s.last_day_seen, TODAY);
  assert.equal(s.freshness_hours, 0);
  assert.equal(s.events_today, 6);
  assert.equal(s.errors_today, 0);
  assert.deepEqual(s.outcomes_7d, { ...EMPTY_OUTCOMES, stored: 6 });
});

test('A2: last capture row 3 days ago ⇒ freshness_hours exactly 57.5 at the frozen clock', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: daysAgo(3), surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 5 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const s = stats.capture['claude-code'];
  assert.equal(s.last_day_seen, daysAgo(3));
  assert.equal(s.freshness_hours, 57.5, 'pinned formula: (3−1)*24 + 9.5');
  assert.equal(s.events_today, 0);
  assert.deepEqual(s.outcomes_7d, { ...EMPTY_OUTCOMES, stored: 5 }, 'day −3 is inside the 7-day window');
});

test('G2 incident case: only recall.search today + capture.* 3 days ago ⇒ 3-day freshness', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: daysAgo(3), surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 2 },
    { day: TODAY, surface: 'claude-code', event: 'recall.search', outcome: '', count: 9 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const s = stats.capture['claude-code'];
  assert.equal(s.last_day_seen, daysAgo(3), 'a live search pipeline MUST NOT refresh a dead capture pipeline');
  assert.equal(s.freshness_hours, 57.5);
  assert.equal(s.events_today, 0, 'recall rows are not capture events');
  assert.equal(stats.recall.searches_today, 9, 'recall rows still feed the recall aggregates');
});

test('scope filter: recall.search rows excluded from every capture aggregate, included in recall', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'discord', event: 'capture.turn', outcome: 'stored', count: 3 },
    { day: TODAY, surface: 'discord', event: 'recall.search', outcome: '', count: 7 },
    { day: daysAgo(2), surface: 'discord', event: 'recall.search', outcome: '', count: 4 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const s = stats.capture.discord;
  assert.equal(s.events_today, 3, 'searches must not inflate events_today');
  assert.deepEqual(s.outcomes_7d, { ...EMPTY_OUTCOMES, stored: 3 });
  assert.equal(stats.recall.searches_today, 7);
  assert.equal(stats.recall.searches_7d, 11);
});

test('errors_today is today-scoped: an error row yesterday does not count', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: daysAgo(1), surface: 'claude-code', event: 'capture.checkpoint', outcome: 'error', count: 3 },
    { day: TODAY, surface: 'claude-code', event: 'capture.checkpoint', outcome: 'error', count: 1 },
    { day: TODAY, surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 2 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const s = stats.capture['claude-code'];
  assert.equal(s.errors_today, 1, "yesterday's errors are outcomes_7d material, not errors_today");
  assert.equal(s.events_today, 3);
  assert.deepEqual(s.outcomes_7d, { ...EMPTY_OUTCOMES, stored: 2, error: 4 });
});

test('outcomes_7d window edge: day 8 excluded, day 7 (oldest in-window) included', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: daysAgo(7), surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 100 },
    { day: daysAgo(6), surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 1 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const s = stats.capture['claude-code'];
  assert.deepEqual(s.outcomes_7d, { ...EMPTY_OUTCOMES, stored: 1 }, 'window = today + 6 prior days');
  assert.equal(s.last_day_seen, daysAgo(6));
});

test('a surface stale beyond the 7-day window still reports last_day_seen + freshness (alert case)', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: daysAgo(30), surface: 'openclaw', event: 'capture.turn', outcome: 'stored', count: 5 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const s = stats.capture.openclaw;
  assert.ok(s, 'a long-dead surface must not vanish from the capture section');
  assert.equal(s.last_day_seen, daysAgo(30));
  assert.equal(s.freshness_hours, 29 * 24 + 9.5);
  assert.equal(s.events_today, 0);
  assert.deepEqual(s.outcomes_7d, EMPTY_OUTCOMES);
});

test('per-surface independence: two surfaces do not cross-contaminate', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 3 },
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'error', count: 1 },
    { day: daysAgo(3), surface: 'discord', event: 'capture.turn', outcome: 'stored', count: 8 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const cc = stats.capture['claude-code'];
  const dc = stats.capture.discord;
  assert.equal(cc.freshness_hours, 0);
  assert.equal(cc.events_today, 4);
  assert.equal(cc.errors_today, 1);
  assert.equal(dc.freshness_hours, 57.5, "claude-code's fresh rows must not refresh discord");
  assert.equal(dc.events_today, 0);
  assert.equal(dc.errors_today, 0);
  assert.deepEqual(dc.outcomes_7d, { ...EMPTY_OUTCOMES, stored: 8 });
});

// ---------- readCounterStats: growth_7d ----------

test('growth_7d counts capture.extraction stored + superseded per day; excludes deduped/abstained/error', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 3 },
    { day: TODAY, surface: 'discord', event: 'capture.extraction', outcome: 'superseded', count: 2 },
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'deduped', count: 50 },
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'abstained', count: 50 },
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'error', count: 50 },
    { day: daysAgo(2), surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 4 },
    // Same-name outcome on a NON-extraction event must not count toward growth.
    { day: TODAY, surface: 'claude-code', event: 'capture.turn', outcome: 'stored', count: 50 },
    // Day 8: outside the window.
    { day: daysAgo(7), surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 50 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const expected = {};
  for (let i = 6; i >= 0; i--) expected[daysAgo(i)] = 0;
  expected[TODAY] = 5;       // 3 stored + 2 superseded (cross-surface sum)
  expected[daysAgo(2)] = 4;
  assert.deepEqual(stats.growth_7d, expected, 'zero-filled 7-day map');
});

// ---------- readCounterStats: growth_docs_7d (#185 doc-tier visibility) ----------

test('growth_docs_7d counts capture.checkpoint stored + error per day; excludes abstained and extraction rows', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'claude-code-plugin', event: 'capture.checkpoint', outcome: 'stored', count: 43 },
    // UPSTREAM_FAILURE checkpoints DID write the summary doc (only the index
    // is stale) — they count as doc-tier writes (#185 review finding).
    { day: TODAY, surface: 'claude-code-plugin', event: 'capture.checkpoint', outcome: 'error', count: 2 },
    // Abstained checkpoints wrote nothing — excluded by design.
    { day: TODAY, surface: 'claude-code-plugin', event: 'capture.checkpoint', outcome: 'abstained', count: 50 },
    // Fact-tier extraction rows must not leak into the docs counter.
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 50 },
    { day: daysAgo(3), surface: 'mem0-compat', event: 'capture.checkpoint', outcome: 'stored', count: 7 },
    // Day 8: outside the window.
    { day: daysAgo(7), surface: 'claude-code-plugin', event: 'capture.checkpoint', outcome: 'stored', count: 50 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  const expected = {};
  for (let i = 6; i >= 0; i--) expected[daysAgo(i)] = 0;
  expected[TODAY] = 45;      // 43 stored + 2 error
  expected[daysAgo(3)] = 7;  // cross-surface sum
  assert.deepEqual(stats.growth_docs_7d, expected, 'zero-filled 7-day map of doc-tier writes');
});

// ---------- readCounterStats: degraded / empty shapes (A5) ----------

test('missing db file ⇒ null-shaped result, no throw', async () => {
  const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'um-stats-missing-')), 'nope.db');
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.deepEqual(stats, { available: false, capture: null, growth_7d: null, growth_docs_7d: null, recall: null });
});

test('unreadable (corrupt) db ⇒ null-shaped result, no throw', async () => {
  const dbPath = await tempDbPath();
  await fs.writeFile(dbPath, 'not a sqlite database — garbage bytes');
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.deepEqual(stats, { available: false, capture: null, growth_7d: null, growth_docs_7d: null, recall: null });
});

test('empty db (schema, zero rows) ⇒ empty-but-not-null shapes', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, []);
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.equal(stats.available, true);
  // { __proto__: null }: capture is a null-prototype map (hostile-key fix) and
  // strict deepEqual compares prototypes.
  assert.deepEqual(stats.capture, { __proto__: null }, 'no surfaces yet — empty object, not null');
  const expectedGrowth = {};
  for (let i = 6; i >= 0; i--) expectedGrowth[daysAgo(i)] = 0;
  assert.deepEqual(stats.growth_7d, expectedGrowth);
  assert.deepEqual(stats.recall, { searches_today: 0, searches_7d: 0 });
});

test('readCounterStats requires an explicit now (clock seam — no implicit Date.now())', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, []);
  assert.throws(() => readCounterStats({ dbPath }), TypeError);
});

// ---------- hostile surface names (v1.8.1 shipped-bug fix) ----------
// `surface` is attacker-controlled (X-UM-Source has no charset restriction).
// On a plain object literal, assigning key '__proto__' hits the prototype
// setter instead of creating an own property — the surface vanished from
// Object.keys / JSON.stringify / the API, so a capture surface could never
// appear on a freshness view (exactly what the §4 alert exists to show).

test('capture: a surface named __proto__ is reported as data, not swallowed by the prototype setter', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: '__proto__', event: 'capture.checkpoint', outcome: 'stored', count: 2 },
    { day: TODAY, surface: 'claude-code', event: 'capture.checkpoint', outcome: 'stored' },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.ok(Object.hasOwn(stats.capture, '__proto__'), '__proto__ must be an own, enumerable surface key');
  // The route serves JSON.stringify(capture) — the surface must survive the round trip.
  const served = JSON.parse(JSON.stringify(stats.capture));
  assert.deepEqual(served['__proto__'], {
    last_day_seen: TODAY,
    freshness_hours: 0,
    events_today: 2,
    errors_today: 0,
    outcomes_7d: { ...EMPTY_OUTCOMES, stored: 2 },
  });
  // Neighbouring surface unpoisoned by the hostile key.
  assert.equal(served['claude-code'].events_today, 1);
});

// ---------- writer-compat: T5 recordCaptureEvent rows are readable ----------

test('rows written by recordCaptureEvent (T5 writer) read back through readCounterStats', async () => {
  const dbPath = await tempDbPath('um-stats-writer-');
  const prev = process.env.UM_COUNTERS_DB_PATH;
  process.env.UM_COUNTERS_DB_PATH = dbPath;
  _resetCaptureEventsForTest();
  try {
    recordCaptureEvent({ surface: 'claude-code', project: 'um', event: CAPTURE_EVENTS.TURN, outcome: 'stored' });
    recordCaptureEvent({ surface: 'claude-code', project: 'um', event: CAPTURE_EVENTS.TURN, outcome: 'stored' });
    // Writer hardcodes day=today (real clock) — pass the real clock as the frozen now.
    const stats = readCounterStats({ now: Date.now(), dbPath });
    const s = stats.capture['claude-code'];
    assert.equal(s.events_today, 2);
    assert.equal(s.freshness_hours, 0);
    assert.deepEqual(s.outcomes_7d, { ...EMPTY_OUTCOMES, stored: 2 });
  } finally {
    if (prev !== undefined) process.env.UM_COUNTERS_DB_PATH = prev;
    else delete process.env.UM_COUNTERS_DB_PATH;
    _resetCaptureEventsForTest();
  }
});

// ---------- #187: signal.reaction — reactions_7d + namespace isolation ----------

test('reactions_7d: zero-filled REACTION_OUTCOME_KEYS shape, attached to the surface capture block', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'mem0-compat', event: 'capture.extraction', outcome: 'stored', count: 3 },
    { day: TODAY, surface: 'mem0-compat', event: 'signal.reaction', outcome: 'stored', count: 2 },
    { day: daysAgo(2), surface: 'mem0-compat', event: 'signal.reaction', outcome: 'abstained', count: 1 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.deepEqual(stats.capture['mem0-compat'].reactions_7d, { stored: 2, abstained: 1, unaddressed: 0 });
});

test('reactions_7d: absent when a surface has no reaction rows (omit-when-zero)', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 1 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.ok(!('reactions_7d' in stats.capture['claude-code']));
});

test('NAMESPACE ISOLATION (spec R3 pin): signal.reaction rows leave the WHOLE readCounterStats output byte-identical modulo reactions_7d', async () => {
  // Capture rows deliberately OFF today: with last_day_seen at daysAgo(2) and
  // events_today at 0, the TODAY reaction rows below would visibly advance
  // freshness AND events_today if the namespace filter ever regressed —
  // keeping them on TODAY made the freshness half vacuous (mutation-verified
  // in review).
  const baseRows = [
    { day: daysAgo(2), surface: 'discord', event: 'capture.extraction', outcome: 'stored', count: 4 },
    { day: daysAgo(2), surface: 'discord', event: 'capture.checkpoint', outcome: 'stored', count: 1 },
    { day: daysAgo(1), surface: 'discord', event: 'recall.search', outcome: '', count: 6 },
  ];
  const cleanPath = await tempDbPath('um-stats-clean-');
  seedCountersDb(cleanPath, baseRows);
  const clean = readCounterStats({ now: NOW, dbPath: cleanPath });

  const reactedPath = await tempDbPath('um-stats-reacted-');
  seedCountersDb(reactedPath, [
    ...baseRows,
    // TODAY reaction rows on a surface last captured daysAgo(2): a regressed
    // capture.% filter would advance last_day_seen 2 days AND lift events_today
    // from 0 — both diffs the strip-compare below would catch.
    { day: TODAY, surface: 'discord', event: 'signal.reaction', outcome: 'stored', count: 3 },
    { day: TODAY, surface: 'discord', event: 'signal.reaction', outcome: 'abstained', count: 1 },
  ]);
  const reacted = readCounterStats({ now: NOW, dbPath: reactedPath });

  // Strip only the additive field, then demand byte-identical everything:
  // capture (events_today, freshness, outcomes_7d), growth_7d, growth_docs_7d, recall.
  const strip = (stats) => JSON.parse(JSON.stringify(stats, (k, v) => (k === 'reactions_7d' ? undefined : v)));
  assert.deepEqual(strip(reacted), strip(clean));
  assert.deepEqual(reacted.capture.discord.reactions_7d, { stored: 3, abstained: 1, unaddressed: 0 });
});

test('reaction-only surface: rows are SKIPPED (no capture entry, no throw, stats stay available)', async () => {
  const dbPath = await tempDbPath();
  seedCountersDb(dbPath, [
    { day: TODAY, surface: 'claude-code', event: 'capture.extraction', outcome: 'stored', count: 1 },
    // A surface with ONLY reaction rows — unreachable from our writer (co-emit
    // invariant) but the reader must not trust the writer.
    { day: TODAY, surface: 'ghost-surface', event: 'signal.reaction', outcome: 'stored', count: 9 },
  ]);
  const stats = readCounterStats({ now: NOW, dbPath });
  assert.equal(stats.available, true);
  assert.ok(!('ghost-surface' in stats.capture));
  assert.ok(!('reactions_7d' in stats.capture['claude-code']));
});
