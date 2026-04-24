// server/test/checkpoint.test.mjs — unit tests for doCheckpoint orchestration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { doCheckpoint } from '../lib/checkpoint.mjs';
import { handleToolCall, handleCheckpointRequest } from '../mem0-mcp-http.mjs';

// ---------- mock helpers (patterned after append-turn.test.mjs) ----------

function mockRes() {
  const res = {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.jsonBody = obj; return this; },
  };
  return res;
}

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

  // Verify on-disk content of summary file
  const diskSummary = await fs.readFile(path.join(vaultDir, result.summary_path), 'utf8');
  assert.ok(diskSummary.length > 0, 'summary file must not be empty on disk');
  assert.ok(diskSummary.includes('Mock session summary.'),
    `summary content mismatch: ${diskSummary.slice(0, 200)}`);

  // Verify on-disk content of state.md
  if (result.state_updated) {
    const stateMd = await fs.readFile(path.join(vaultDir, result.state_path), 'utf8');
    assert.ok(stateMd.length > 0, 'state.md must not be empty on disk');
  }

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

// 8. since/until filter: 3 files (day1, day2, day3); since=day2 reads only day2+day3
test('checkpoint: since/until filter reads only files within window', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01.md', '# Session A\nContent A only.');
  await seedCapture(vaultDir, 'myproj', '2026-01-02.md', '# Session B\nContent B only.');
  await seedCapture(vaultDir, 'myproj', '2026-01-03.md', '# Session C\nContent C only.');

  let capturedTranscript = '';
  const spySummarizeFn = async (transcript, ctx) => {
    capturedTranscript = transcript;
    return { summary: 'Summary.', costUsd: 0.001, tokensIn: 50, tokensOut: 20 };
  };

  const result = await doCheckpoint(
    {
      project: 'myproj',
      since: '2026-01-02T00:00:00Z',
      until: '2026-01-03T23:59:59Z',
    },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: spySummarizeFn,
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.ok(!capturedTranscript.includes('Content A only'), 'day1 should be filtered out by since');
  assert.ok(capturedTranscript.includes('Content B only'), 'day2 should be included');
  assert.ok(capturedTranscript.includes('Content C only'), 'day3 should be included');

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

// 11. systemPrompt is passed to summarizeFn (Fix 1 — post-review integration bug)
test('checkpoint: systemPrompt is passed to summarizeFn', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01T00.md', '# Session\nSome work done.');

  let capturedCtx = null;
  const spySummarizeFn = async (transcript, ctx) => {
    capturedCtx = ctx;
    return { summary: 'Captured summary.', costUsd: 0.001, tokensIn: 50, tokensOut: 25 };
  };

  await doCheckpoint(
    { project: 'myproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: spySummarizeFn,
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.ok(capturedCtx !== null, 'summarizeFn should have been called');
  assert.ok(
    typeof capturedCtx.systemPrompt === 'string' && capturedCtx.systemPrompt.length > 0,
    `systemPrompt should be a non-empty string, got: ${JSON.stringify(capturedCtx?.systemPrompt)}`,
  );

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// ---------- REST handler unit tests (Task 2.6) ----------

test('POST /api/checkpoint 200 happy path (writesEnabled:true) → ok:true, schema_version:1', async () => {
  const vaultDir = await makeVault();
  // Seed a capture file so doCheckpoint has something to summarize
  await seedCapture(vaultDir, 'rest-ck-proj', '2026-01-01T00.md', '# Session\nREST checkpoint test.');

  const req = { body: { project: 'rest-ck-proj' } };
  const res = mockRes();
  await handleCheckpointRequest(req, res, {
    vaultDir,
    writesEnabled: true,
    _doCheckpoint: async (args, ctx) => ({
      schema_version: 1,
      ok: true,
      summary_id: 'test-summary-id',
      summary_path: 'sessions/rest-ck-proj/2026-01-01.md',
      state_updated: true,
      state_path: 'state/rest-ck-proj/state.md',
      cost_usd: 0.001,
      tokens_in: 100,
      tokens_out: 50,
      duration_ms: 123,
    }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.jsonBody.ok, true);
  assert.equal(res.jsonBody.schema_version, 1);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

test('POST /api/checkpoint 403 when writes disabled → ok:false, statusCode 403', async () => {
  const req = { body: { project: 'some-proj' } };
  const res = mockRes();
  await handleCheckpointRequest(req, res, { writesEnabled: false });

  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.ok, false);
});

// B.10 (spec §5.4): UPSTREAM_FAILURE from doCheckpoint maps to HTTP 502.
test('POST /api/checkpoint UPSTREAM_FAILURE result → HTTP 502 with code propagated', async () => {
  const req = { body: { project: 'upstream-fail-proj' } };
  const res = mockRes();
  await handleCheckpointRequest(req, res, {
    writesEnabled: true,
    _doCheckpoint: async () => ({
      schema_version: 1,
      ok: false,
      error: { code: 'UPSTREAM_FAILURE', message: 'reindex exhausted retries' },
      summary_id: 'session-x',
      summary_path: 'sessions/upstream-fail-proj/session-x.md',
    }),
  });

  assert.equal(res.statusCode, 502, 'UPSTREAM_FAILURE should map to HTTP 502');
  assert.equal(res.jsonBody.ok, false);
  assert.equal(res.jsonBody.error.code, 'UPSTREAM_FAILURE');
});

// B.10: STATE_LOCK_CONTENTION result → HTTP 503 (retryable by client).
test('POST /api/checkpoint STATE_LOCK_CONTENTION result → HTTP 503', async () => {
  const req = { body: { project: 'lock-cont-proj' } };
  const res = mockRes();
  await handleCheckpointRequest(req, res, {
    writesEnabled: true,
    _doCheckpoint: async () => ({
      schema_version: 1,
      ok: false,
      error: { code: 'STATE_LOCK_CONTENTION', message: 'state.md contention' },
    }),
  });

  assert.equal(res.statusCode, 503, 'STATE_LOCK_CONTENTION should map to HTTP 503');
  assert.equal(res.jsonBody.error.code, 'STATE_LOCK_CONTENTION');
});

// Fix 2 (round-9): reindexFn must receive a STRING path, not {path, project} object.
// reindexDoc(relPath) in mem0-mcp-http.mjs takes a string; passing an object silently coerced
// to "[object Object]" and caused every checkpoint reindex to fail silently.
test('checkpoint: reindexFn receives a string path (not object) — round-9 blocker fix', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'reindex-proj', '2026-01-01T00.md', '# Session\nReindex wiring test.');

  const reindexArgs = [];
  const result = await doCheckpoint(
    { project: 'reindex-proj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async (arg) => { reindexArgs.push(arg); },
    },
  );

  assert.equal(result.ok, true, 'checkpoint should succeed');
  assert.equal(reindexArgs.length, 1, 'reindexFn must be called exactly once');
  const arg = reindexArgs[0];
  assert.equal(typeof arg, 'string',
    `reindexFn must receive a string, got: ${typeof arg} — ${JSON.stringify(arg)}`);
  assert.ok(arg.startsWith('sessions/'),
    `reindexFn path should start with sessions/, got: ${arg}`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Fix 1: handleCheckpointRequest wires reindexFn to doCheckpoint (not the no-op default)
// Fix 2 (round-9): reindexFn receives a string path (not object); assert typeof === 'string'
test('handleCheckpointRequest: _reindexFn spy is forwarded to doCheckpoint (string arg)', async () => {
  const reindexCalls = [];
  const req = { body: { project: 'rest-reindex-proj' } };
  const res = mockRes();
  await handleCheckpointRequest(req, res, {
    writesEnabled: true,
    _doCheckpoint: async (args, ctx) => {
      // Invoke the injected reindexFn with a string path (matching real doCheckpoint behaviour)
      await ctx.reindexFn(`sessions/${args.project}/test.md`);
      return {
        schema_version: 1, ok: true, summary_id: 'spy-id',
        summary_path: `sessions/${args.project}/test.md`,
        state_updated: true, state_path: `state/${args.project}/state.md`,
        cost_usd: 0, tokens_in: 0, tokens_out: 0, duration_ms: 1,
      };
    },
    _reindexFn: async (arg) => { reindexCalls.push(arg); },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(reindexCalls.length, 1, 'reindexFn should be forwarded and called');
  assert.equal(typeof reindexCalls[0], 'string', 'reindexFn must receive a string');
  assert.ok(reindexCalls[0].includes('rest-reindex-proj'), `path must mention project, got: ${reindexCalls[0]}`);
});

// Fix 1 (DoS cap): MAX_TRANSCRIPT_BYTES — fixture exceeds 1MB; result.truncated=true
test('checkpoint: MAX_TRANSCRIPT_BYTES cap sets truncated:true in result', async () => {
  const vaultDir = await makeVault();
  // Write a file larger than 1MB (1.1MB of content)
  const bigContent = 'x'.repeat(1100 * 1024);
  await seedCapture(vaultDir, 'bigproj', '2026-01-01.md', bigContent);

  const result = await doCheckpoint(
    { project: 'bigproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true, 'truncated should be true when transcript exceeds cap');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// B.10 (spec §5.4): memory_checkpoint reindex is BLOCKING — retry 3x with
// 100/200/400ms backoff + jitter; on persistent failure surface UPSTREAM_FAILURE.
// Contrast with B.9 append-turn (best-effort fire-and-forget).
test('checkpoint: reindexFn persistent failure surfaces UPSTREAM_FAILURE (blocking + retry-exhausted)', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01.md', '# Session\nSome content.');

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  let attempts = 0;
  let result;
  try {
    result = await doCheckpoint(
      { project: 'myproj' },
      {
        config: BASE_CONFIG,
        vaultDir,
        summarizeFn: makeSummarizeFn(),
        updateStateFn: makeUpdateStateFn(),
        // Inject zero-delay retry so the test runs fast — we still want to
        // verify that 1 initial + 3 retries = 4 attempts before giving up.
        retryDelaysMs: [0, 0, 0],
        retryJitterMaxMs: 0,
        reindexFn: async () => {
          attempts += 1;
          throw new Error('mem0 unavailable');
        },
      },
    );
  } finally {
    console.warn = origWarn;
  }

  assert.equal(result.ok, false, 'persistent reindex failure must fail the checkpoint');
  assert.equal(result.error?.code ?? result.error, 'UPSTREAM_FAILURE',
    `expected UPSTREAM_FAILURE error code, got: ${JSON.stringify(result.error)}`);
  assert.equal(attempts, 4, 'reindex should be attempted 4x (initial + 3 retries) before giving up');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// B.10 Part C: retry-then-succeed completes successfully. Timing test asserts
// the retry budget actually waits 100+200+400 = 700ms minimum when 3 retries fire.
test('checkpoint: reindex retries 3x on transient failure with backoff timing >= 700ms', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'myproj', '2026-01-01.md', '# Session\nSome content.');

  let attempts = 0;
  const t0 = Date.now();
  const result = await doCheckpoint(
    { project: 'myproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {
        attempts += 1;
        if (attempts <= 3) throw new Error('transient');
        // 4th attempt succeeds
      },
    },
  );
  const elapsed = Date.now() - t0;

  assert.equal(result.ok, true, 'checkpoint should succeed after 3 retries');
  assert.equal(attempts, 4, 'reindex should be called 4x (initial + 3 retries) then succeed');
  // 100 + 200 + 400 = 700ms minimum (no jitter floor); allow some slack
  assert.ok(elapsed >= 700,
    `retry budget should enforce >= 700ms total wait, got ${elapsed}ms`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// B.10 Part B: two-phase write — phase-2 (rename / state-md update) failure
// must leave the .tmp summary file with `status: orphan_summary` frontmatter
// so next session-start can recover.
test('checkpoint: phase-2 failure leaves .tmp file with status: orphan_summary frontmatter', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'orphproj', '2026-01-01.md', '# Session\nContent.');

  // Inject phase-2 failure by stubbing updateStateFn to throw before state.md write.
  // This simulates a state.md write contention or disk-full error during phase-2.
  const result = await doCheckpoint(
    { project: 'orphproj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn({ summary: 'Orphan body here.' }),
      updateStateFn: async () => {
        const err = new Error('simulated phase-2 disk-full');
        err.code = 'ENOSPC';
        throw err;
      },
      reindexFn: async () => {},
    },
  );

  // Phase-2 failed, so checkpoint should fail
  assert.equal(result.ok, false, 'checkpoint should fail when phase-2 fails');

  // Locate the .tmp file in sessions/<project>/
  const sessionsDir = path.join(vaultDir, 'sessions', 'orphproj');
  const entries = await fs.readdir(sessionsDir);
  const tmpFile = entries.find((f) => f.endsWith('.md.tmp'));
  assert.ok(tmpFile, `expected .tmp file in ${sessionsDir}, got: ${entries.join(', ')}`);

  // Final renamed file must NOT exist (rename did not run, or was rolled back)
  const finalFile = entries.find((f) => f.endsWith('.md') && !f.endsWith('.md.tmp'));
  assert.ok(!finalFile, `expected NO finalized .md file, got: ${finalFile}`);

  // .tmp file must have status: orphan_summary in frontmatter
  const content = await fs.readFile(path.join(sessionsDir, tmpFile), 'utf8');
  assert.ok(content.startsWith('---\n'), 'tmp must start with frontmatter block');
  assert.ok(/^status:\s*orphan_summary$/m.test(content),
    `tmp file must have 'status: orphan_summary' frontmatter, got: ${content.slice(0, 400)}`);
  // Body must still be present
  assert.ok(content.includes('Orphan body here.'),
    'tmp file must still contain the original body content');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// B.10 Part A: lockdir migration — concurrent checkpoint calls must serialize
// cleanly via the new lockdir primitive (mirrors B.9 append-turn pattern).
test('checkpoint: lockdir-migrated path serializes concurrent calls cleanly', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'lockproj', '2026-01-01.md', '# Session\nLockdir test.');

  // Run two checkpoints concurrently — one must win, the other must see
  // the lockdir and return a clean checkpoint_in_progress without torn writes.
  const ctx = () => ({
    config: BASE_CONFIG,
    vaultDir,
    summarizeFn: makeSummarizeFn(),
    updateStateFn: makeUpdateStateFn(),
    reindexFn: async () => {},
  });

  const [r1, r2] = await Promise.all([
    doCheckpoint({ project: 'lockproj' }, ctx()),
    doCheckpoint({ project: 'lockproj' }, ctx()),
  ]);

  const wins = [r1, r2].filter((r) => r.ok);
  const losses = [r1, r2].filter((r) => !r.ok);
  assert.equal(wins.length, 1, `exactly one checkpoint should succeed, got: r1=${JSON.stringify(r1).slice(0,120)} r2=${JSON.stringify(r2).slice(0,120)}`);
  assert.equal(losses.length, 1, 'exactly one checkpoint should hit the lockdir');
  assert.equal(losses[0].error, 'checkpoint_in_progress');

  // Lockdir must be released after both calls
  const lockdirPath = path.join(vaultDir, 'state', 'lockproj', 'state.md.lockdir');
  const lockdirStat = await fs.stat(lockdirPath).catch(() => null);
  assert.equal(lockdirStat, null, 'lockdir must be released (rmdir) after checkpoint completes');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Round-9 blocker fix: default config path must resolve relative to lib dir, not REPO_ROOT.
// Omit ctx.config so doCheckpoint reads DEFAULT_CONFIG_PATH from disk.
// This test catches the 'new URL("../../", import.meta.url)' = "/" regression in Docker.
test('checkpoint: default config path resolves correctly (no ctx.config — Docker-safe path fix)', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'defaultcfg-proj', '2026-01-01T00.md', '# Session\nDefault config test.');

  // Do NOT pass ctx.config — doCheckpoint must read the real checkpoint.json from disk
  const result = await doCheckpoint(
    { project: 'defaultcfg-proj' },
    {
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
      // ctx.systemPrompt is also omitted — doCheckpoint must resolve DEFAULT_SUMMARIZE_PROMPT_PATH
      systemPrompt: 'Test prompt (bypass real file load)',
    },
  );

  // If the path was broken (resolving to /server/config/checkpoint.json), it would throw ENOENT
  // before reaching summarizeFn. A successful (ok:true) result proves the path is correct.
  assert.equal(result.ok, true,
    `Expected ok:true from real config load; got: ${JSON.stringify(result)}`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Round-10 blocker fix: summary file on disk must start with YAML frontmatter
// so reindexDoc can parse type/id/title and index into mem0.
test('checkpoint: summary file written to disk starts with YAML frontmatter', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'fm-proj', '2026-01-01T00.md', '# Session\nFrontmatter test.');

  const result = await doCheckpoint(
    { project: 'fm-proj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn({ summary: 'Body content here.' }),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
    },
  );

  assert.equal(result.ok, true, 'checkpoint should succeed');
  const diskContent = await fs.readFile(path.join(vaultDir, result.summary_path), 'utf8');
  assert.ok(diskContent.startsWith('---\n'), 'summary file must start with YAML frontmatter block');
  assert.ok(diskContent.includes('type: session_summary'), 'frontmatter must include type: session_summary');
  assert.ok(diskContent.includes(`id: ${result.summary_id}`), 'frontmatter must include the summary id');
  assert.ok(diskContent.includes('title: Session summary'), 'frontmatter must include a title field');
  assert.ok(diskContent.includes('project: fm-proj'), 'frontmatter must include the project slug');
  assert.ok(diskContent.includes('Body content here.'), 'LLM body must appear after frontmatter');

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Round-10: reindexDoc-compatible parse — frontmatter must satisfy the exact schema
// that reindexDoc checks: fm.type, fm.id, fm.title must all be present and truthy.
test('checkpoint: frontmatter satisfies reindexDoc required fields (type, id, title)', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'reindex-fm-proj', '2026-01-01T00.md', '# Session\nReindex frontmatter test.');

  // Spy: capture whatever the reindexFn receives so we can read the file ourselves
  let capturedPath = null;
  const result = await doCheckpoint(
    { project: 'reindex-fm-proj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async (relPath) => { capturedPath = relPath; },
    },
  );

  assert.equal(result.ok, true, 'checkpoint should succeed');
  assert.ok(capturedPath, 'reindexFn must be called');
  const diskContent = await fs.readFile(path.join(vaultDir, capturedPath), 'utf8');

  // Minimal frontmatter parse: extract the --- block
  const fmMatch = diskContent.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fmMatch, 'summary file must contain a YAML frontmatter block');
  const fmBlock = fmMatch[1];

  // Check each required field is present and non-empty
  const getField = (key) => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  assert.ok(getField('type'), `frontmatter must have a non-empty 'type' field`);
  assert.equal(getField('type'), 'session_summary', `type must be 'session_summary'`);
  assert.ok(getField('id'), `frontmatter must have a non-empty 'id' field`);
  assert.ok(getField('title'), `frontmatter must have a non-empty 'title' field`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// Round-9 blocker fix: default summarize-prompt path must resolve relative to lib dir.
// Omit ctx.systemPrompt so doCheckpoint reads DEFAULT_SUMMARIZE_PROMPT_PATH from disk.
test('checkpoint: default summarize prompt path resolves correctly (no ctx.systemPrompt — Docker-safe)', async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'defaultprompt-proj', '2026-01-01T00.md', '# Session\nDefault prompt test.');

  // Omit ctx.systemPrompt — doCheckpoint must find the file at server/config/prompts/summarize.txt
  const result = await doCheckpoint(
    { project: 'defaultprompt-proj' },
    {
      config: BASE_CONFIG,
      vaultDir,
      summarizeFn: makeSummarizeFn(),
      updateStateFn: makeUpdateStateFn(),
      reindexFn: async () => {},
      // no systemPrompt override
    },
  );

  // If DEFAULT_SUMMARIZE_PROMPT_PATH resolved wrongly, result would be {ok:false, error:'summarize prompt file missing'}
  assert.equal(result.ok, true,
    `Expected ok:true from real prompt load; got: ${JSON.stringify(result)}`);

  await fs.rm(vaultDir, { recursive: true, force: true });
});

// B.12 followup: kernel-level O_NOFOLLOW symlink-swap defense for checkpoint.
// Companion to vault-nofollow.test.mjs and the appendFile test in
// append-turn.test.mjs. Closes the lstat→open TOCTOU race on every vault
// write inside checkpoint.mjs. The state.md.tmp path is predictable
// (state/<project>/state.md.tmp), so we plant a symlink there and verify
// that the kernel rejects with ELOOP — protecting an outside-vault file
// from being overwritten through the symlink. By code symmetry the same
// protection applies to the 5 other writes in checkpoint.mjs (summary .tmp,
// orphan rewrites, telemetry).
//
// Windows note: file-symlink creation requires admin/Developer Mode on
// Windows, and constants.O_NOFOLLOW is undefined on Windows (coerced to 0;
// no-op). Skip on win32; the lstat-refusal layer covers cross-platform.
test('checkpoint: O_NOFOLLOW rejects symlink at state.md.tmp path (kernel-level defense)', { skip: process.platform === 'win32' }, async () => {
  const vaultDir = await makeVault();
  await seedCapture(vaultDir, 'symswap-proj', '2026-01-01T00.md', '# Session\nWork.');

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'um-ck-out-'));
  try {
    // Pre-existing file outside the vault — the attacker's redirection target.
    const outsideTarget = path.join(outside, 'outside.txt');
    await fs.writeFile(outsideTarget, 'pre-existing-outside-data', 'utf8');

    // Plant a symlink at state/<project>/state.md.tmp (a path checkpoint
    // writes to during phase-2 state.md two-phase update). The pre-existing
    // lstat check guards state.md (not state.md.tmp), so without O_NOFOLLOW
    // the open(O_WRONLY|O_CREAT|O_TRUNC) on .tmp would follow the symlink
    // and overwrite outside.txt. With O_NOFOLLOW the syscall returns ELOOP.
    const stateDir = path.join(vaultDir, 'state', 'symswap-proj');
    await fs.mkdir(stateDir, { recursive: true });
    const stateTmpLink = path.join(stateDir, 'state.md.tmp');
    await fs.symlink(outsideTarget, stateTmpLink, 'file');

    const result = await doCheckpoint(
      { project: 'symswap-proj' },
      {
        config: BASE_CONFIG,
        vaultDir,
        summarizeFn: makeSummarizeFn(),
        updateStateFn: makeUpdateStateFn(),
        reindexFn: async () => {},
      },
    );

    // Phase-2 must fail (ELOOP propagates as the phase2Err path in
    // checkpoint.mjs). The result envelope reports ok:false with the
    // open() error message.
    assert.equal(result.ok, false, `expected ok:false from O_NOFOLLOW rejection, got: ${JSON.stringify(result)}`);
    const errMsg = typeof result.error === 'string' ? result.error : (result.error?.message ?? '');
    assert.match(errMsg, /ELOOP|symbolic link|symlink/i, `expected ELOOP/symlink-related error, got: ${JSON.stringify(result.error)}`);

    // Critical invariant: outside file unchanged. O_NOFOLLOW must have
    // prevented the open() from following the symlink — no write reached
    // outsideTarget through the redirection.
    const outsideContent = await fs.readFile(outsideTarget, 'utf8');
    assert.equal(
      outsideContent,
      'pre-existing-outside-data',
      'outside file must remain unchanged — O_NOFOLLOW prevented the write',
    );
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
