// server/test/default-project.test.mjs — v1.1 F1 unification helper tests.
//
// Covers the policy at server/lib/default-project.mjs: how falsy /
// wrong-type / regex-mismatch project values are translated into either
// (a) the soft-default slug (with observability warn), or (b) a null
// sentinel that signals the caller to hard-fail.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  umDefaultProject,
  applyDefaultProject,
  _resetInvalidEnvWarnForTests,
} from '../lib/default-project.mjs';

// Each test runs an isolated env mutation; this helper snapshots+restores
// process.env.UM_DEFAULT_PROJECT so parallel tests do not contaminate.
function withEnv(value, fn) {
  const prev = process.env.UM_DEFAULT_PROJECT;
  if (value === undefined) delete process.env.UM_DEFAULT_PROJECT;
  else process.env.UM_DEFAULT_PROJECT = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.UM_DEFAULT_PROJECT;
    else process.env.UM_DEFAULT_PROJECT = prev;
  }
}

// Minimal pino-shaped logger that records calls. The helper only uses
// .warn(); other levels are not exercised here.
function makeRecordingLogger() {
  const calls = [];
  return {
    calls,
    warn: (...args) => { calls.push(args); },
  };
}

// ── umDefaultProject ───────────────────────────────────────────────────

test('umDefaultProject: unset env returns "default"', () => {
  withEnv(undefined, () => {
    assert.equal(umDefaultProject(), 'default');
  });
});

test('umDefaultProject: empty env returns "default"', () => {
  withEnv('', () => {
    assert.equal(umDefaultProject(), 'default');
  });
});

test('umDefaultProject: valid slug env returns that slug', () => {
  withEnv('my-shared-project', () => {
    assert.equal(umDefaultProject(), 'my-shared-project');
  });
});

test('umDefaultProject: slug with dots / underscores / digits is accepted', () => {
  withEnv('proj.v1_2-alpha9', () => {
    assert.equal(umDefaultProject(), 'proj.v1_2-alpha9');
  });
});

test('umDefaultProject: invalid env (contains /) falls back to "default"', () => {
  withEnv('../escape', () => {
    assert.equal(umDefaultProject(), 'default');
  });
});

test('umDefaultProject: invalid env (contains space) falls back to "default"', () => {
  withEnv('my project', () => {
    assert.equal(umDefaultProject(), 'default');
  });
});

test('umDefaultProject: invalid env emits a one-shot warn via supplied logger', () => {
  // Reset the module-level one-shot flag so this test deterministically
  // observes the warn regardless of which other tests ran before it. The
  // pre-follow-up version of this test degraded to BEHAVIOR_OR_NOOP because
  // it could not reset the flag — post-merge review of PR #78 flagged that
  // hazard, and PR #79 added _resetInvalidEnvWarnForTests().
  _resetInvalidEnvWarnForTests();
  withEnv('bad slug!', () => {
    const logger = makeRecordingLogger();
    const got = umDefaultProject({ logger });
    assert.equal(got, 'default');
    assert.equal(logger.calls.length, 1, 'first call MUST emit the one-shot warn');
    const [bindings, msg] = logger.calls[0];
    assert.equal(bindings.um_default_project_env, 'bad slug!');
    assert.match(msg, /UM_DEFAULT_PROJECT/);

    // Second call with the same bad env should NOT re-warn (one-shot contract).
    const logger2 = makeRecordingLogger();
    umDefaultProject({ logger: logger2 });
    assert.equal(logger2.calls.length, 0, 'one-shot flag suppresses repeat warns until reset');
  });
});

test('umDefaultProject: omitting logger does not throw on invalid env', () => {
  withEnv('still bad!', () => {
    // Helper must not assume a logger is supplied (unit-test callers, etc.).
    assert.doesNotThrow(() => umDefaultProject());
    assert.equal(umDefaultProject(), 'default');
  });
});

// ── applyDefaultProject — falsy arm (soft-default) ─────────────────────

