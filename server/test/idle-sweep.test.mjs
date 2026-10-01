// server/test/idle-sweep.test.mjs — #314 T2: the server-side idle/age sweep (spec §4.2.2,
// D1-D11), registered cases S01-S27. Injected clock, fake buildLayers and checkpointFn,
// except S21's last clause, which runs the real buildLayers + doCheckpoint on a temp vault.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir } from './helpers/tmpdir.mjs';
import { createIdleSweep, isSweepEnabled, startIdleSweep } from '../lib/idle-sweep.mjs';
import { HEARTBEAT_INTERVAL_MS } from '../lib/checkpoint-config.mjs';
import { buildLayers } from '../lib/layers.mjs';
import { doCheckpoint } from '../lib/checkpoint.mjs';

const H = 3_600_000;
const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A layers.mjs payload entry as seen at `t`. */
function layer(t, { undigested = true, idleH = 10, ageH = 10, repairH = null } = {}) {
  return {
    last_capture_at: iso(t - idleH * H),
    pending_bytes: undigested ? 5000 : 0,
    undigested,
    waiting_since: undigested && Number.isFinite(ageH) ? iso(t - ageH * H) : null,
    age_hours: !undigested ? null : Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : 'Infinity',
    repair_since: repairH === null ? null : iso(t - repairH * H),
    repair_hours: repairH,
  };
}

// doCheckpoint envelope shapes (checkpoint.mjs).
const DIGESTED = { schema_version: 1, ok: true, summary_path: 'sessions/x/s.md', chunks_done: 1, backlog_remaining: false };
const ABSTAINED = { schema_version: 1, ok: true, skipped: 'thin_transcript', transcript_bytes: 0, transcript_turns: 0, duration_ms: 1 };
const CONTENDED = { schema_version: 1, ok: false, error: 'checkpoint_in_progress' };
const FAILED = { schema_version: 1, ok: false, error: { code: 'SERVER_INTERNAL', stage: 'cursor_write', message: 'x' } };
const REINDEX_FAILED = {
  schema_version: 1, ok: false, error: { code: 'UPSTREAM_FAILURE', stage: 'reindex', message: 'x' },
  summary_id: 's', summary_path: 'sessions/x/s.md',
};
const COST_CAP_START = { schema_version: 1, ok: false, error: 'cost cap hit' };
const RATELIMIT_START = { schema_version: 1, ok: false, error: { code: 'UPSTREAM_FAILURE', stage: 'summarize', provider_class: 'ratelimit', message: '429' } };
const PROVIDER_FAIL_START = { schema_version: 1, ok: false, error: { code: 'UPSTREAM_FAILURE', stage: 'summarize', provider_class: 'upstream', message: '500' } };
const ZERO_COMMIT = { schema_version: 1, ok: true, chunks_done: 0, backlog_remaining: true, stopped: { reason: 'raw_lock' }, truncated: true };
const partial = (reason) => ({ schema_version: 1, ok: true, summary_path: 'sessions/x/s.md', chunks_done: 1, backlog_remaining: true, stopped: { reason }, truncated: true });

const REINDEX = async () => {};

function fakeTimers() {
  const t = { timeouts: [], intervals: [], cleared: [] };
  const handle = () => ({ unrefCalls: 0, unref() { this.unrefCalls += 1; return this; } });
  t.setTimeout = (fn, ms) => { const h = handle(); t.timeouts.push({ fn, ms, handle: h }); return h; };
  t.setInterval = (fn, ms) => { const h = handle(); t.intervals.push({ fn, ms, handle: h }); return h; };
  t.clearTimeout = (h) => { t.cleared.push(['timeout', h]); };
  t.clearInterval = (h) => { t.cleared.push(['interval', h]); };
  return t;
}

/**
 * A sweep over fake layers. `results[project]` is an envelope, an Error (the call rejects), or
 * a function of that project's 1-based call count returning either.
 */
