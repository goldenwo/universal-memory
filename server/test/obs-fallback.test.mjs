// server/test/obs-fallback.test.mjs
// C.9 — observability-never-500s rate-limited stderr fallback (spec §4.2.0).
//
// Pins three contracts:
//   1. obsFallback writes to stderr on first call and includes context + err.message.
//   2. Subsequent calls within the rate-limit window are dropped (no flood).
//   3. When the window reopens, the next emit surfaces the dropped count
//      so ops can gauge severity of a sustained underlying failure.
//
// Mocking strategy: the module exports `_setNowForTest(fn)` so we can
// drive the time-window without sleeping or mutating Date globally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  obsFallback,
  safeLog,
  _resetForTest,
  _setNowForTest,
} from '../lib/obs-fallback.mjs';

function captureStderr() {
  const captured = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  return {
    captured,
    restore: () => { process.stderr.write = orig; },
  };
}

test('obsFallback emits to stderr on first call with context + err.message', () => {
  _resetForTest();
  const { captured, restore } = captureStderr();
  try {
    obsFallback(new Error('test fail'), 'metrics:emit');
  } finally {
    restore();
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0], /\[obs-fallback\]/);
  assert.match(captured[0], /test fail/);
  assert.match(captured[0], /metrics:emit/);
  // Trailing newline so ops's tail/journal sees one record per emit.
  assert.match(captured[0], /\n$/);
});

test('obsFallback rate-limits — second call within 60s does NOT emit', () => {
  _resetForTest();
  const { captured, restore } = captureStderr();
  try {
    obsFallback(new Error('e1'), 'ctx1');
    obsFallback(new Error('e2'), 'ctx2');
    obsFallback(new Error('e3'), 'ctx3');
  } finally {
    restore();
  }
  // Only the first emit is written; the next two are silently dropped.
  assert.equal(captured.length, 1);
  assert.match(captured[0], /e1/);
  assert.doesNotMatch(captured[0], /e2|e3/);
});

test('obsFallback re-opens window after 60s and surfaces dropped count', () => {
  _resetForTest();
  let now = 1_000_000;
  _setNowForTest(() => now);
  const { captured, restore } = captureStderr();
  try {
    // First call at t=0 → emits, count=0 dropped before this one.
    obsFallback(new Error('first'), 'ctx');
    // Drop 5 within window
    for (let i = 0; i < 5; i++) {
      obsFallback(new Error(`drop${i}`), 'ctx');
    }
    // Advance past 60s window
    now += 60_000;
    // This emit should fire AND surface that 5 were dropped while window was closed.
    obsFallback(new Error('second'), 'ctx');
  } finally {
    restore();
    _setNowForTest(null);
  }
  assert.equal(captured.length, 2);
  assert.match(captured[0], /first/);
  assert.match(captured[1], /second/);
  assert.match(captured[1], /5 dropped/);
});

test('obsFallback never throws even when err is null/undefined', () => {
  _resetForTest();
  const { restore } = captureStderr();
  try {
    // Must not throw — the WHOLE point is that observability is in the no-throw path.
    assert.doesNotThrow(() => obsFallback(null, 'ctx-a'));
    _resetForTest();
    assert.doesNotThrow(() => obsFallback(undefined, 'ctx-b'));
    _resetForTest();
    assert.doesNotThrow(() => obsFallback(new Error('m')));  // no context
    _resetForTest();
    assert.doesNotThrow(() => obsFallback('string-error', 'ctx-c'));  // non-Error throw
  } finally {
    restore();
  }
});

test('safeLog runs the closure and returns silently on success', () => {
  _resetForTest();
  const { captured, restore } = captureStderr();
  let called = false;
  try {
    safeLog(() => { called = true; }, 'ctx');
  } finally {
    restore();
  }
  assert.equal(called, true);
  assert.equal(captured.length, 0);  // no fallback emit on success
});

test('safeLog routes a thrown error to obsFallback (no recursion through logger)', () => {
  _resetForTest();
  const { captured, restore } = captureStderr();
  try {
    safeLog(() => { throw new Error('pino exploded'); }, 'log:request');
  } finally {
    restore();
  }
  // The closure threw, but safeLog did NOT — the request path continues.
  assert.equal(captured.length, 1);
  assert.match(captured[0], /pino exploded/);
  assert.match(captured[0], /log:request/);
});

test('safeLog never throws even if the closure throws synchronously', () => {
  _resetForTest();
  const { restore } = captureStderr();
  try {
    assert.doesNotThrow(() => safeLog(() => { throw new Error('boom'); }, 'ctx'));
  } finally {
    restore();
  }
});

test('obsFallback survives stderr.write itself throwing (last-resort safety)', () => {
  _resetForTest();
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => { throw new Error('stderr broken too'); };
  try {
    // The whole point: even if the fallback fallback fails, the request path
    // must not see the exception. Swallow at the very last layer.
    assert.doesNotThrow(() => obsFallback(new Error('oops'), 'ctx'));
  } finally {
    process.stderr.write = orig;
  }
});
