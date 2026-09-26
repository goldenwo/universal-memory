// server/test/state-cap-eval.test.mjs — #326 T4: the keyed eval's PURE parts, offline.
//
// Mirrors the checkpoint-cost-eval pattern: the matcher, the labels' positive control, the
// pass-1 and pass-2 measurements and the threshold aggregation are named exports of
// eval/state-cap-eval.mjs, unit-tested here with no provider calls and no I/O; the CLI shim
// (inputs on disk, the real summarize, the keyed arms) is guarded by IS_MAIN. The keyed run is
// the decisive reviewer of the PROMPT (spec 4.2.5); these tests pin that the eval measures what
// the spec says it measures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalise,
  findKey,
  extendsCutoff,
  positiveControl,
  pass1Metrics,
  pass2Conditions,
  aggregate,
  THRESHOLDS,
} from '../eval/state-cap-eval.mjs';

const FM = '---\nschema_version: 1\ntype: state\nid: state-x\nvalid_from: 2026-09-20T00:00:00.000Z\nproject: x\n---\n\n# State of play — x\n';
const SUPPLIED = '2026-09-25';

test('normalise: deletes * ` _ ( ) [ ], collapses whitespace, case-folds', () => {
  assert.equal(normalise('- **#329 Codex** exec `capture` (pending) [x]  done'), '- #329 codex exec capture pending x done');
  assert.equal(normalise('  Filed issue [#262](https://x) regarding `m`'), 'filed issue #262https://x regarding m');
});

test('findKey: the normalised key is a substring of a normalised line', () => {
  const lines = ['- **Debugging** the user `authentication` process', '- other'];
  assert.equal(findKey('debugging the user authentication process', lines), 0);
  assert.equal(findKey('DEBUGGING THE USER', lines), 0);
  assert.equal(findKey('not here', lines), -1);
});

test('extendsCutoff: the cut-off text minus its trailing partial word is a prefix of the entry', () => {
  const cutoff = '- Marked vault files as deprecated to ensure on-dis';
  assert.ok(extendsCutoff('- Marked vault files as deprecated to ensure on-disk consistency.', cutoff));
  assert.ok(extendsCutoff('- Marked **vault** files as deprecated to ensure on-disk safety', cutoff), 'normalised on both sides');
  assert.ok(!extendsCutoff('- Marked vault files as archived', cutoff));
  assert.ok(!extendsCutoff('- 2026-09-25: Marked vault files as deprecated to ensure on-disk', cutoff), 'a leading date breaks the prefix');
});

const INPUT = FM + [
  '## Current focus', 'Focus text.',
  '## In flight',
  '- **#329** encoding bug: fix landed, verify on the Pi',
  '- Testing the reboot durability of the containers',
  '- Filed issue #262 regarding m',
  '  - sub-line',
  '- Implement a prune process to remove low-quality captures',
  '## Recent decisions',
  '- 2023-10-06: Implemented a recall pollution probe to assess the unattributed',
  '- 2023-10-07: Kept decision two.',
  '## Next actions',
  '1. Restart the service for the key',
  '2. Finish the 401/403 handling',
  '...',
].join('\n') + '\n';
const LABELS = {
  summary: 's.md', covers_until: '2026-09-25T02:00:00.000Z', headings: ['Current focus', 'In flight', 'Recent decisions', 'Next actions'],
  cutoff_decision_line: '- 2023-10-06: Implemented a recall pollution probe to assess the unattributed',
  recent_decisions_count: 2, stale_issue_refs: { '#329': '2026-09-25T01:30:13Z' },
  units: [
    { section: 'In flight', i: 1, label: 'live', key: '#329', text: '- **#329** encoding bug' },
    { section: 'In flight', i: 2, label: 'live', key: 'testing the reboot durability of', text: '- Testing the reboot' },
    { section: 'In flight', i: 3, label: 'not-work', key: 'filed issue #262', text: '- Filed issue #262' },
    { section: 'In flight', i: 4, label: 'live', key: 'implement a prune process to', text: '- Implement a prune' },
    { section: 'Next actions', i: 1, label: 'live', key: 'restart the service for the', text: '1. Restart' },
    { section: 'Next actions', i: 2, label: 'live', key: 'finish the 401/403 handling', text: '2. Finish' },
  ],
  pass2: [{ key: '#329', mentioned: true }, { key: 'testing the reboot durability of', mentioned: false }],
};