function harness({ layers: spec = () => ({}), results = {}, env = { UM_SUMMARY_LAG_MAX_HOURS: '30' }, writes = () => true, ...over } = {}) {
  let t = T0;
  const calls = [];
  const logs = [];
  const events = [];
  const log = {
    info: (obj, msg) => { logs.push({ level: 'info', obj, msg }); },
    warn: (obj, msg) => { logs.push({ level: 'warn', obj, msg }); },
    error: (obj, msg) => { logs.push({ level: 'error', obj, msg }); },
  };
  const checkpointFn = async (args, ctx) => {
    calls.push({ project: args.project, args, ctx });
    const r = results[args.project];
    const n = calls.filter((c) => c.project === args.project).length;
    const v = typeof r === 'function' ? r(n) : (r ?? DIGESTED);
    if (v instanceof Error) throw v;
    return v;
  };
  const sweep = createIdleSweep({
    buildLayers: async ({ now }) => ({ layers: spec(now), degraded: [] }),
    checkpointFn,
    ctx: { vaultDir: '/vault', reindexFn: REINDEX, surface: 'not-the-sweep' },
    isWriteEnabled: writes,
    env,
    now: () => t,
    log,
    recordEvent: (e) => { events.push(e); },
    readCursor: async () => null,
    ...over,
  });
  return { sweep, calls, logs, events, advance: (ms) => { t += ms; }, attempted: () => calls.map((c) => c.project) };
}

test('S01 #314: the idle arm — an undigested layer idle for 6 h is attempted; one idle 5.9 h with a young backlog is not', async () => {
  const h = harness({ layers: (t) => ({ idle6: layer(t, { idleH: 6, ageH: 2 }), idle59: layer(t, { idleH: 5.9, ageH: 2 }) }) });
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['idle6']);
});

test('S02 #314: the age arm attempts an active layer once its oldest content waited MAX_AGE (24 h at LAG_MAX 30)', async () => {
  const h = harness({ layers: (t) => ({ old: layer(t, { idleH: 0, ageH: 24 }), young: layer(t, { idleH: 0, ageH: 23.9 }) }) });
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['old']);
});

test('S03 #314: a layer that is not undigested and carries no repair entry is skipped', async () => {
  const h = harness({ layers: (t) => ({ done: layer(t, { undigested: false, idleH: 100 }) }) });
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), []);
});

test('S04 #314: writes disabled ⇒ nothing is read and nothing is attempted', async () => {
  let layersRead = 0;
  const h = harness({
    writes: () => false,
    buildLayers: async () => { layersRead += 1; return { layers: { a: layer(T0) }, degraded: [] }; },
  });
  await h.sweep.runOnce();
  assert.equal(layersRead, 0);
  assert.deepEqual(h.attempted(), []);
});

test('S05 #314: at most 8 attempts per run, oldest first — ∞ first, then age, ties by name', async () => {
  const h = harness({
    layers: (t) => ({
      'a-young': layer(t, { ageH: 30, idleH: 7 }),
      'b-inf': layer(t, { ageH: Infinity, idleH: 7 }),
      'c-old': layer(t, { ageH: 90, idleH: 7 }),
      'd-tie': layer(t, { ageH: 50, idleH: 7 }),
      'e-tie': layer(t, { ageH: 50, idleH: 7 }),
      'f-inf': layer(t, { ageH: Infinity, idleH: 7 }),
      g: layer(t, { ageH: 40, idleH: 7 }),
      h: layer(t, { ageH: 39, idleH: 7 }),
      i: layer(t, { ageH: 38, idleH: 7 }),
      j: layer(t, { ageH: 8, idleH: 7 }),
    }),
  });
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['b-inf', 'f-inf', 'c-old', 'd-tie', 'e-tie', 'g', 'h', 'i']);
  assert.deepEqual(h.sweep.state().last_run, { eligible: 10, attempted: 8 });
});

test('S06 #314: after digested, abstained, contended or failed a layer waits 6 h', async () => {
  const outcomes = { dig: DIGESTED, abs: ABSTAINED, con: CONTENDED, fai: FAILED };
  const h = harness({ layers: (t) => Object.fromEntries(Object.keys(outcomes).map((p) => [p, layer(t)])), results: outcomes });
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted().sort(), ['abs', 'con', 'dig', 'fai']);
  h.advance(6 * H - 60_000);
  await h.sweep.runOnce();
  assert.equal(h.calls.length, 4, 'nobody is retried inside the window');
  h.advance(60_000);
  await h.sweep.runOnce();
  assert.equal(h.calls.length, 8, 'everyone is retried at 6 h');
});

