// server/test/control-page-imputation.test.mjs — #297 T4, R8b: the ONE imputation row the
// hand-authored /control corpus tile gains (spec D21), behind the file's own asPlainObject guard.
//
// The page is a pure function of the payload: present block ⇒ one row rendering the WIRE names
// (mode, cohort_n, age_days_at_quantile, applied_factor, computed_age_ms, last_refresh_failed);
// absent or malformed block ⇒ no row, no throw. Untrusted text (mode) reaches the page only as
// entity-escaped element text, as every other tile already guarantees.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderControlPage } from '../lib/control-page.mjs';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const CSRF = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';

function makeStats(overrides = {}) {
  return {
    schema_version: 1,
    generated_at: '2026-09-04T12:00:00.000Z',
    capture_freshness_threshold_hours: 26,
    server: { version: '1.20.0', uptime_s: 100, writes_enabled: true, mount_mode: 'rw' },
    corpus: { points: 586, points_by_project: { 'universal-memory': 400, '(unknown)': 186 }, scan_saturated: false, growth_7d: {}, growth_docs_7d: {}, derived_from: 'extraction-counters' },
    capture: {},
    layers: {},
    recall: { searches_today: 3, searches_7d: 20, latency_since_boot: { p50_ms: 40, p95_ms: 120, n: 12, label: 'serving latency' } },
    ...overrides,
  };
}

const render = (stats) => renderControlPage({ stats, nonce: NONCE, csrf: CSRF });

function corpusSection(html) {
  const start = html.indexOf('<h2>Corpus</h2>');
  assert.ok(start >= 0, 'the Corpus tile renders');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

const block = (overrides = {}) => ({
  enabled: true, mode: 'relative', quantile: 0.5, cohort_n: 400, age_days_at_quantile: 28.7, future_excluded: 0,
  computed_at: 1757000000000, last_attempt_at: 1757000000000, last_refresh_ms: 12, last_scan_items: 586,
  last_refresh_failed: false, last_error: null, saturated: false, ttl_ms: 3600000, half_life_days: 30,
  factor: 0.384, applied_factor: 0.384, computed_age_ms: 120000, attempt_age_ms: 120000,
  ...overrides,
});

test('R8b: a present block renders ONE imputation row in the Corpus tile with the wire values', () => {
  const section = corpusSection(render(makeStats({ undated_imputation: block() })));
  assert.match(section, /Undated imputation/);
  assert.equal((section.match(/Undated imputation/g) ?? []).length, 1, 'exactly one row');
  for (const needle of ['relative', '400', '28.7', '0.384', '120000']) {
    assert.ok(section.includes(needle), `renders ${needle}`);
  }
  assert.match(section, /last refresh ok|refresh ok/i);
});

test('R8b: last_refresh_failed:true is rendered visibly, decay off shows applied 1', () => {
  const failed = corpusSection(render(makeStats({ undated_imputation: block({ last_refresh_failed: true, last_error: 'qdrant down' }) })));
  assert.match(failed, /last refresh FAILED/i);
  const off = corpusSection(render(makeStats({ undated_imputation: block({ enabled: false, mode: 'fallback', factor: null, applied_factor: 1, cohort_n: null, age_days_at_quantile: null, computed_age_ms: null }) })));
  assert.match(off, /Undated imputation/);
  assert.match(off, /fallback/);
});

test('R8b: an absent block ⇒ no row, no throw', () => {
  const section = corpusSection(render(makeStats()));
  assert.doesNotMatch(section, /Undated imputation/);
});

test('R8b: a malformed block (string, array, number, null) ⇒ no row, no throw', () => {
  for (const bad of ['relative', ['x'], 42, null]) {
    const html = render(makeStats({ undated_imputation: bad }));
    assert.doesNotMatch(corpusSection(html), /Undated imputation/, `malformed ${JSON.stringify(bad)}`);
  }
});

test('R8b: a hostile mode string is entity-escaped, never markup', () => {
  const html = render(makeStats({ undated_imputation: block({ mode: '<img src=x onerror=alert(1)>' }) }));
  assert.ok(!html.includes('<img src=x'), 'raw markup must not appear');
  assert.match(html, /&lt;img src=x/);
});
