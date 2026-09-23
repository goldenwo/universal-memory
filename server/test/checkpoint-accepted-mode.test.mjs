/**
 * #309 — `/api/checkpoint` accepted mode.
 *
 * Under accepted mode the server validates, answers an EMPTY 202, and runs
 * synthesis afterwards, so the hook has nothing left to outlive on a host that
 * reaps its process tree. Two properties carry the whole change and neither is
 * observable from a green unit run by itself, so they are pinned here:
 *
 *   1. THE WIRE SHAPE. `writeHead(202); end()` with NO Content-Type and a
 *      zero-length body. `res.status(202).json({})` would pass every other
 *      assertion in this file — `um_api_post` returns 0 for ANY 2xx — while
 *      reproducing the exact shape that broke Codex CLI's rmcp client and made
 *      POST /mcp grow its own 202 path.
 *
 *   2. REJECTION SAFETY. There is no `unhandledRejection` handler in server/,
 *      and lockdir.mjs:121 turns the resulting `uncaughtException` into
 *      `process.exit(1)`. An accepted job that rejects outside a catch takes
 *      the whole server down for every consumer. Inspection is not enough for
 *      a fault whose symptom is the server disappearing.
 *
 * The T2 classifier is exercised against REAL doCheckpoint envelopes wherever
 * one can be produced, not hand-built objects. That is deliberate: three
 * successive drafts of this contract named a wire value the code does not emit
 * (`chunksDone` for the envelope's `chunks_done`, a bare `lock_acquire_failed`
 * for a string that carries its own code), and a test mirroring the same typo
 * would have certified a corpse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { doCheckpoint } from '../lib/checkpoint.mjs';
import { handleCheckpointRequest, createRequestHandler } from '../mem0-mcp-http.mjs';
import { classifyCheckpointSettlement } from '../lib/checkpoint-signal.mjs';
import { tempDir } from './helpers/tmpdir.mjs';

// COUNTERS ISOLATION — module scope, before a single test runs.
//
// The rejection tests below settle as `rejected`, which is a TRIGGERING outcome
// for um-alert's CHECKPOINT-FAILURE arm, and settling emits a real counter row.
// Without this, that row lands in countersDbPath()'s default location, and on a
// machine whose server reads that path the unit suite makes the daily alert fire
// for a fabricated project for SEVEN DAYS — the same hazard continuity.sh
// carries a header warning about for the #267 family.
//
// It has to be module scope, not per-test setup: capture-events opens a LAZY
// SINGLETON handle bound to whichever path is resolved on the first emit, so
// per-test env juggling leaves the isolation dependent on declaration order and
// it silently breaks under `--test-name-pattern`. Node runs this module body
// before any test, and `node --test` gives each file its own process.
process.env.UM_COUNTERS_DB_PATH = path.join(tempDir('um-309-counters-'), 'um-counters.db');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Mock response mirroring the REAL route adapter, including `sendBodiless` —
 * the method T1 added so the decided 202 shape is reachable at all. `json()`
 * records that a JSON body was sent so a test can assert it was NOT.
 */
function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    jsonCalled: false,
    bodilessCode: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.jsonBody = obj; this.jsonCalled = true; return this; },
    sendBodiless(code) { this.bodilessCode = code; this.statusCode = code; },
  };
}

async function seedCapture(vaultDir, project, filename, content) {
  const rawDir = path.join(vaultDir, 'captures', project, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, filename), content);
  return path.join(rawDir, filename);
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------------------
// 1. Wire shape — the decided contract, asserted over a real socket
// ---------------------------------------------------------------------------