test('S07 #314: a chunk_cap or raw_lock stop with backlog left is attempted again on the next run', async () => {
  const h = harness({ layers: (t) => ({ cap: layer(t), lock: layer(t) }), results: { cap: partial('chunk_cap'), lock: partial('raw_lock') } });
  await h.sweep.runOnce();
  h.advance(H);
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted().sort(), ['cap', 'cap', 'lock', 'lock']);
});

test('S08 #314: a cost cap, mid-run or at run start, waits until the next UTC day', async () => {
  const h = harness({ layers: (t) => ({ mid: layer(t), start: layer(t) }), results: { mid: partial('cost_cap'), start: COST_CAP_START } });
  await h.sweep.runOnce(); // 2026-09-28T12:00Z
  h.advance(12 * H - 60_000); // 23:59
  await h.sweep.runOnce();
  assert.equal(h.calls.length, 2, 'not retried the same UTC day');
  h.advance(60_000); // 2026-09-29T00:00Z
  await h.sweep.runOnce();
  assert.equal(h.calls.length, 4, 'retried from the next UTC day');
});

test('S09 #314: a restart (new instance) resets the retry map and rate-limit streaks; a layer with an entry on disk is still eligible', async () => {
  const spec = (t) => ({
    a: layer(t, { ageH: 50 }),
    rep: layer(t, { undigested: false, repairH: 40 }),
    rl: layer(t, { ageH: 30 }),
  });
  const results = { a: DIGESTED, rep: ABSTAINED, rl: RATELIMIT_START };
  const first = harness({ layers: spec, results });
  await first.sweep.runOnce(); // a digested, rep abstained, rl rate-limited (streak 1)
  first.advance(H);
  await first.sweep.runOnce(); // rl rate-limited again (streak 2)
  assert.deepEqual(first.attempted(), ['a', 'rep', 'rl', 'rl']);

  const second = harness({ layers: spec, results });
  second.advance(2 * H);
  await second.sweep.runOnce();
  assert.deepEqual(second.attempted(), ['a', 'rep', 'rl'], 'the new instance has no retry windows, and the entry still makes rep eligible');
  second.advance(H);
  await second.sweep.runOnce();
  assert.deepEqual(second.attempted(), ['a', 'rep', 'rl', 'rl'], 'rl’s streak restarted at 1, so it is not yet waiting');
});

test('S10 #314: single-flight — a run started while one is in progress returns at once and attempts nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const enteredP = new Promise((r) => { entered = r; });
  let inFlight = 0;
  let maxInFlight = 0;
  const h = harness({
    layers: (t) => ({ a: layer(t) }),
    checkpointFn: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      entered();
      await gate;
      inFlight -= 1;
      return DIGESTED;
    },
  });
  const first = h.sweep.runOnce();
  await Promise.race([enteredP, sleep(200)]);
  const second = h.sweep.runOnce();
  const raced = await Promise.race([second.then(() => 'returned'), sleep(200).then(() => 'still running')]);
  release();
  await first;
  await second;
  assert.equal(raced, 'returned', 'the second run returned while the first was still in progress');
  assert.ok(maxInFlight <= 1, 'never two checkpoints at once');
});

test('S11 #314: buildLayers throwing ends the run — runOnce resolves and nothing is attempted', async () => {
  const h = harness({ buildLayers: async () => { throw new Error('vault unreadable'); } });
  await assert.doesNotReject(h.sweep.runOnce());
  assert.deepEqual(h.attempted(), []);
});

test('S12 #314: a rejected checkpoint is outcome "rejected" and the run continues to the next layer', async () => {
  const h = harness({ layers: (t) => ({ a: layer(t, { ageH: 50 }), b: layer(t, { ageH: 40 }) }), results: { a: new Error('boom') } });
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['a', 'b']);
  assert.equal(h.sweep.state().layers.a.outcome, 'rejected');
  assert.equal(h.sweep.state().layers.b.outcome, 'digested');
});