test('positiveControl: passes on a consistent doc + labels; fails on a missing key, an ambiguous key, an unlabelled unit', () => {
  const ok = positiveControl({ x: INPUT }, { x: LABELS });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.keys_found, 6);
  assert.equal(ok.keys_total, 6);
  assert.equal(ok.units_labelled, 6);
  assert.equal(ok.units_parsed, 6, 'the trailing ... line of the old slice is not a unit to label');
  const missing = positiveControl({ x: INPUT }, { x: { ...LABELS, units: [...LABELS.units, { section: 'In flight', i: 9, label: 'live', key: 'nowhere to be found', text: '' }] } });
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.some(m => m.key === 'nowhere to be found'));
  const ambiguous = positiveControl({ x: INPUT }, { x: { ...LABELS, units: LABELS.units.map(u => (u.i === 1 && u.section === 'In flight' ? { ...u, key: 'the' } : u)) } });
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.ambiguous.some(a => a.key === 'the'));
  const unlabelled = positiveControl({ x: INPUT }, { x: { ...LABELS, units: LABELS.units.slice(1) } });
  assert.equal(unlabelled.ok, false);
  assert.ok(unlabelled.unlabelled.some(u => u.section === 'In flight'));
});

test('pass1Metrics: a compliant raw output — six headings, all stamped, nothing future, dating clean, order clean, retention holds, stale carry reported', () => {
  const raw = FM + [
    '## Current focus', 'New focus.',
    '## In flight',
    '- **#329** encoding bug: fix landed, verify on the Pi [2026-09-25]',
    '- Testing the reboot durability of the containers [2026-09-25]',
    '- Implement a prune process to remove low-quality captures [2026-09-25]',
    '## Recent decisions',
    '- 2023-10-06: Implemented a recall pollution probe to assess the unattributed captures.',
    '- 2023-10-07: Kept decision two.',
    '- 2026-09-25: Shipped the fix.',
    '## Next actions',
    '1. Restart the service for the key',
    '2. Finish the 401/403 handling',
    '## Open questions', '(none)',
    '## Environment', '(none)',
  ].join('\n') + '\n';
  const m = pass1Metrics({ raw, input: INPUT, labels: LABELS, suppliedDate: SUPPLIED, report: { added: [], aged: 0, aged_future: 0, bounded: [], trims: [] } });
  assert.equal(m.length, raw.length);
  assert.equal(m.headings, 6);
  assert.equal(m.inflight_units, 3);
  assert.equal(m.all_stamped, true);
  assert.equal(m.future_stamps, 0);
  assert.equal(m.future_decision_dates, 0);
  assert.equal(m.current_focus_len, 'New focus.'.length);
  assert.deepEqual(m.dating, { new_entries: 1, invented: 0, changed_existing: 0, extended: 1 });
  assert.equal(m.order_clean, true);
  assert.equal(m.retention.ok, true);
  assert.deepEqual(m.retention.sections['In flight'], { live: 3, dropped_live: 0, allowed: 0, dropped_mentioned: [] });
  assert.deepEqual(m.retention.sections['Next actions'], { live: 2, dropped_live: 0, allowed: 0, dropped_mentioned: [] });
  assert.deepEqual(m.stale_carry, [{ ref: '#329', stamp: '2026-09-25', closed_at: '2026-09-25T01:30:13Z' }]);
  assert.equal(m.raw_le_cap, true);
});

