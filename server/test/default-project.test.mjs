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
  PROJECT_SLUG_RE,
  TOOL_IDS,
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

// ── Exports: PROJECT_SLUG_RE + TOOL_IDS (v1.1 F1 hygiene PR) ──────────────

test('PROJECT_SLUG_RE: canonical pattern matches valid slugs', () => {
  // Sanity-anchor on the exact pattern. If anyone retunes the regex they
  // also have to retune this test, which catches accidental drift.
  assert.equal(PROJECT_SLUG_RE.source, '^[a-zA-Z0-9._-]+$');
  for (const ok of ['default', 'my-project', 'proj.v1_2', 'a1', 'A.b-C_d', '.hidden']) {
    assert.ok(PROJECT_SLUG_RE.test(ok), `expected match: ${ok}`);
  }
  // Defense-in-depth lockdown: these inputs currently MATCH the regex
  // (the char class permits `.` `-` `_` in any position). Path traversal
  // (`..`) is matched here but rejected at the filesystem layer by
  // `vault.mjs:safePath()` — that's the existing security model.
  // Asserting the current behavior so a future regex tightening (e.g.
  // adding an anti-traversal lookahead) becomes a tracked decision rather
  // than silently shifting the matched set.
  for (const lockedMatch of ['.', '..', '...', '-', '_', '-leading-dash', '_lead_under']) {
    assert.ok(PROJECT_SLUG_RE.test(lockedMatch),
      `defense-in-depth lockdown: ${JSON.stringify(lockedMatch)} currently matches ` +
      `(vault safePath is the backstop). If you intentionally tightened the regex, ` +
      `update this assertion AND verify the FS-layer guard still covers traversal.`);
  }
  // Hostile-input coverage. The regex's `^...$` anchors prevent multi-line
  // bypass (a string like "good\nbad" won't match because the newline isn't
  // in the char class). NUL bytes, whitespace, Unicode, path separators,
  // and grouping characters all fail. Asserting these explicitly so a
  // future regex tightening doesn't silently change behavior.
  for (const bad of [
    '',                  // empty
    '../escape',         // path traversal
    'my project',        // whitespace
    'with/slash',        // path separator
    'curly{brace}',      // shell-substitution chars
    'a\0b',              // NUL byte
    'café',              // non-ASCII Unicode
    'good\nbad',         // multi-line — anchors prevent bypass
    'good\rbad',         // CR
    'tab\there',         // embedded tab
    ' lead',             // leading space
    'trail ',            // trailing space
  ]) {
    assert.ok(!PROJECT_SLUG_RE.test(bad), `expected no match: ${JSON.stringify(bad)}`);
  }
});

test('TOOL_IDS: enumerates the five canonical call sites and is frozen', () => {
  assert.equal(TOOL_IDS.MEMORY_CAPTURE, 'memory_capture');
  assert.equal(TOOL_IDS.MEMORY_ADD, 'memory_add');
  assert.equal(TOOL_IDS.MEMORY_APPEND_TURN, 'memory_append_turn');
  assert.equal(TOOL_IDS.MEMORY_CHECKPOINT, 'memory_checkpoint');
  assert.equal(TOOL_IDS.API_ADD, 'api_add');
  assert.ok(Object.isFrozen(TOOL_IDS), 'TOOL_IDS must be frozen to catch typos at write-time');
  // ESM modules run in strict mode → write to a frozen object throws
  // TypeError. Confirm at runtime so a future Object.freeze removal would
  // be caught immediately, not just by the isFrozen() static check.
  assert.throws(
    () => { TOOL_IDS.MEMORY_ADD = 'mutated'; },
    TypeError,
    'mutating a frozen TOOL_IDS entry must throw under ESM strict mode',
  );
  assert.throws(
    () => { TOOL_IDS.NEW_TOOL = 'added'; },
    TypeError,
    'adding a new key to a frozen TOOL_IDS must throw under ESM strict mode',
  );
});

test('applyDefaultProject: accepts arbitrary tool strings (no TOOL_IDS-membership check)', () => {
  // TOOL_IDS is documentation + typo-safety on the CALL site, not validation
  // inside the helper. A future caller using a literal (e.g. internal CLI
  // path) must still work — the helper's `tool` arg is forwarded verbatim
  // to the warn log binding.
  withEnv(undefined, () => {
    const logger = makeRecordingLogger();
    const got = applyDefaultProject({
      project: undefined,
      tool: 'some_future_caller',
      logger,
    });
    assert.equal(got, 'default');
    assert.equal(logger.calls[0][0].tool, 'some_future_caller');
  });
});

test('umDefaultProject: returned value always matches PROJECT_SLUG_RE (invariant)', () => {
  // Documented invariant in the helper JSDoc — exercise it on a sample of
  // unset / valid / invalid envs.
  for (const envValue of [undefined, '', 'valid', 'totally bad!', '../escape']) {
    withEnv(envValue, () => {
      const got = umDefaultProject();
      assert.ok(PROJECT_SLUG_RE.test(got),
        `umDefaultProject() returned ${JSON.stringify(got)} for env=${JSON.stringify(envValue)} — violates slug invariant`);
    });
  }
});