test('S13 #314: isWriteEnabled throwing ends the run — runOnce resolves and nothing is attempted', async () => {
  const h = harness({ layers: (t) => ({ a: layer(t) }), writes: () => { throw new Error('env unreadable'); } });
  await assert.doesNotReject(h.sweep.runOnce());
  assert.deepEqual(h.attempted(), []);
});

test('S14 #314: start() schedules the first run and the hourly interval, both unref’d, and a tick never rejects', async () => {
  const timers = fakeTimers();
  const throwing = () => { throw new Error('logger down'); };
  const h = harness({
    timers,
    buildLayers: async () => { throw new Error('vault unreadable'); },
    log: { info: throwing, warn: throwing, error: throwing },
  });
  assert.equal(h.sweep.start(), h.sweep, 'start() returns the sweep');
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.timeouts[0].handle.unrefCalls, 1);
  assert.equal(timers.intervals[0].handle.unrefCalls, 1);
  await assert.doesNotReject(Promise.resolve(timers.intervals[0].fn()));
  await assert.doesNotReject(Promise.resolve(timers.timeouts[0].fn()));
});

test('S15 #314: stop() clears both timers', () => {
  const timers = fakeTimers();
  const h = harness({ timers });
  h.sweep.start();
  h.sweep.stop();
  assert.deepEqual(timers.cleared, [['timeout', timers.timeouts[0].handle], ['interval', timers.intervals[0].handle]]);
});

test('S16 #314: state() — nulls before the first run, then last_run and one entry per attempted layer', async () => {
  const h = harness({
    layers: (t) => ({ a: layer(t), quiet: layer(t, { undigested: false }) }),
    readCursor: async () => ({ file: '2026-09-28.md', offset: 42, boundary: 'turn', lastTurnIso: null, updatedAt: null }),
    results: { a: { ...DIGESTED, repairs: { done: 1, failed: 0, dropped: 0 } } },
  });
  assert.deepEqual(h.sweep.state(), { enabled: true, last_run_at: null, last_run: null, layers: {} });
  await h.sweep.runOnce();
  const s = h.sweep.state();
  assert.equal(s.enabled, true);
  assert.equal(s.last_run_at, iso(T0));
  assert.deepEqual(s.last_run, { eligible: 1, attempted: 1 });
  assert.deepEqual(Object.keys(s.layers), ['a']);
  assert.deepEqual(s.layers.a, {
    last_attempt_at: iso(T0),
    outcome: 'digested',
    stopped_reason: null,
    next_eligible_at: iso(T0 + 6 * H),
    cursor_after: { file: '2026-09-28.md', offset: 42 },
    repair: { done: 1, failed: 0, dropped: 0 },
  });
});

test('S17 #314: the checkpoint gets { project } only and the sweep ctx — surface "sweep", the reindexFn, no lane or persona', async () => {
  const h = harness({ layers: (t) => ({ a: layer(t) }) });
  await h.sweep.runOnce();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].args, { project: 'a' });
  assert.equal(h.calls[0].ctx.surface, 'sweep');
  assert.equal(h.calls[0].ctx.reindexFn, REINDEX);
  assert.equal(h.calls[0].ctx.vaultDir, '/vault');
  assert.ok(!('lane' in h.calls[0].ctx) && !('persona' in h.calls[0].ctx));
});

test('S18 #314: MAX_AGE derives from summaryLagMaxHours — 30 → 24, 5 → 1, blank or junk → the default (24), "0" → 1', async () => {
  const cases = [['30', 24], ['5', 1], ['', 24], ['  ', 24], ['abc', 24], ['0', 1]];
  for (const [raw, maxAge] of cases) {
    const h = harness({
      env: { UM_SUMMARY_LAG_MAX_HOURS: raw },
      layers: (t) => ({ at: layer(t, { idleH: 0, ageH: maxAge }), under: layer(t, { idleH: 0, ageH: maxAge - 0.1 }) }),
    });
    await h.sweep.runOnce();
    assert.deepEqual(h.attempted(), ['at'], `UM_SUMMARY_LAG_MAX_HOURS=${JSON.stringify(raw)} ⇒ MAX_AGE ${maxAge}`);
  }
});