test('pass1Metrics: the failure shapes — missing heading, unstamped, future stamp and date, invented and changed dates, order, a dropped mentioned live unit', () => {
  const raw = FM + [
    '## Current focus', 'x'.repeat(450),
    '## In flight',
    '- **#329** encoding bug: fix landed [2026-09-25]',
    '- Implement a prune process to remove low-quality captures',
    '- A brand new item [2026-10-30]',
    '## Recent decisions',
    '- 2023-10-07: Kept decision two, reworded.',
    '- 2023-10-06: Implemented a recall pollution probe to assess the unattributed captures.',
    '- 2026-09-24: Shipped the fix.',
    '- 2026-10-30: Decided the future.',
    '## Next actions',
    '2. Finish the 401/403 handling',
    '## Open questions', '(none)',
  ].join('\n') + '\n';
  const m = pass1Metrics({ raw, input: INPUT, labels: LABELS, suppliedDate: SUPPLIED, report: { added: ['Environment'], aged: 0, aged_future: 1, bounded: [], trims: [] } });
  assert.equal(m.headings, 5);
  assert.equal(m.all_stamped, false);
  assert.equal(m.future_stamps, 1);
  assert.equal(m.future_decision_dates, 1);
  assert.equal(m.current_focus_len, 450);
  // 2023-10-07 reworded (changed existing) + 09-24 new (not the supplied date) + 10-30 new (not the supplied date) = 3
  assert.deepEqual(m.dating, { new_entries: 2, invented: 3, changed_existing: 1, extended: 1 });
  assert.equal(m.order_clean, false, '10-07 before 10-06');
  assert.equal(m.retention.ok, false);
  assert.deepEqual(m.retention.sections['In flight'], { live: 3, dropped_live: 1, allowed: 0, dropped_mentioned: [] });
  assert.deepEqual(m.retention.sections['Next actions'], { live: 2, dropped_live: 1, allowed: 0, dropped_mentioned: [] });
  const dropMentioned = pass1Metrics({ raw: raw.replace('- **#329** encoding bug: fix landed [2026-09-25]\n', ''), input: INPUT, labels: LABELS, suppliedDate: SUPPLIED, report: { added: [], aged: 0, aged_future: 0, bounded: [], trims: [] } });
  assert.deepEqual(dropMentioned.retention.sections['In flight'].dropped_mentioned, ['#329']);
});

test('pass1Metrics: retention allows the model to anticipate the server bound (dropped_live <= live - limit)', () => {
  const many = FM + '## In flight\n' + Array.from({ length: 10 }, (_, i) => `- Live item ${i} details`).join('\n') + '\n## Recent decisions\n## Next actions\n';
  const labels = { ...LABELS, cutoff_decision_line: null, stale_issue_refs: {}, pass2: [], units: Array.from({ length: 10 }, (_, i) => ({ section: 'In flight', i: i + 1, label: 'live', key: `live item ${i} details`, text: '' })) };
  const raw = FM + '## Current focus\nf\n## In flight\n' + Array.from({ length: 8 }, (_, i) => `- Live item ${i + 2} details [2026-09-25]`).join('\n') + '\n## Recent decisions\n(none)\n## Next actions\n(none)\n## Open questions\n(none)\n## Environment\n(none)\n';
  const m = pass1Metrics({ raw, input: many, labels, suppliedDate: SUPPLIED, report: { added: [], aged: 0, aged_future: 0, bounded: [], trims: [] } });
  assert.deepEqual(m.retention.sections['In flight'], { live: 10, dropped_live: 2, allowed: 2, dropped_mentioned: [] });
  assert.equal(m.retention.ok, true);
});