test('applyDefaultProject: undefined project → soft-default + warn', () => {
  withEnv(undefined, () => {
    const logger = makeRecordingLogger();
    const got = applyDefaultProject({
      project: undefined,
      tool: 'memory_add',
      logger,
      requestId: 'req-abc',
    });
    assert.equal(got, 'default');
    assert.equal(logger.calls.length, 1, 'one warn for the soft-default');
    const [bindings, msg] = logger.calls[0];
    assert.equal(bindings.tool, 'memory_add');
    assert.equal(bindings.request_id, 'req-abc');
    assert.equal(bindings.project_effective, 'default');
    assert.equal(bindings.reason, 'caller_omitted_project');
    assert.match(msg, /caller omitted project/);
  });
});

test('applyDefaultProject: null project → soft-default', () => {
  withEnv(undefined, () => {
    const got = applyDefaultProject({ project: null, tool: 'memory_capture' });
    assert.equal(got, 'default');
  });
});

test('applyDefaultProject: empty string → soft-default', () => {
  withEnv(undefined, () => {
    const got = applyDefaultProject({ project: '', tool: 'memory_capture' });
    assert.equal(got, 'default');
  });
});

test('applyDefaultProject: falsy project honors UM_DEFAULT_PROJECT env', () => {
  withEnv('shared-fallback', () => {
    const got = applyDefaultProject({ project: undefined, tool: 'memory_add' });
    assert.equal(got, 'shared-fallback');
  });
});

test('applyDefaultProject: no logger provided → no throw (warn suppressed)', () => {
  withEnv(undefined, () => {
    assert.doesNotThrow(() =>
      applyDefaultProject({ project: undefined, tool: 'memory_capture' }),
    );
  });
});

// ── applyDefaultProject — pass-through arm ─────────────────────────────

test('applyDefaultProject: valid slug returned unchanged', () => {
  withEnv(undefined, () => {
    const got = applyDefaultProject({ project: 'real-project', tool: 'memory_add' });
    assert.equal(got, 'real-project');
  });
});

test('applyDefaultProject: valid slug ignores UM_DEFAULT_PROJECT env', () => {
  withEnv('would-be-fallback', () => {
    const got = applyDefaultProject({ project: 'caller-supplied', tool: 'memory_add' });
    assert.equal(got, 'caller-supplied');
  });
});

test('applyDefaultProject: valid slug does NOT emit a warn', () => {
  withEnv(undefined, () => {
    const logger = makeRecordingLogger();
    applyDefaultProject({
      project: 'present-project',
      tool: 'memory_capture',
      logger,
    });
    assert.equal(logger.calls.length, 0, 'no warn when caller passes a valid slug');
  });
});

// ── applyDefaultProject — hard-fail arm ────────────────────────────────

test('applyDefaultProject: number project → null (caller hard-fails)', () => {
  const got = applyDefaultProject({ project: 42, tool: 'memory_append_turn' });
  assert.equal(got, null);
});

test('applyDefaultProject: object project → null', () => {
  const got = applyDefaultProject({ project: { name: 'x' }, tool: 'memory_append_turn' });
  assert.equal(got, null);
});

test('applyDefaultProject: invalid slug string (path traversal) → null', () => {
  const got = applyDefaultProject({ project: '../escape', tool: 'memory_checkpoint' });
  assert.equal(got, null);
});

test('applyDefaultProject: invalid slug string (whitespace) → null', () => {
  const got = applyDefaultProject({ project: 'a b', tool: 'memory_checkpoint' });
  assert.equal(got, null);
});

test('applyDefaultProject: invalid value does NOT emit a soft-default warn', () => {
  const logger = makeRecordingLogger();
  applyDefaultProject({
    project: '../bad',
    tool: 'memory_append_turn',
    logger,
  });
  // The hard-fail path does not log a warn — the caller emits its own
  // error envelope. Avoids double-logging on a single bad write.
  assert.equal(logger.calls.length, 0);
});