test('S19 #314: every envelope shape maps to exactly one outcome of the closed set', async () => {
  const CLOSED = new Set(['rejected', 'failed', 'contended', 'zero_commit', 'provider_stalled', 'other', 'abstained', 'partial', 'digested']);
  const cases = [
    ['reject', new Error('x'), 'rejected', null],
    ['lock held', CONTENDED, 'contended', null],
    ['state lock', { schema_version: 1, ok: false, error: { code: 'STATE_LOCK_CONTENTION', message: 'x' } }, 'contended', null],
    ['cost cap at start', COST_CAP_START, 'failed', null],
    ['reindex stage', REINDEX_FAILED, 'failed', null],
    ['zero commit', ZERO_COMMIT, 'zero_commit', 'raw_lock'],
    ['provider stall', partial('provider_ratelimit'), 'provider_stalled', 'provider_ratelimit'],
    ['unknown stop', partial('novel'), 'other', 'novel'],
    ['abstention', ABSTAINED, 'abstained', null],
    ['chunk cap', partial('chunk_cap'), 'partial', 'chunk_cap'],
    ['raw lock after a commit', partial('raw_lock'), 'partial', 'raw_lock'],
    ['cost cap mid-run', partial('cost_cap'), 'partial', 'cost_cap'],
    ['digested', DIGESTED, 'digested', null],
  ];
  for (const [label, envelope, outcome, stoppedReason] of cases) {
    const h = harness({ layers: (t) => ({ a: layer(t) }), results: { a: envelope } });
    await h.sweep.runOnce();
    const entry = h.sweep.state().layers.a;
    assert.ok(CLOSED.has(entry.outcome), `${label}: ${entry.outcome} is in the closed set`);
    assert.equal(entry.outcome, outcome, label);
    assert.equal(entry.stopped_reason, stoppedReason, `${label}: stopped_reason`);
  }
});

test('S20 #314: start() warns once when LAG_MAX < 8 (incl. "0"); 30 and "abc" log nothing', () => {
  for (const [raw, n] of [['7', 1], ['0', 1], ['30', 0], ['abc', 0]]) {
    const h = harness({ env: { UM_SUMMARY_LAG_MAX_HOURS: raw }, timers: fakeTimers() });
    h.sweep.start();
    h.sweep.start();
    const warns = h.logs.filter((l) => l.level === 'warn' && /UM_SUMMARY_LAG_MAX_HOURS/.test(l.msg));
    assert.equal(warns.length, n, `UM_SUMMARY_LAG_MAX_HOURS=${JSON.stringify(raw)}`);
  }
});

