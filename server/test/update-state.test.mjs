// server/test/update-state.test.mjs — fixture-driven port-fidelity tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateState } from '../lib/update-state.mjs';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/update-state/', import.meta.url));
const fixtureFiles = (await fs.readdir(FIXTURES_DIR)).filter(f => f.endsWith('.json'));

for (const file of fixtureFiles) {
  const name = path.basename(file, '.json');
  test(`update-state fixture: ${name}`, async () => {
    const fixture = JSON.parse(
      await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8'),
    );
    const result = await updateState(
      { oldStateMd: fixture.old_state_md, newSummary: fixture.new_summary_md, projectId: 'fixture' },
      { summarizeFn: fixture.summarize_stub ? stubFromFixture(fixture.summarize_stub) : undefined },
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
