// server/test/checkpoint.test.mjs — unit tests for doCheckpoint orchestration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { doCheckpoint } from '../lib/checkpoint.mjs';
import { handleToolCall } from '../mem0-mcp-http.mjs';

// ---- helpers ----------------------------------------------------------------

async function makeVault() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'um-ck-test-'));
  return dir;
}

async function seedCapture(vaultDir, project, filename, content) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, filename), content);
}

function makeSummarizeFn(overrides = {}) {
  return async () => ({
    summary: overrides.summary ?? 'Mock session summary.',
    costUsd: overrides.costUsd ?? 0.001,
    tokensIn: overrides.tokensIn ?? 100,
    tokensOut: overrides.tokensOut ?? 50,
  });
}

function makeUpdateStateFn(overrides = {}) {
  return async ({ oldStateMd, newSummary }) => ({
    schema_version: 1,
    mergedMd: overrides.mergedMd ?? `${oldStateMd}\n\n${newSummary}`,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    llmFailure: false,
  });
}

const BASE_CONFIG = {
  schema_version: 1,
  cost_cap_usd_per_day_per_project: 0.50,
  summary_model: 'gpt-4o-mini',
  state_cap_chars: 3000,
  lockdir_stale_timeout_ms: 600000,
};

// ---- tests ------------------------------------------------------------------