test('S21 #314: a reindex-stage failure ⇒ "failed" + one sweep_failure row; after 6 h the entry alone makes the layer eligible, and its checkpoint repairs it before any chunk; a later entry and a new instance are picked up', async () => {
  let phase = 'pending';
  const h = harness({
    layers: (t) => ({
      a: phase === 'pending' ? layer(t) : layer(t, { undigested: false, repairH: 1 }),
      late: phase === 'late-entry' ? layer(t, { undigested: false, repairH: 0.5 }) : layer(t, { undigested: false }),
    }),
    results: { a: (n) => (n === 1 ? REINDEX_FAILED : DIGESTED), late: DIGESTED },
  });
  await h.sweep.runOnce();
  assert.equal(h.sweep.state().layers.a.outcome, 'failed');
  assert.deepEqual(h.events, [{ surface: 'sweep', project: 'a', event: 'signal.sweep_failure', outcome: 'reindex_failed' }]);
  phase = 'entry-only';
  h.advance(6 * H);
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['a', 'a'], 'no longer undigested, but its entry makes it eligible once the window has passed');
  phase = 'late-entry';
  h.advance(H);
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['a', 'a', 'late'], 'an entry a client checkpoint left after start() is picked up on the next run');
  const fresh = harness({ layers: (t) => ({ a: layer(t, { undigested: false, repairH: 8 }) }) });
  await fresh.sweep.runOnce();
  assert.deepEqual(fresh.attempted(), ['a'], 'a new instance sees the entry on disk');

  // The repair itself, end to end: real buildLayers + doCheckpoint on a temp vault.
  const vault = tempDir('um-sweep-');
  const project = 'swept';
  const rawDir = path.join(vault, 'captures', project, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  await fs.writeFile(path.join(rawDir, '2026-09-26.md'), `## 2026-09-26T05:00:00.000Z user\n${'x'.repeat(800)}\n\n`);
  const oldId = 'session-2026-09-25-aaaa0001';
  const oldRel = `sessions/${project}/${oldId}.md`;
  await fs.mkdir(path.join(vault, 'sessions', project), { recursive: true });
  await fs.writeFile(path.join(vault, oldRel), `---\ntype: session_summary\nid: ${oldId}\ntitle: t\nproject: ${project}\ncovers_until: 2026-09-25T10:00:00.000Z\n---\nolder summary\n`);
  const old = new Date(Date.now() - 30 * H);
  await fs.utimes(path.join(vault, oldRel), old, old);
  const entryDir = path.join(vault, 'state', project, 'pending-reindex');
  await fs.mkdir(entryDir, { recursive: true });
  await fs.writeFile(path.join(entryDir, `${oldId}.json`), JSON.stringify({ summary_path: oldRel, since: iso(Date.now() - 2 * H) }));
  const reindexed = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const sweep = createIdleSweep({
    buildLayers,
    checkpointFn: doCheckpoint,
    ctx: {
      vaultDir: vault,
      reindexFn: async (rel) => { reindexed.push(rel); },
      config: { schema_version: 1, cost_cap_usd_per_day_per_project: 0.5, summary_model: 'gpt-4o-mini', lockdir_stale_timeout_ms: 600000, min_transcript_bytes: 0, min_transcript_turns: 0 },
      summarizeFn: async () => ({ summary: 'Sweep summary.', costUsd: 0.001, tokensIn: 10, tokensOut: 5 }),
      updateStateFn: async ({ oldStateMd, newSummary }) => ({ schema_version: 1, ok: true, mergedMd: `${oldStateMd}\n\n${newSummary}`, costUsd: 0, tokensIn: 0, tokensOut: 0, llmFailure: false }),
      systemPrompt: 'test prompt',
    },
    isWriteEnabled: () => true,
    env: { UM_SUMMARY_LAG_MAX_HOURS: '30' },
    log: quiet,
    recordEvent: () => {},
  });
  await sweep.runOnce();
  assert.equal(reindexed[0], oldRel, 'the entry is repaired first');
  assert.equal(reindexed.length, 2, 'then the pending chunk is digested and indexed');
  assert.notEqual(reindexed[1], oldRel);
  assert.deepEqual(await fs.readdir(entryDir), [], 'no entry is left');
  assert.deepEqual(sweep.state().layers[project].repair, { done: 1, failed: 0, dropped: 0 });
  await fs.rm(vault, { recursive: true, force: true });
});

test('S22 #314: only a rejected attempt (and a reindex failure, S21) writes signal.sweep_failure; nothing writes signal.checkpoint_failure', async () => {
  const outcomes = {
    rej: new Error('x'), dig: DIGESTED, abs: ABSTAINED, con: CONTENDED,
    fai: FAILED, zer: ZERO_COMMIT, par: partial('chunk_cap'), cap: COST_CAP_START,
  };
  const h = harness({ layers: (t) => Object.fromEntries(Object.keys(outcomes).map((p) => [p, layer(t)])), results: outcomes });
  await h.sweep.runOnce();
  assert.equal(h.calls.length, Object.keys(outcomes).length);
  assert.deepEqual(h.events, [{ surface: 'sweep', project: 'rej', event: 'signal.sweep_failure', outcome: 'rejected' }]);
  assert.ok(!h.events.some((e) => e.event === 'signal.checkpoint_failure'));
});