test('pass2Conditions: the three conditions and the reported counts', () => {
  const backdated = '2026-09-05';
  // pass-1 raw output after back-dating: #329 (mentioned) and "testing the reboot" (not mentioned) carry the back-dated stamp
  const input2 = FM + [
    '## Current focus', 'f',
    '## In flight',
    `- **#329** encoding bug: fix landed [${backdated}]`,
    `- Testing the reboot durability of the containers [${backdated}]`,
    '- Implement a prune process to remove low-quality captures [2026-09-25]',
    '- Another supplied-date item [2026-09-25]',
    '## Recent decisions', '(none)', '## Next actions', '(none)', '## Open questions', '(none)', '## Environment', '(none)',
  ].join('\n') + '\n';
  const good = {
    raw2: FM + [
      '## Current focus', 'f',
      '## In flight',
      '- **#329** encoding bug: fix landed [2026-09-25]',
      `- Testing the reboot durability of the containers [${backdated}]`,
      '- Implement a prune process to remove low-quality captures [2026-09-25]',
      '- Another supplied-date item [2026-09-25]',
      '## Recent decisions', '(none)', '## Next actions', '(none)', '## Open questions', '(none)', '## Environment', '(none)',
    ].join('\n') + '\n',
  };
  good.written2 = good.raw2.replace(`- Testing the reboot durability of the containers [${backdated}]\n`, '');
  const selected = [{ key: '#329', mentioned: true, backdated: true }, { key: 'testing the reboot durability of', mentioned: false, backdated: true }];
  const c = pass2Conditions({ input2, raw2: good.raw2, written2: good.written2, selected, suppliedDate: SUPPLIED, backdatedDate: backdated, now: '2026-09-25T02:00:00.000Z' });
  assert.equal(c.n, 4);
  assert.deepEqual(c.cond1, { ok: true, failures: [] });
  assert.deepEqual(c.cond2, { ok: true, failures: [], removed_by_bound: [] });
  assert.deepEqual(c.cond3, { ok: true, dropped_supplied: 0, allowed: 0, dropped_mentioned: [] });
  assert.equal(c.backdated_dropped_by_model, 0);
  // failure shapes: the not-mentioned unit re-stamped (cond 1); the mentioned unit kept its old stamp (cond 2); a supplied-date unit dropped (cond 3)
  const bad = FM + [
    '## Current focus', 'f',
    '## In flight',
    `- **#329** encoding bug: fix landed [${backdated}]`,
    '- Testing the reboot durability of the containers [2026-09-25]',
    '- Implement a prune process to remove low-quality captures [2026-09-25]',
    '## Recent decisions', '(none)', '## Next actions', '(none)', '## Open questions', '(none)', '## Environment', '(none)',
  ].join('\n') + '\n';
  const d = pass2Conditions({ input2, raw2: bad, written2: bad, selected, suppliedDate: SUPPLIED, backdatedDate: backdated, now: '2026-09-25T02:00:00.000Z' });
  assert.equal(d.cond1.ok, false);
  assert.deepEqual(d.cond1.failures.map(f => f.key), ['testing the reboot durability of']);
  assert.equal(d.cond2.ok, false);
  assert.deepEqual(d.cond2.failures.map(f => f.key), ['#329']);
  assert.equal(d.cond3.ok, false);
  assert.equal(d.cond3.dropped_supplied, 1);
});

test('aggregate: thresholds vs results, with the OLD-arm control', () => {
  const doc = (over = {}) => ({
    project: 'p', headings: 6, raw_le_cap: true, length: 2000, all_stamped: true, future_stamps: 0, future_decision_dates: 0,
    current_focus_len: 300, dating: { new_entries: 1, invented: 0, changed_existing: 0, extended: 0 }, order_clean: true,
    retention: { ok: true, has_live: true, sections: {} }, stale_carry: [], ...over,
  });
  const newArm = Array.from({ length: 13 }, (_, i) => doc({ project: `p${i}` }));
  const oldArm = Array.from({ length: 13 }, (_, i) => doc({ project: `p${i}`, headings: i < 8 ? 2 : 6, raw_le_cap: i >= 8 }));
  const pass2 = Array.from({ length: 12 }, (_, i) => ({ project: `p${i}`, cond1: { ok: true }, cond2: { ok: true }, cond3: { ok: true } }));
  const a = aggregate({ newArm, oldArm, pass2 });
  assert.equal(a.control.old_arm_misses, 8);
  assert.equal(a.control.ok, true, 'the OLD arm misses on >= 7/13');
  for (const [name, r] of Object.entries(a.thresholds)) assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
  assert.equal(a.all_ok, true);
  assert.deepEqual(Object.keys(a.thresholds).sort(), Object.keys(THRESHOLDS).sort());
  const weak = aggregate({ newArm: newArm.map((d, i) => (i < 3 ? { ...d, dating: { ...d.dating, invented: 1 } } : d)), oldArm: newArm, pass2 });
  assert.equal(weak.control.ok, false, 'an OLD arm that passes everything proves nothing');
  assert.equal(weak.thresholds.invented_dates_zero.ok, false);
  assert.equal(weak.all_ok, false);
});