// 1. Happy path: result shape contains all required fields
test('checkpoint: happy path returns complete result shape', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nSome work done.');

  const reindexCalls = [];
  const result = await doCheckpoint(
    { project: 'myproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async (args) => { reindexCalls.push(args); },
    },
  );

  assert.equal(result.schema_version, 1);
  assert.equal(result.ok, true);
  assert.ok(typeof result.summary_id === 'string' && result.summary_id.length > 0, 'summary_id should be a string');
  assert.ok(typeof result.summary_path === 'string' && result.summary_path.startsWith('sessions/'), 'summary_path should start with sessions/');
  assert.equal(result.state_updated, true);
  assert.ok(typeof result.cost_usd === 'number', 'cost_usd must be a number');
  assert.ok(typeof result.tokens_in === 'number', 'tokens_in must be a number');
  assert.ok(typeof result.tokens_out === 'number', 'tokens_out must be a number');
  assert.ok(typeof result.duration_ms === 'number' && result.duration_ms >= 0, 'duration_ms must be non-negative number');
  assert.equal(reindexCalls.length, 1, 'reindex should be called once');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 2. Stale lockdir recovery: pre-create a stale lockdir; should detect and recover
test('checkpoint: stale lockdir is detected and removed', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nContent.');

  // Create stale lockdir with old mtime
  const staleTimeout = 100; // ms — very small for test
  const lockdir = path.join(vaultDir, 'state', 'myproj', 'state.md.lockdir');
  await fs.mkdir(lockdir, { recursive: true });
  // Backdate mtime by setting it via utimes
  const staleTime = new Date(Date.now() - 200); // 200ms ago > 100ms timeout
  await fs.utimes(lockdir, staleTime, staleTime);

  const result = await doCheckpoint(
    { project: 'myproj' },
    {
      config: { ...BASE_CONFIG, lockdir_stale_timeout_ms: staleTimeout },
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, 'should succeed after stale lockdir recovery');
  assert.equal(result.state_updated, true);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 3. Concurrent checkpoint race: two concurrent calls for the same project — one completes, other fails cleanly
test('checkpoint: concurrent calls — second sees lockdir, returns checkpoint_in_progress', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nContent.');

  let resolveFirst;
  const firstStarted = new Promise((res) => { resolveFirst = res; });
  let secondDone = false;

  // Slow summarize: signals when it starts, waits for manual release
  let allowFirst;
  const firstGate = new Promise((res) => { allowFirst = res; });
  const slowSummarizeFn = async () => {
    resolveFirst(); // signal first is inside critical section
    await firstGate; // wait to be released
    return { summary: 'done', costUsd: 0.001, tokensIn: 10, tokensOut: 5 };
  };

  const ctx = {
    config: BASE_CONFIG,
    vaultDir,
    summarizeFn: slowSummarizeFn,
    updateStateFn: makeUpdateStateFn(),
    reindexFn: async () => {},
  };

  const firstPromise = doCheckpoint({ project: 'myproj' }, ctx);

  // Wait until first has acquired the lock
  await firstStarted;

  // Fire second while first holds the lock
  const secondResult = await doCheckpoint(
    { project: 'myproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );
  secondDone = true;

  // Release first
  allowFirst();
  const firstResult = await firstPromise;

  assert.equal(secondResult.ok, false, 'second should fail');
  assert.equal(secondResult.error, 'checkpoint_in_progress');
  assert.equal(firstResult.ok, true, 'first should succeed');
  assert.ok(secondDone);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 4. Cost cap hit: cost cap = 0; doCheckpoint skips with {ok:false, error:'cost cap hit'}
test('checkpoint: cost cap hit returns {ok:false, error:"cost cap hit"}', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nContent.');

  // Pre-populate telemetry file to be >= cap
  const today = new Date().toISOString().slice(0, 10);
  const telemetryDir = path.join(vaultDir, '.telemetry');
  await fs.mkdir(telemetryDir, { recursive: true });
  await fs.writeFile(path.join(telemetryDir, `${today}-myproj.count`), '0.50');

  const result = await doCheckpoint(
    { project: 'myproj' },
    {
      config: { ...BASE_CONFIG, cost_cap_usd_per_day_per_project: 0.50 },
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'cost cap hit');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 5. State-merge preserves human edits
test('checkpoint: state-merge preserves human-added sections in old state.md', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nSome work.');

  const humanSection = '## Human Notes\nThis was added manually by the dev.';
  const stateDir = path.join(vaultDir, 'state', 'myproj');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, 'state.md'), humanSection);

  let capturedOldState = '';
  const spyUpdateStateFn = async ({ oldStateMd, newSummary }) => {
    capturedOldState = oldStateMd;
    return {
      schema_version: 1,
      mergedMd: `${oldStateMd}\n\nAuto-merged: ${newSummary}`,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      llmFailure: false,
    };
  };

  const result = await doCheckpoint(
    { project: 'myproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: spyUpdateStateFn,
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.ok(capturedOldState.includes('Human Notes'), 'old state.md was passed to updateState with human section');
  const writtenState = await fs.readFile(path.join(stateDir, 'state.md'), 'utf8');
  assert.ok(writtenState.includes('Human Notes'), 'written state.md preserves human section');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 6. claude-agent-sdk fallback emits expected warning log
test('checkpoint: UM_SUMMARIZER=claude-agent-sdk emits warning log', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nContent.');

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  try {
    // Real summarize fn (not stubbed) with sdk-backend but we short-circuit via openaiClient stub
    const { summarize } = await import('../lib/summarize.mjs');
    const openaiClient = {
      chat: { completions: { create: async () => ({
        choices: [{ message: { content: 'fallback summary' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }) } },
    };
    const wrappedSummarizeFn = (transcript, ctx2 = {}) =>
      summarize(transcript, { ...ctx2, backend: 'claude-agent-sdk', openaiClient });

    await doCheckpoint(
      { project: 'myproj' },
      {
        config: BASE_CONFIG,
        vaultDir,
        summarizeFn: wrappedSummarizeFn,
        updateStateFn: makeUpdateStateFn(),
        reindexFn: async () => {},
      },
    );
  } finally {
    console.warn = origWarn;
  }

  assert.ok(
    warnings.some(w => /claude-agent-sdk|fallback/i.test(w)),
    `expected warning about claude-agent-sdk, got: ${warnings.join(' | ')}`,
  );

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 7. skip_state_merge: true — produces summary, does NOT touch state.md
test('checkpoint: skip_state_merge=true produces summary but skips state.md', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nContent.');

  let updateStateCalled = false;
  const result = await doCheckpoint(
    { project: 'myproj', skip_state_merge: true },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: async (...args) => { updateStateCalled = true; return makeUpdateStateFn()(...args); },
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.state_updated, false, 'state_updated should be false when skip_state_merge');
  assert.equal(result.state_path, null, 'state_path should be null when skip_state_merge');
  assert.ok(result.summary_path, 'summary should still be written');
  assert.equal(updateStateCalled, false, 'updateStateFn should not be called');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 8. since/until arg: pass explicit window; for v0.5 all captures read (confirmed simplification)
test('checkpoint: since/until args accepted, checkpoint completes successfully', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session A\nContent A.');
  await seedCapture(vaultDir, 'myproj', '2026-01-02T00.md', '# Session B\nContent B.');

  const result = await doCheckpoint(
    {
      project: 'myproj',
      since: '2026-01-02T00:00:00Z',
      until: '2026-01-02T23:59:59Z',
    },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.ok(result.summary_id, 'summary_id should exist');
  assert.ok(result.summary_path, 'summary_path should exist');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 9. Invalid project slug returns error without touching filesystem
test('checkpoint: invalid project slug returns {ok:false, error} without filesystem ops', async () => {
  const vaultDir = await makeVault();

  const result = await doCheckpoint(
    { project: '../evil/path' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, false);
  assert.ok(result.error.includes('invalid project'), `error should say invalid project, got: ${result.error}`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// 10. MCP dispatcher wiring: handleToolCall('memory_checkpoint', ...) reaches doCheckpoint, not the stub
//
// Strategy: doCheckpoint is the real implementation (no DI hook via handleToolCall), so calling it
// without a real OPENAI_API_KEY will throw. We catch that throw and confirm it came from inside
// doCheckpoint (stack mentions 'checkpoint' or 'summarize'), NOT from the v0.4 stub return path.
// A successfully wired run (with valid API key) would also pass — this test handles both scenarios.
test('checkpoint: handleToolCall memory_checkpoint is wired to doCheckpoint (not stub)', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'dispatchproj', '2026-01-01T00.md', '# Session\nDispatcher wiring test.');

  const origWriteEnabled = process.env.UM_MCP_WRITE_ENABLED;
  const origVaultDir = process.env.UM_VAULT_DIR;
  process.env.UM_MCP_WRITE_ENABLED = 'true';
  process.env.UM_VAULT_DIR = vaultDir;

  try {
    let raw;
    let caughtError = null;
    try {
      raw = await handleToolCall('memory_checkpoint', { project: 'dispatchproj' });
    } catch (err) {
      caughtError = err;
    }

    if (caughtError) {
      // Threw an error — must NOT be from the stub (stub returns, doesn't throw).
      // If it's an OpenAI key error or a doCheckpoint error, that proves the stub is gone.
      const msg = String(caughtError.message ?? caughtError);
      assert.ok(
        !msg.includes('not yet implemented'),
        `got v0.4 stub message in thrown error: ${msg}`,
      );
      // Confirm it's a real execution error (LLM key missing or similar), not stub
      assert.ok(
        msg.toLowerCase().includes('api') || msg.toLowerCase().includes('key') ||
        msg.toLowerCase().includes('openai') || msg.toLowerCase().includes('vault') ||
        msg.toLowerCase().includes('summarize') || msg.toLowerCase().includes('model'),
        `unexpected error (not from doCheckpoint path): ${msg}`,
      );
    } else {
      // Returned a value — parse and verify it's NOT the v0.4 stub
      const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
      assert.ok(
        !String(result.error ?? '').includes('not yet implemented'),
        `got v0.4 stub error: ${result.error}`,
      );
      // Full success shape if API key was available
      if (result.ok) {
        assert.ok(typeof result.summary_id === 'string' && result.summary_id.length > 0, 'summary_id should be a non-empty string');
        assert.equal(result.state_updated, true, 'state_updated should be true');
      }
    }
  } finally {
    if (origWriteEnabled === undefined) delete process.env.UM_MCP_WRITE_ENABLED;
    else process.env.UM_MCP_WRITE_ENABLED = origWriteEnabled;
    if (origVaultDir === undefined) delete process.env.UM_VAULT_DIR;
    else process.env.UM_VAULT_DIR = origVaultDir;
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});