test('S23 #314: a rate limit ends the run; the layer stays eligible until its third consecutive rate-limited run, then waits 6 h — three or more, and any other outcome resets the streak', async () => {
  const h = harness({ layers: (t) => ({ a: layer(t, { ageH: 50 }), b: layer(t, { ageH: 40 }) }), results: { a: RATELIMIT_START, b: DIGESTED } });
  const countA = () => h.attempted().filter((p) => p === 'a').length;
  await h.sweep.runOnce(); // T0: a rate-limited (1)
  assert.deepEqual(h.attempted(), ['a'], 'the run ends at the rate limit');
  assert.equal(h.sweep.state().layers.b, undefined, 'a layer the run never reached gets no entry');
  h.advance(H);
  await h.sweep.runOnce(); // +1 h: a (2)
  h.advance(H);
  await h.sweep.runOnce(); // +2 h: a (3) → waits until +8 h
  assert.equal(countA(), 3, 'eligible on each of the next two runs');
  h.advance(H);
  await h.sweep.runOnce(); // +3 h: a waiting, b goes (b then waits until +9 h)
  assert.deepEqual(h.attempted(), ['a', 'a', 'a', 'b'], 'the third consecutive rate limit put the layer in a 6 h wait');
  h.advance(5 * H);
  await h.sweep.runOnce(); // +8 h: a (4) → still rate-limited
  assert.equal(countA(), 4);
  h.advance(H);
  await h.sweep.runOnce(); // +9 h: a waiting again, b goes
  assert.equal(countA(), 4, 'a fourth consecutive rate limit keeps it waiting (three or more)');

  const r = harness({
    layers: (t) => ({ r: layer(t) }),
    results: { r: (n) => ([2, 5].includes(n) ? DIGESTED : RATELIMIT_START) },
  });
  await r.sweep.runOnce(); // T0: rate limit (streak 1)
  r.advance(H);
  await r.sweep.runOnce(); // +1 h: digested (streak 0) → waits until +7 h
  r.advance(6 * H);
  await r.sweep.runOnce(); // +7 h: rate limit (1)
  r.advance(H);
  await r.sweep.runOnce(); // +8 h: rate limit (2)
  r.advance(H);
  await r.sweep.runOnce(); // +9 h: still eligible
  assert.equal(r.calls.length, 5, 'rate limit, digested, rate limit, rate limit does not trigger the wait');
});

test('S24 #314: the first run waits DEFAULT_STALE_MS + HEARTBEAT_INTERVAL_MS (both imported), then runs hourly', async () => {
  const { DEFAULT_STALE_MS } = await import('../lib/lockdir.mjs');
  const timers = fakeTimers();
  const h = harness({ timers });
  h.sweep.start();
  assert.equal(typeof DEFAULT_STALE_MS, 'number', 'lockdir.mjs exports DEFAULT_STALE_MS');
  assert.equal(timers.timeouts[0].ms, DEFAULT_STALE_MS + HEARTBEAT_INTERVAL_MS);
  assert.equal(timers.intervals[0].ms, 60 * 60_000);
});

test('S25 #314: an unpriced summarizer model logs one warning at start(); a priced one logs none', () => {
  for (const [summarizer, n] of [[{ provider: 'openai', model: 'no-such-model' }, 1], [{ provider: 'openai', model: 'gpt-4o-mini' }, 0]]) {
    const h = harness({ summarizer, timers: fakeTimers() });
    h.sweep.start();
    h.sweep.start();
    assert.equal(h.logs.filter((l) => l.level === 'warn' && /price/.test(l.msg)).length, n, summarizer.model);
  }
});

test('S26 #314: each sweep.attempt line carries cursor_before and cursor_after from the injected readCursor', async () => {
  let reads = 0;
  const h = harness({
    layers: (t) => ({ a: layer(t) }),
    readCursor: async ({ project, vaultDir }) => {
      assert.equal(project, 'a');
      assert.equal(vaultDir, '/vault');
      reads += 1;
      return { file: '2026-09-28.md', offset: reads === 1 ? 100 : 900, boundary: 'turn', lastTurnIso: null, updatedAt: null };
    },
  });
  await h.sweep.runOnce();
  const line = h.logs.find((l) => l.msg === 'sweep.attempt');
  assert.ok(line, 'one sweep.attempt line');
  assert.equal(line.obj.project, 'a');
  assert.deepEqual(line.obj.cursor_before, { file: '2026-09-28.md', offset: 100 });
  assert.deepEqual(line.obj.cursor_after, { file: '2026-09-28.md', offset: 900 });
  for (const k of ['outcome', 'stopped_reason', 'chunks_done', 'backlog_remaining', 'duration_ms', 'summary_path', 'repairs']) {
    assert.ok(k in line.obj, `sweep.attempt carries ${k}`);
  }
});

