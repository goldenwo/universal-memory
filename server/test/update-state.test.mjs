// server/test/update-state.test.mjs — fixture-driven port-fidelity tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateState } from '../lib/update-state.mjs';
import { REQUIRED_SECTIONS, SECTION_LIMITS } from '../lib/state-cap.mjs';
import { _setLogStreamForTest } from '../lib/logger.mjs';
import { Writable } from 'node:stream';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/update-state/', import.meta.url));
const FIXED_NOW = '2026-08-18T00:00:00.000Z';
const fixtureFiles = (await fs.readdir(FIXTURES_DIR)).filter(f => f.endsWith('.json'));

for (const file of fixtureFiles) {
  const name = path.basename(file, '.json');
  test(`update-state fixture: ${name}`, async () => {
    const fixture = JSON.parse(
      await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8'),
    );
    const result = await updateState(
      { oldStateMd: fixture.old_state_md, newSummary: fixture.new_summary_md, projectId: 'fixture' },
      {
        summarizeFn: fixture.summarize_stub ? stubFromFixture(fixture.summarize_stub) : undefined,
        // Frozen clock: valid_from is now stamped by the SERVER, so the fixtures pin
        // the stamped value rather than whatever date the model emitted.
        now: () => new Date(FIXED_NOW),
      },
    );
    assert.equal(result.mergedMd, fixture.expected_merged_md);
    if (fixture.expected_schema_version !== undefined) {
      assert.equal(result.schema_version, fixture.expected_schema_version);
    }
    if (fixture.expected_llm_failure !== undefined) {
      assert.equal(result.llmFailure, fixture.expected_llm_failure);
    }
  });
}

// Round-9 blocker fix: default prompt path must resolve relative to lib dir (Docker-safe).
// Omit ctx.promptDir so updateState reads the real update-state.txt from disk.
// Catches the 'new URL("../../", import.meta.url)' = "/" regression in Docker.
test('updateState: default prompt path resolves correctly (no ctx.promptDir — Docker-safe path fix)', async () => {
  const result = await updateState(
    { oldStateMd: '', newSummary: 'Test summary for default path.', projectId: 'docker-path-test' },
    {
      summarizeFn: async () => ({
        summary: 'merged',
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      // no promptDir override — must find server/config/prompts/update-state.txt via LIB_DIR
    },
  );
  // If DEFAULT_PROMPT_PATH resolved wrongly, result would be {ok:false, error:'update-state prompt file missing'}
  assert.ok(result.mergedMd !== undefined,
    `Expected mergedMd in result; got: ${JSON.stringify(result)}`);
  assert.ok(!result.ok === false || result.mergedMd,
    `Expected ok or mergedMd from real prompt load; got: ${JSON.stringify(result)}`);
});

// Fix 6 (round-4): ENOENT path — missing promptDir returns ok:false with sanitized message
test('updateState returns ok:false with sanitized message when promptDir is missing (F8 parity)', async () => {
  const result = await updateState(
    { oldStateMd: '', newSummary: 'some summary', projectId: 'test' },
    { promptDir: '/nonexistent/path/that/does/not/exist' },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /update-state prompt.*missing/i);
  // Sanitized: must NOT expose the server filesystem path in the client error
  assert.ok(!result.error.includes('/nonexistent'), 'client error must not leak server path');
});

// §4.8 hardening (checkpoint-chunk-txn.mjs task-5): additive explicit ok:true
// on the success return, so a caller can branch on `stateResult.ok === false`
// without a false positive on every successful merge (previously only the
// prompt-missing failure path ever set `ok` at all).
test('updateState: success return carries explicit ok:true', async () => {
  const result = await updateState(
    { oldStateMd: 'old', newSummary: 'new summary', projectId: 'ok-true-test' },
    {
      summarizeFn: async () => ({ summary: 'merged content', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
    },
  );
  assert.equal(result.ok, true);
  // #326 D8: the server scaffolds the six required sections after the model output.
  assert.equal(result.mergedMd, `merged content\n${SIX_NONE}`);
});

const SIX_NONE = REQUIRED_SECTIONS.map(n => `## ${n}\n(none)\n`).join('');

function stubFromFixture(stub) {
  if (stub.mode === 'throw') {
    return async () => { throw new Error(stub.error ?? 'stub error'); };
  }
  return async () => ({
    summary: stub.summary,
    costUsd: stub.costUsd ?? 0,
    tokensIn: stub.tokensIn ?? 0,
    tokensOut: stub.tokensOut ?? 0,
  });
}

// ── Server owns the timestamp, not the model ────────────────────────────────
// The merge prompt asks the model to emit "the updated state.md (frontmatter +
// body)", so without a server-side stamp `valid_from` is whatever date the model
// invents. Observed live: 25 of 27 state docs carried 2023 dates (training-era
// default) while their real mtimes were 2026-07/08 — and one re-merge produced a
// date three months in the FUTURE, which out-ranks everything in any recency
// comparison. See goldenwo/universal-memory#264.

const stubReturning = (summary) => async () => ({ summary, costUsd: 0, tokensIn: 0, tokensOut: 0 });
const CLOCK = '2026-08-18T00:00:00.000Z';
const withClock = (summary) => ({ summarizeFn: stubReturning(summary), now: () => new Date(CLOCK) });

test('updateState VS1: a model-invented past date is overwritten by the server clock', async () => {
  const modelOut = '---\ntype: state\nid: state-x\nvalid_from: 2023-10-30T00:00:00Z\n---\n\n# body\n';
  const r = await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withClock(modelOut));
  assert.match(r.mergedMd, new RegExp(`^valid_from: ${CLOCK}$`, 'm'));
  assert.ok(!r.mergedMd.includes('2023-10-30'), 'the invented date must not survive');
});

test('updateState VS2: a FUTURE date is overwritten too', async () => {
  // The live regression: the model kept its invented month-day and moved the year
  // to the current one, landing three months ahead of the real write time.
  const modelOut = '---\ntype: state\nid: state-x\nvalid_from: 2026-11-16T00:00:00Z\n---\n\n# body\n';
  const r = await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withClock(modelOut));
  assert.match(r.mergedMd, new RegExp(`^valid_from: ${CLOCK}$`, 'm'));
  assert.ok(!r.mergedMd.includes('2026-11-16'), 'a future date must not survive');
});

test('updateState VS3: absent valid_from is inserted, not left missing', async () => {
  const modelOut = '---\ntype: state\nid: state-x\n---\n\n# body\n';
  const r = await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withClock(modelOut));
  assert.match(r.mergedMd, new RegExp(`^valid_from: ${CLOCK}$`, 'm'));
  assert.match(r.mergedMd, /^type: state$/m, 'existing frontmatter keys survive');
});

test('updateState VS4: body is untouched — the model still owns it', async () => {
  const modelOut = '---\nvalid_from: 2023-01-01T00:00:00Z\n---\n\n# body\n\nvalid_from: 2023-01-01T00:00:00Z in prose\n';
  const r = await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withClock(modelOut));
  assert.ok(r.mergedMd.includes('valid_from: 2023-01-01T00:00:00Z in prose'),
    'only the frontmatter block is stamped; body text is not rewritten');
});

