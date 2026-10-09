/**
 * exact-token-203-census.test.mjs — #203 PR 2 (spec D9, §4.2.6, §4.2.8; plan T5):
 * the retrospective query-shape census library.
 *
 * Registered cases:
 *   S1  a fixture snapshot yields the expected per-source counts over the rule's
 *       window; items and V_* outside 2026-09-10..2026-10-08 are dropped
 *   S2  a memory_search call present in two files counts once (and a resumed
 *       session's copied first prompt counts once)
 *   S3  sidechain/subagent sessions contribute no first prompt, but their
 *       memory_search calls count
 *   S4  a session whose first prompt is under 5 chars is classified on its next
 *       prompt; P_dom and the D10 branch from a fixture counters export match a
 *       hand computation, including s_agent = 0 with no agent calls; the output
 *       contains no prompt text
 *   P3 (census half) a malformed transcript line is skipped and counted, and
 *       neither the result nor an error path echoes any transcript text
 *
 * Every transcript line is SYNTHETIC (fixtures/exact-token-203-census.fixture.mjs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/tmpdir.mjs';
import {
  CENSUS_FILES, CENSUS_COUNTERS, CENSUS_EXPECTED, CENSUS_MARKER, materializeCensusFixture,
} from './fixtures/exact-token-203-census.fixture.mjs';
import { runCensus, d10Branch } from '../eval/lib/query-shape-census.mjs';
import { loadRule } from '../eval/lib/exact-token-203-rule.mjs';

const RULE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'eval', 'exact-token-203-accept-rule.json');
const loaded = loadRule(readFileSync(RULE_PATH));
const RULE = loaded.rule;

async function censusOn(files = CENSUS_FILES, counters = CENSUS_COUNTERS) {
  const dir = tempDir('um-et203-census-');
  const paths = await materializeCensusFixture(dir, { files, counters });
  return { dir, paths, res: await runCensus({ ...paths, rule: RULE }) };
}

test('the tracked rule loads (the census reads its window, threshold and mapping from it)', () => {
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(RULE.census.census_from, '2026-09-10');
  assert.equal(RULE.census.census_until, '2026-10-08');
});

test('S1 per-source counts over the rule window; out-of-window items and volume dropped', async () => {
  const { res } = await censusOn();
  assert.equal(res.ok, true, JSON.stringify(res));
  const c = res.census;
  assert.deepEqual(c.window, { from: '2026-09-10', until: '2026-10-08' });
  assert.deepEqual(c.first_prompts, CENSUS_EXPECTED.first_prompts);
  assert.deepEqual(c.agent_calls, CENSUS_EXPECTED.agent_calls);
  assert.equal(c.volume.plugin, CENSUS_EXPECTED.volume.plugin, 'claude-code-plugin 10 + 5 inside; the 09-09 row is outside');
  assert.equal(c.volume.unknown, CENSUS_EXPECTED.volume.unknown, 'unknown 3 + 2 inside; the 10-09 row is outside');
  assert.equal(c.volume.excluded, 4, 'mem0-compat is reported as excluded volume, never weighted');
  assert.equal(c.undated_items, 1, 'the session whose first prompt carries no timestamp');
});

test('S1 the window is inclusive at both ends and read from the rule, not hard-coded', async () => {
  // Shift the window one day earlier: sess-a6's prompt (10-08T23:59:59Z) falls out,
  // and the 09-09 counters row comes in.
  const shifted = loadRule(Buffer.from(JSON.stringify({
    ...JSON.parse(readFileSync(RULE_PATH, 'utf8')),
    census: { ...RULE.census, census_from: '2026-09-09', census_until: '2026-10-07' },
  }))).rule;
  const dir = tempDir('um-et203-census-');
  const paths = await materializeCensusFixture(dir);
  const res = await runCensus({ ...paths, rule: shifted });
  assert.equal(res.ok, true);
  assert.equal(res.census.first_prompts.total, CENSUS_EXPECTED.first_prompts.total - 1);
  assert.equal(res.census.volume.plugin, 100 + 10, '09-09 in, 10-08 out');
});

test('S2 a memory_search call in two files, and a copied first prompt, each count once', async () => {
  const { res } = await censusOn();
  assert.equal(res.census.agent_calls.total, 5, 'toolu_D1 appears inline (sidechain) in the main file and in its subagent file');
  // Without the duplicate the dominant count drops by exactly one.
  const files = { ...CENSUS_FILES };
  delete files['C--proj-alpha/sess-a5/subagents/agent-y1.jsonl'];
  const { res: res2 } = await censusOn(files);
  assert.equal(res2.census.agent_calls.total, 5, 'removing the second copy changes nothing');
  assert.equal(res2.census.first_prompts.total, 6, 'the resumed file\'s copy of sess-a1\'s first prompt is not a new session');
});

test('S3 sidechain sessions give no first prompt; their memory_search calls count', async () => {
  const { res } = await censusOn();
  // The subagent file holds a user line (the task prompt) and toolu_S1.
  const only = { 'p/sess-z/subagents/agent-q.jsonl': CENSUS_FILES['C--proj-alpha/sess-a1/subagents/agent-x1.jsonl'] };
  const { res: alone } = await censusOn({ ...only, 'p/sess-m.jsonl': [CENSUS_FILES['C--proj-alpha/sess-a6.jsonl'][1]] });
  assert.equal(alone.ok, true, JSON.stringify(alone));
  assert.equal(alone.census.first_prompts.total, 1, 'only the main session contributes a first prompt');
  assert.equal(alone.census.agent_calls.total, 1);
  assert.equal(alone.census.agent_calls.dominant, 1, 'toolu_S1 (v9.8.7 widget) is dominant');
  assert.ok(res.census.agent_calls.total >= 1);
  // An isSidechain line in a MAIN file is not a first prompt either.
  const inline = { 'p/sess-k.jsonl': [{ ...CENSUS_FILES['C--proj-alpha/sess-a4.jsonl'][0], sessionId: 'sess-k', timestamp: '2026-09-20T00:00:00.000Z', isSidechain: true }] };
  const { res: inl } = await censusOn({ ...inline, 'p/sess-m.jsonl': [CENSUS_FILES['C--proj-alpha/sess-a6.jsonl'][1]] });
  assert.equal(inl.census.first_prompts.total, 1);
});

test('S4 a first prompt under 5 chars is skipped; the next prompt is classified', async () => {
  const files = {
    'p/sess-s.jsonl': [
      { type: 'user', sessionId: 'sess-s', uuid: 's1', timestamp: '2026-09-20T00:00:00.000Z', isSidechain: false, message: { role: 'user', content: 'ok\n\n' } },
      { type: 'user', sessionId: 'sess-s', uuid: 's2', timestamp: '2026-09-20T00:01:00.000Z', isSidechain: false, message: { role: 'user', content: 'UM_SHORT_FLAG' } },
      { type: 'user', sessionId: 'sess-s', uuid: 's3', timestamp: '2026-09-20T00:02:00.000Z', isSidechain: false, message: { role: 'user', content: 'plain words only here' } },
    ],
  };
  const { res } = await censusOn(files, [{ day: '2026-09-20', surface: 'claude-code-plugin', n: 1 }]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.census.first_prompts, { total: 1, none: 0, embedded: 0, dominant: 1 });
});

test('S4 P_dom and the D10 branch match a hand computation', async () => {
  const { res } = await censusOn();
  const c = res.census;
  assert.equal(c.s_first, CENSUS_EXPECTED.s_first);
  assert.equal(c.s_agent, CENSUS_EXPECTED.s_agent);
  // (0.5 * 15 + 0.6 * 5) / 20
  assert.ok(Math.abs(c.p_dom - CENSUS_EXPECTED.p_dom) < 1e-12, String(c.p_dom));
  assert.equal(c.threshold, 0.05);
  assert.equal(c.prevalence, 'at-or-above-threshold');
  assert.equal(d10Branch('GAP', c), 'close-and-open-remedy-issue');
  assert.equal(d10Branch('NO-GAP', c), 'close-no-remedy');
  assert.equal(d10Branch('REVERSE', c), 'close-no-remedy');
  assert.equal(d10Branch('GAP (seed-carried)', c), 'close-with-bound');
  assert.equal(d10Branch('INCONCLUSIVE', c), 'close-with-bound');
  assert.equal(d10Branch('VOID', c), 'keep-open-void');
});

test('S4 s_agent = 0 with no agent calls; a low P_dom takes the parked branch', async () => {
  const files = Object.fromEntries(Object.entries(CENSUS_FILES).map(([k, lines]) => [
    k, lines.filter((l) => !(typeof l === 'object' && l.type === 'assistant')),
  ]));
  const counters = [
    { day: '2026-09-11', surface: 'claude-code-plugin', n: 1 },
    { day: '2026-09-11', surface: 'unknown', n: 99 },
  ];
  const { res } = await censusOn(files, counters);
  assert.equal(res.ok, true, JSON.stringify(res));
  const c = res.census;
  assert.equal(c.agent_calls.total, 0);
  assert.equal(c.s_agent, 0);
  assert.equal(c.s_first, 0.5);
  // (0.5 * 1 + 0 * 99) / 100
  assert.ok(Math.abs(c.p_dom - 0.005) < 1e-12, String(c.p_dom));
  assert.equal(c.prevalence, 'below-threshold');
  assert.equal(d10Branch('GAP', c), 'close-and-open-parked-issue');
});

test('S4 / P3 the census result carries aggregates only: no prompt, query or path text', async () => {
  const { res, dir } = await censusOn();
  const text = JSON.stringify(res);
  assert.ok(!text.includes(CENSUS_MARKER), 'prompt text leaked');
  for (const needle of ['UM_FAKE_FLAG', 'widget', 'reindex', '#4321', 'stats.mjs', 'sess-a1', 'proj-alpha', 'toolu_', dir]) {
    assert.ok(!text.includes(needle), `result carries ${needle}`);
  }
});

test('P3 a malformed transcript line is skipped and counted, never echoed', async () => {
  const { res } = await censusOn();
  assert.equal(res.census.malformed_lines, CENSUS_EXPECTED.malformed_lines);
  assert.ok(!JSON.stringify(res).includes('cut off'));
});

test('P3 census error paths return codes only', async () => {
  const dir = tempDir('um-et203-census-');
  const paths = await materializeCensusFixture(dir);
  // Malformed counters export (quotes transcript-like text in a field).
  writeFileSync(paths.countersPath, JSON.stringify([{ day: CENSUS_MARKER, surface: 'unknown', n: 1 }]));
  const bad = await runCensus({ ...paths, rule: RULE });
  assert.deepEqual(bad, { ok: false, code: 'census-counters-malformed' });
  writeFileSync(paths.countersPath, `not json ${CENSUS_MARKER}`);
  assert.deepEqual(await runCensus({ ...paths, rule: RULE }), { ok: false, code: 'census-counters-malformed' });
  // Missing inputs.
  assert.deepEqual(await runCensus({ transcriptsDir: join(dir, 'nope'), countersPath: paths.countersPath, rule: RULE }),
    { ok: false, code: 'census-input-missing' });
  // No volume in the window.
  writeFileSync(paths.countersPath, JSON.stringify([{ day: '2026-01-01', surface: 'unknown', n: 3 }]));
  assert.deepEqual(await runCensus({ ...paths, rule: RULE }), { ok: false, code: 'census-no-volume' });
  // No first prompt in the window.
  const empty = tempDir('um-et203-census-');
  const p2 = await materializeCensusFixture(empty, { files: { 'p/sess-q.jsonl': [CENSUS_FILES['C--proj-alpha/sess-a4.jsonl'][0]] } });
  assert.deepEqual(await runCensus({ ...p2, rule: RULE }), { ok: false, code: 'census-no-first-prompts' });
});