test('S27 #314: a non-rate-limit provider failure ends the run and waits 6 h; over three hourly runs the other layers get their turn', async () => {
  const h = harness({
    layers: (t) => ({ a: layer(t, { ageH: 50 }), b: layer(t, { ageH: 40 }), c: layer(t, { ageH: 30 }) }),
    results: { a: PROVIDER_FAIL_START, b: DIGESTED, c: DIGESTED },
  });
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['a'], 'the provider failure ends the run');
  h.advance(H);
  await h.sweep.runOnce();
  h.advance(H);
  await h.sweep.runOnce();
  assert.deepEqual(h.attempted(), ['a', 'b', 'c']);
});

// ---------------------------------------------------------------------------
// T3 (spec §4.2.3, D10): the server's boot hook. UM_SWEEP_ENABLED is opt-out — anything but a
// trimmed 'false' means on, the isAutoSupersedeEnabled convention.
// ---------------------------------------------------------------------------

test('T3 #314: isSweepEnabled — only a trimmed "false" turns the sweep off', () => {
  for (const off of ['false', ' false ', 'false\n']) assert.equal(isSweepEnabled({ UM_SWEEP_ENABLED: off }), false, JSON.stringify(off));
  for (const on of [undefined, '', 'true', '0', 'no', 'FALSE']) assert.equal(isSweepEnabled({ UM_SWEEP_ENABLED: on }), true, JSON.stringify(on));
  assert.equal(isSweepEnabled({}), true, 'unset means on (D13: default on)');
});

function bootDeps(over = {}) {
  const logs = [];
  const log = {
    info: (obj, msg) => { logs.push({ level: 'info', obj, msg }); },
    warn: (obj, msg) => { logs.push({ level: 'warn', obj, msg }); },
    error: (obj, msg) => { logs.push({ level: 'error', obj, msg }); },
  };
  const timers = fakeTimers();
  return {
    logs,
    timers,
    deps: {
      checkpointFn: async () => DIGESTED,
      ctx: { vaultDir: '/vault', reindexFn: REINDEX },
      config: { summary_model: 'gpt-4o-mini' },
      env: {},
      log,
      timers,
      ...over,
    },
  };
}

test('T3 #314: startIdleSweep — off starts nothing; on returns a started sweep with both timers scheduled', () => {
  const off = bootDeps({ env: { UM_SWEEP_ENABLED: 'false' } });
  assert.equal(startIdleSweep(off.deps), null);
  assert.equal(off.timers.timeouts.length + off.timers.intervals.length, 0, 'a disabled sweep schedules nothing');

  const on = bootDeps();
  const sweep = startIdleSweep(on.deps);
  assert.equal(on.timers.timeouts.length, 1);
  assert.equal(on.timers.intervals.length, 1);
  assert.deepEqual(sweep.state(), { enabled: true, last_run_at: null, last_run: null, layers: {} });
});

test('T3 #314: startIdleSweep warns about an unpriced model by the one a sweep checkpoint pays for — checkpoint.json\'s summary_model under the configured provider', () => {
  const priceWarnings = (over) => {
    const b = bootDeps(over);
    startIdleSweep(b.deps);
    return b.logs.filter((l) => l.level === 'warn' && /price/.test(l.msg)).map((l) => l.obj);
  };
  assert.deepEqual(priceWarnings({}), [], 'openai / gpt-4o-mini is priced');
  assert.deepEqual(priceWarnings({ config: { summary_model: 'mystery-model' } }), [{ provider: 'openai', model: 'mystery-model' }]);
  assert.deepEqual(priceWarnings({ env: { UM_SUMMARIZER_PROVIDER: 'anthropic' } }), [{ provider: 'anthropic', model: 'gpt-4o-mini' }],
    'the chunk transaction passes summary_model as the model, whatever the provider');
  assert.deepEqual(priceWarnings({ env: { UM_SUMMARIZER: 'claude-agent-sdk' } }), [], 'the agent-sdk backend falls back to openai server-side');
});
