// server/test/update-state.test.mjs — fixture-driven port-fidelity tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateState } from '../lib/update-state.mjs';

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
  assert.equal(result.mergedMd, 'merged content');
});

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
  assert.equal(r.mergedMd, modelOut, 'must not fabricate a frontmatter block');
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