test('updateState VS5: output with no frontmatter is passed through unchanged', async () => {
  const modelOut = '# just a body, no frontmatter\n';
  const r = await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withClock(modelOut));
  assert.equal(r.mergedMd, modelOut + SIX_NONE, 'must not fabricate a frontmatter block; the six sections are scaffolded (#326 D8), the H1 stays first');
});

test('updateState VS6: the llm-failure fallback is stamped too', async () => {
  // That path inherits frontmatter from the OLD state doc, which would otherwise
  // carry a stale valid_from forward indefinitely.
  const oldStateMd = '---\ntype: state\nid: state-x\nvalid_from: 2023-10-30T00:00:00Z\n---\n\n# old body\n';
  const r = await updateState(
    { oldStateMd, newSummary: 'new summary', projectId: 'x' },
    { summarizeFn: async () => { throw new Error('llm down'); }, now: () => new Date(CLOCK) },
  );
  assert.equal(r.llmFailure, true);
  assert.match(r.mergedMd, new RegExp(`^valid_from: ${CLOCK}$`, 'm'));
  assert.ok(r.mergedMd.includes('llm-merge-failed'), 'fallback marker still present');
});

// ── #326: the merge date, stamp-then-shape, and the shaping logs ─────────────
// The port dropped the bash script's `Current timestamp` line, so the model stamped
// training-era dates on every decision (spec §1, second defect). The date now comes
// from effectiveAsOf(args.asOf, ctx.now()) and shaping runs after the stamp.
function captureLogs() {
  const captured = [];
  _setLogStreamForTest(new Writable({
    write(chunk, enc, cb) {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        try { captured.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
      cb();
    },
  }));
  return captured;
}
const withPromptCapture = (summary, holder, extra = {}) => ({
  summarizeFn: async (userPrompt) => { holder.prompt = userPrompt; return { summary, costUsd: 0, tokensIn: 0, tokensOut: 0 }; },
  now: () => new Date(CLOCK),
  ...extra,
});
const SIX = (over = {}) => {
  const s = {
    'Current focus': 'Focus.', 'In flight': '- item [2026-08-18]', 'Recent decisions': '- 2026-08-18: d',
    'Next actions': '- n', 'Open questions': '(none)', 'Environment': '(none)', ...over,
  };
  return REQUIRED_SECTIONS.map(n => `## ${n}\n${s[n]}\n`).join('');
};
const FM_X = '---\ntype: state\nid: state-x\nvalid_from: 2023-10-30T00:00:00Z\n---\n';

test('updateState #326: the user prompt carries the merge date from the frozen clock, after the Project line', async () => {
  const h = {};
  await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withPromptCapture('# body\n', h));
  assert.ok(h.prompt.includes('Project: x\nDate for this merge (UTC): 2026-08-18\n'), h.prompt.slice(0, 120));
});