test('#309: accepted mode answers 202 with NO Content-Type and a zero-length body', async () => {
  const vaultDir = tempDir('um-309-wire-');
  const prevWrite = process.env.UM_MCP_WRITE_ENABLED;
  const prevVault = process.env.UM_VAULT_DIR;
  process.env.UM_MCP_WRITE_ENABLED = 'true';
  process.env.UM_VAULT_DIR = vaultDir;
  // UM_COUNTERS_DB_PATH is pinned at module scope — do NOT re-point it here:
  // the lazy singleton binds to the first path resolved, so a second override
  // would take effect only if this test happened to emit first.

  const srv = createServer(createRequestHandler({}));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/checkpoint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'wire-proj', mode: 'accepted' }),
    });
    assert.equal(res.status, 202, 'accepted mode must answer 202');
    assert.equal(res.headers.get('content-type'), null,
      'no Content-Type on an empty acknowledgement — an empty application/json body is not a JSON document, and that exact shape broke Codex CLI rmcp');
    assert.equal(await res.text(), '', 'the 202 body must be empty: no summary_id, no job id, nothing');
    // The background job runs against an empty vault and will settle as a
    // failure. It must not take the process down — see the rejection-safety
    // tests below for the explicit form of that guarantee.
    await settle();
  } finally {
    await new Promise((r) => srv.close(r));
    process.env.UM_MCP_WRITE_ENABLED = prevWrite ?? '';
    if (prevVault === undefined) delete process.env.UM_VAULT_DIR; else process.env.UM_VAULT_DIR = prevVault;
    // Best-effort: the background job opens the counters DB through the
    // lazy-singleton handle, which stays open for the process lifetime, so on
    // Windows the WAL sidecars are still locked here (EBUSY on unlink). The
    // temp-root CI sweep collects what is left; failing the test over cleanup
    // would hide the assertions above.
    await fs.rm(vaultDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 2. The 202 precedes synthesis — asserted on ordering, not on a mock
// ---------------------------------------------------------------------------

test('#309: the 202 is written BEFORE synthesis finishes', async () => {
  let synthesisDone = false;
  const res = mockRes();
  await handleCheckpointRequest({ body: { project: 'timing-proj', mode: 'accepted' } }, res, {
    writesEnabled: true,
    _doCheckpoint: async () => {
      await new Promise((r) => setTimeout(r, 120));
      synthesisDone = true;
      return { schema_version: 1, ok: true };
    },
  });
  assert.equal(res.bodilessCode, 202, 'must respond via the bodiless adapter method');
  assert.equal(res.jsonCalled, false, 'the 202 must NOT go through json() — that would set Content-Type');
  assert.equal(synthesisDone, false, 'the handler returned before synthesis completed — that is the entire point');
  await settle();
});

// ---------------------------------------------------------------------------
// 3. Validation that still precedes the 202
// ---------------------------------------------------------------------------

test('#309: an unknown `mode` is a 400, never a silent fallback to synchronous', async () => {
  let ran = false;
  const res = mockRes();
  await handleCheckpointRequest({ body: { project: 'p', mode: 'async' } }, res, {
    writesEnabled: true,
    _doCheckpoint: async () => { ran = true; return { schema_version: 1, ok: true }; },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.bodilessCode, null, 'a rejected mode must not be accepted');
  assert.equal(ran, false, 'no synthesis may start for an unrecognised mode');
});

test('#309: an absent `mode` keeps the synchronous 200 path byte-for-byte', async () => {
  const res = mockRes();
  await handleCheckpointRequest({ body: { project: 'sync-proj' } }, res, {
    writesEnabled: true,
    _doCheckpoint: async () => ({ schema_version: 1, ok: true, summary_id: 's1' }),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.bodilessCode, null, 'the synchronous path must never use the bodiless adapter');
  assert.equal(res.jsonBody.ok, true);
});

test('#309: 403 writes-disabled still precedes acceptance', async () => {
  const res = mockRes();
  await handleCheckpointRequest({ body: { project: 'p', mode: 'accepted' } }, res, { writesEnabled: false });
  assert.equal(res.statusCode, 403);
  assert.equal(res.bodilessCode, null);
});

test('#309: an invalid project slug still 400s BEFORE acceptance', async () => {
  let ran = false;
  const res = mockRes();
  await handleCheckpointRequest({ body: { project: 'bad slug/../x', mode: 'accepted' } }, res, {
    writesEnabled: true,
    _doCheckpoint: async () => { ran = true; return { schema_version: 1, ok: true }; },
  });
  assert.equal(res.statusCode, 400, 'slug resolution must happen before the 202 — it is one of the four errors the caller still hears about');
  assert.equal(res.bodilessCode, null);
  assert.equal(ran, false);
});

test('#309: an omitted project soft-defaults and IS accepted (applyDefaultProject parity)', async () => {
  let seenProject = null;
  const res = mockRes();
  await handleCheckpointRequest({ body: { mode: 'accepted' } }, res, {
    writesEnabled: true,
    _doCheckpoint: async (args) => { seenProject = args.project; return { schema_version: 1, ok: true }; },
  });
  assert.equal(res.bodilessCode, 202);
  await settle();
  assert.equal(typeof seenProject, 'string', 'the RESOLVED slug must be passed to the job, not the raw undefined');
  assert.ok(seenProject.length > 0);
});

// ---------------------------------------------------------------------------
// 4. Rejection safety — the fault whose symptom is the server disappearing
// ---------------------------------------------------------------------------

test('#309: a background job that REJECTS is caught — no unhandledRejection', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const res = mockRes();
    await handleCheckpointRequest({ body: { project: 'boom-proj', mode: 'accepted' } }, res, {
      writesEnabled: true,
      _doCheckpoint: async () => { throw new Error('prompt load failed'); },
    });
    assert.equal(res.bodilessCode, 202, 'the caller still gets its 202 — the failure happens after');
    // Two macrotask turns: the rejection has to propagate through the
    // .then/.catch chain before an unhandledRejection could be raised.
    await settle();
    await settle();
    assert.deepEqual(seen, [],
      'an accepted job rejecting outside a catch would reach lockdir.mjs:121 and process.exit(1) the server for every consumer');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('#309: a SYNCHRONOUS throw from the job function is caught too', async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const res = mockRes();
    await handleCheckpointRequest({ body: { project: 'sync-boom', mode: 'accepted' } }, res, {
      writesEnabled: true,
      // Not an async function — throws before returning a promise at all.
      _doCheckpoint: () => { throw new Error('synchronous explosion'); },
    });
    assert.equal(res.bodilessCode, 202);
    await settle();
    await settle();
    assert.deepEqual(seen, [], 'the Promise.resolve().then() wrapper exists precisely for this case');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// 5. The T2 classifier — REAL envelopes wherever one can be produced
// ---------------------------------------------------------------------------

test('#309 classifier / REAL envelope: a held raw-file lockdir with nothing committed ⇒ zero_commit', async () => {
  const vaultDir = tempDir('um-309-zc-');
  try {
    const capture = await seedCapture(vaultDir, 'zc-proj', '2026-01-01.md',
      '# Session\n' + 'plenty of transcript body to clear the admission floors. '.repeat(40));
    // Hold the raw file's lockdir so the chunk builder bails with
    // stopped:{reason:'raw_lock'} having committed zero pieces.
    await fs.mkdir(`${capture}.lockdir`, { recursive: true });

    const result = await doCheckpoint({ project: 'zc-proj' }, {
      vaultDir,
      summarizeFn: async () => ({ summary: 'unused', costUsd: 0, tokensIn: 0, tokensOut: 0 }),
    });

    // Pin the envelope shape this term reads, off the real thing. `chunks_done`
    // is SNAKE_CASE on the wire; `chunksDone` is the internal accumulator, and
    // reading that here would yield `undefined === 0` and ship the term dead.
    assert.equal(result.ok, true, 'raw_lock with no progress is a SUCCESS envelope');
    assert.equal(result.stopped?.reason, 'raw_lock');
    assert.equal(result.chunks_done, 0);
    assert.ok(!('chunksDone' in result), 'the envelope must not carry the internal camelCase accumulator');

    assert.equal(classifyCheckpointSettlement({ result }), 'zero_commit');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('#309 classifier / REAL envelope: a held state.md lockdir ⇒ contended (recorded, never alerted)', async () => {
  const vaultDir = tempDir('um-309-ct-');
  try {
    await seedCapture(vaultDir, 'ct-proj', '2026-01-01.md', '# Session\n' + 'body. '.repeat(200));
    const lockdir = path.join(vaultDir, 'state', 'ct-proj', 'state.md.lockdir');
    await fs.mkdir(lockdir, { recursive: true });

    const result = await doCheckpoint({ project: 'ct-proj' }, {
      vaultDir,
      summarizeFn: async () => ({ summary: 'unused', costUsd: 0, tokensIn: 0, tokensOut: 0 }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'checkpoint_in_progress', 'the exact bare string this term matches positively');
    assert.equal(classifyCheckpointSettlement({ result }), 'contended');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('#309 classifier / REAL envelope: the run-start cost cap is FREE TEXT with no code ⇒ failed (proves rule 3 is a residual)', async () => {
  const vaultDir = tempDir('um-309-cc-');
  try {
    await seedCapture(vaultDir, 'cc-proj', '2026-01-01.md', '# Session\n' + 'body. '.repeat(200));
    const today = new Date().toISOString().slice(0, 10);
    const telemetry = path.join(vaultDir, '.telemetry');
    await fs.mkdir(telemetry, { recursive: true });
    await fs.writeFile(path.join(telemetry, `${today}-cc-proj.count`), '999999');

    const result = await doCheckpoint({ project: 'cc-proj' }, {
      vaultDir,
      summarizeFn: async () => ({ summary: 'unused', costUsd: 0, tokensIn: 0, tokensOut: 0 }),
    });

    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(!result.error.includes('_'), 'this failure carries no token at all — it is a human sentence');
    // THE POINT: no rule names this string, and it still alerts.
    assert.equal(classifyCheckpointSettlement({ result }), 'failed');
  } finally {
    await fs.rm(vaultDir, { recursive: true, force: true });
  }
});

test('#309 classifier: lock_acquire_failed carries its own code and lands in `failed`, NOT contended', () => {
  // Production emits `lock_acquire_failed: ${code}` (checkpoint.mjs:271) — a
  // string carrying its own code, never the bare token. Under the residual rule
  // NOTHING matches it, which is exactly why the near-miss that worried three
  // review passes cannot happen: both forms classify identically.
  assert.equal(classifyCheckpointSettlement({ result: { ok: false, error: 'lock_acquire_failed: ENOSPC' } }), 'failed');
  assert.equal(classifyCheckpointSettlement({ result: { ok: false, error: 'lock_acquire_failed' } }), 'failed');
  // A full disk is a hard fault. Do not "tidy" it into `contended` on the
  // strength of the word "lock": genuine contention returns FALSE from
  // acquireLockdir under timeoutMs:0 and becomes `checkpoint_in_progress`.
  // This branch means the call THREW.
});

test('#309 classifier: every coded failure object lands in `failed` without being named', () => {
  for (const code of ['UPSTREAM_FAILURE', 'SERVER_INTERNAL', 'A_CODE_INVENTED_AFTER_THIS_SHIPPED']) {
    assert.equal(classifyCheckpointSettlement({ result: { ok: false, error: { code, message: 'x' } } }), 'failed',
      `${code} must alert by default — a failure shape added later must not fold away silently`);
  }
});

test('#309 classifier: STATE_LOCK_CONTENTION is the ONE coded object that is contention', () => {
  assert.equal(
    classifyCheckpointSettlement({ result: { ok: false, error: { code: 'STATE_LOCK_CONTENTION', message: 'phase 2' } } }),
    'contended');
});

test('#309 classifier: a rejection is `rejected`, never folded into a success shape', () => {
  assert.equal(classifyCheckpointSettlement({ rejected: true }), 'rejected');
  assert.equal(classifyCheckpointSettlement({ result: undefined, rejected: true }), 'rejected');
});

test('#309 classifier: a malformed settlement alerts rather than folding into `other`', () => {
  // `other` must be reachable ONLY from the ok:true side, or it stops being a
  // drift tripwire and becomes a place failures hide.
  for (const result of [undefined, null, {}, { ok: 'yes' }, { ok: false }]) {
    assert.equal(classifyCheckpointSettlement({ result }), 'failed',
      `a settlement that is not positively ok:true must alert, got ${JSON.stringify(result)}`);
  }
});

test('#309 classifier: the routine drains are NOT RECORDED AT ALL', () => {
  // Counting either would make every routine multi-chunk drain fire the
  // rollback trigger the rollout keys on.
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, backlog_remaining: true, stopped: { reason: 'chunk_cap' }, chunks_done: 3 },
  }), null, 'the per-run chunk cap is normal; um-drain.sh loops through it');
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, backlog_remaining: true, stopped: { reason: 'cost_cap' }, chunks_done: 2 },
  }), null, 'the MID-RUN cost cap is a success envelope and by design; the RUN-START cap is ok:false and alerts via the residual');
});

test('#309 classifier: a plain success and a thin-transcript abstention are NOT RECORDED', () => {
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, summary_id: 's1', chunks_done: 1, backlog_remaining: false },
  }), null, 'a checkpoint that simply worked is not a member of a failure family');
  // The real abstention envelope (checkpoint.mjs:805-811) — ok:true, `skipped`,
  // and NO `stopped` key. It is the likeliest outcome of a minimal probe
  // session, so folding it into `other` would make the drift tripwire non-zero
  // in routine operation and destroy the only thing it is for.
  assert.equal(classifyCheckpointSettlement({
    result: { schema_version: 1, ok: true, skipped: 'thin_transcript', transcript_bytes: 10, transcript_turns: 1 },
  }), null);
});

test('#309 classifier: provider stalls are recorded, and an unknown STOP is the drift tripwire', () => {
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, stopped: { reason: 'provider_ratelimit' }, chunks_done: 2 },
  }), 'provider_stalled');
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, stopped: { reason: 'provider_failure' }, chunks_done: 1 },
  }), 'provider_stalled');
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, stopped: { reason: 'a_reason_invented_later' }, chunks_done: 4 },
  }), 'other', 'a new stopped.reason must surface as `other` and nothing else may change silently');
});

test('#309 classifier: raw_lock WITH committed chunks is a routine race, NOT recorded', () => {
  // The third by-design early stop, and the one most easily mistaken for drift:
  // the chunk builder hit a capture file whose lockdir an in-flight append-turn
  // holds (checkpoint.mjs:454). That race happens on any active project. Folding
  // it into `other` would make the drift tripwire non-zero in normal operation
  // and send an operator hunting a contract defect that is not there.
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, backlog_remaining: true, stopped: { reason: 'raw_lock' }, chunks_done: 2 },
  }), null);
  // Only the ZERO-commit case survives as a signal — that run accomplished
  // nothing at all, which is what the term exists to catch.
  assert.equal(classifyCheckpointSettlement({
    result: { ok: true, backlog_remaining: true, stopped: { reason: 'raw_lock' }, chunks_done: 0 },
  }), 'zero_commit');
});