test('updateState #326: asOf inside the window is the merge date as given', async () => {
  const h = {};
  await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x', asOf: '2026-08-10T12:00:00Z' }, withPromptCapture('# body\n', h));
  assert.ok(h.prompt.includes('Date for this merge (UTC): 2026-08-10\n'));
});

test('updateState #326: a year-ahead asOf clamps to the clock date', async () => {
  const h = {};
  await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x', asOf: '2027-08-18T00:00:00Z' }, withPromptCapture('# body\n', h));
  assert.ok(h.prompt.includes('Date for this merge (UTC): 2026-08-18\n'));
});

test('updateState #326: a 1970 asOf clamps to now minus 14 days', async () => {
  const h = {};
  await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x', asOf: '1970-01-01T00:00:00Z' }, withPromptCapture('# body\n', h));
  assert.ok(h.prompt.includes('Date for this merge (UTC): 2026-08-04\n'));
});

test('updateState #326: a year-ahead asOf ages nothing stamped with the frozen date', async () => {
  const doc = FM_X + '# t\n' + SIX({ 'In flight': '- keep me [2026-08-18]\n- and me [2026-08-05]' });
  const h = {};
  const r = await updateState({ oldStateMd: doc, newSummary: 's', projectId: 'x', asOf: '2027-08-18T00:00:00Z' }, withPromptCapture(doc, h));
  assert.ok(r.mergedMd.includes('- keep me [2026-08-18]'));
  assert.ok(r.mergedMd.includes('- and me [2026-08-05]'), 'exactly 13 days old under the clamped date: kept');
});

test('updateState #326: stamp-then-shape — an over-cap model output with no valid_from is written <= 3000 with the stamp', async () => {
  const modelOut = '---\ntype: state\nid: state-x\n---\n# t\n' + SIX({ 'Current focus': 'word '.repeat(700).trim() });
  assert.ok(modelOut.length > 3000);
  const r = await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withClock(modelOut));
  assert.ok(r.mergedMd.length <= 3000, `written doc is ${r.mergedMd.length}`);
  assert.match(r.mergedMd, new RegExp(`^valid_from: ${CLOCK}$`, 'm'));
  for (const n of REQUIRED_SECTIONS) assert.ok(r.mergedMd.includes(`## ${n}\n`), n);
});

test('updateState #326: state.cap_trimmed is emitted with the section list on an over-cap merge and not under the cap', async () => {
  const captured = captureLogs();
  try {
    const over = '---\ntype: state\nid: state-x\n---\n# t\n' + SIX({ 'Current focus': 'word '.repeat(700).trim() });
    await updateState({ oldStateMd: '', newSummary: 's', projectId: 'proj-over' }, withClock(over));
    const line = captured.find(l => l.msg === 'state.cap_trimmed');
    assert.ok(line, 'state.cap_trimmed emitted');
    assert.equal(line.project, 'proj-over');
    assert.equal(line.component, 'update-state');
    assert.ok(line.chars_before > 3000 && line.chars_after <= 3000);
    assert.ok(Array.isArray(line.sections) && line.sections.some(s => s.heading === 'Current focus' && s.chars_cut > 0));
    captured.length = 0;
    await updateState({ oldStateMd: '', newSummary: 's', projectId: 'proj-under' }, withClock(FM_X + '# t\n' + SIX()));
    assert.ok(!captured.some(l => l.msg === 'state.cap_trimmed'), 'not emitted under the cap');
  } finally {
    _setLogStreamForTest(null);
  }
});

test('updateState #326: state.shaped is emitted with added when the model omits a section, with aged for an old stamp, and not on a compliant doc', async () => {
  const captured = captureLogs();
  try {
    const missingEnv = FM_X + '# t\n' + REQUIRED_SECTIONS.slice(0, 5).map(n => `## ${n}\n(none)\n`).join('');
    await updateState({ oldStateMd: '', newSummary: 's', projectId: 'proj-added' }, withClock(missingEnv));
    let line = captured.find(l => l.msg === 'state.shaped');
    assert.ok(line, 'state.shaped emitted for a missing section');
    assert.deepEqual(line.added, ['Environment']);
    assert.equal(line.project, 'proj-added');
    captured.length = 0;
    const oldStamp = FM_X + '# t\n' + SIX({ 'In flight': '- stale [2026-07-01]\n- live [2026-08-18]' });
    await updateState({ oldStateMd: '', newSummary: 's', projectId: 'proj-aged' }, withClock(oldStamp));
    line = captured.find(l => l.msg === 'state.shaped');
    assert.ok(line, 'state.shaped emitted for an aged stamp');
    assert.equal(line.aged, 1);
    assert.equal(line.aged_future, 0);
    captured.length = 0;
    await updateState({ oldStateMd: '', newSummary: 's', projectId: 'proj-clean' }, withClock(FM_X + '# t\n' + SIX()));
    assert.ok(!captured.some(l => l.msg === 'state.shaped' || l.msg === 'state.cap_trimmed'), 'nothing emitted on a compliant doc');
  } finally {
    _setLogStreamForTest(null);
  }
});

test('updateState #342: a bound-only merge emits state.shaped with bounded — 12 fresh In-flight items log [{In flight, 12 - limit}]', async () => {
  const captured = captureLogs();
  try {
    // Stamped with the clock's date: nothing to add, age or trim, so `bounded` alone opens the gate.
    const twelve = Array.from({ length: 12 }, (_, i) => `- item ${i + 1} [2026-08-18]`).join('\n');
    await updateState({ oldStateMd: '', newSummary: 's', projectId: 'proj-bounded' }, withClock(FM_X + '# t\n' + SIX({ 'In flight': twelve })));
    const line = captured.find(l => l.msg === 'state.shaped');
    assert.ok(line, 'state.shaped emitted for a bound-only merge');
    assert.equal(line.project, 'proj-bounded');
    assert.deepEqual(line.bounded, [{ heading: 'In flight', dropped: 12 - SECTION_LIMITS['In flight'] }]);
    assert.deepEqual(line.added, []);
    assert.equal(line.aged, 0);
    assert.equal(line.aged_future, 0);
    assert.ok(!captured.some(l => l.msg === 'state.cap_trimmed'), 'under the cap: no trim line');
  } finally {
    _setLogStreamForTest(null);
  }
});

test('updateState #326: the llm-failure fallback inserts the unmerged heading and the scaffold sits ahead of it', async () => {
  const oldStateMd = FM_X + '# old\n## Current focus\nWorking.\n';
  const r = await updateState(
    { oldStateMd, newSummary: 'raw summary text', projectId: 'x' },
    { summarizeFn: async () => { throw new Error('llm down'); }, now: () => new Date(CLOCK) },
  );
  assert.equal(r.llmFailure, true);
  const expectedTail = `\n\n<!-- llm-merge-failed, appended raw -->\n\n## Unmerged session summary\n\nraw summary text`;
  assert.ok(r.mergedMd.endsWith(expectedTail), r.mergedMd.slice(-200));
  const five = REQUIRED_SECTIONS.slice(1).map(n => `## ${n}\n(none)\n`).join('');
  assert.ok(r.mergedMd.includes(`## Current focus\nWorking.\n${five}\n\n<!-- llm-merge-failed`), 'five missing sections scaffolded ahead of the marker run and the unmerged heading');
  const empty = await updateState(
    { oldStateMd: '', newSummary: 'raw summary text', projectId: 'x' },
    { summarizeFn: async () => { throw new Error('llm down'); }, now: () => new Date(CLOCK) },
  );
  assert.ok(empty.mergedMd.startsWith(SIX_NONE + '<!-- llm-merge-failed, appended raw -->\n\n## Unmerged session summary\n\nraw summary text'), empty.mergedMd.slice(0, 300));
});

test('updateState #326: the shaping report rides along on the result (additive field)', async () => {
  const over = '---\ntype: state\nid: state-x\n---\n# t\n' + SIX({ 'Current focus': 'word '.repeat(700).trim() });
  const r = await updateState({ oldStateMd: '', newSummary: 's', projectId: 'x' }, withClock(over));
  assert.ok(r.shaping.trims.some(t => t.heading === 'Current focus' && t.chars_cut > 0));
  assert.deepEqual(Object.keys(r.shaping).sort(), ['added', 'aged', 'aged_future', 'bounded', 'trims']);
});
