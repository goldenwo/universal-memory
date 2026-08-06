// server/test/mq-eval-decay-param.test.mjs — decay as a hermetic RUN PARAMETER.
//
// Why this exists: `runOnce` and `runCorpusSweep` used to hardcode
// `process.env.UM_TEMPORAL_DECAY = 'false'` and then record the LITERAL 'false' in
// `flags`. That hardcode was simultaneously a defect (the undated-arm measurement needs
// decay ON) and the eval's ONLY normalisation of an ambient read-path flag. So it could
// not simply be deleted — it had to become a parameter that still normalises.
//
// Three properties are load-bearing and each is asserted below:
//   1. NORMALISATION survives — an ambient/garbage value never enables decay.
//   2. TRUTHFULNESS — the value RECORDED in `flags` is the value WRITTEN to the env.
//      A run whose flags say 'false' while it executed under 'true' is worse than no
//      record at all, because downstream comparisons trust `flags`.
//   3. The variable is CLEARED afterwards, including on the throw path, so a second run
//      in the same process cannot inherit the first run's setting.
//
// Importing the module stays fully offline: the live deps are lazy-imported inside the
// run functions (the harness's no-live-calls contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  resolveDecayFlag,
  withDecayEnv,
  evalRunFlags,
} from '../eval/memory-quality-eval.mjs';

// Keep the suite hermetic regardless of the ambient environment.
function withAmbient(value, fn) {
  const prior = process.env.UM_TEMPORAL_DECAY;
  if (value === undefined) delete process.env.UM_TEMPORAL_DECAY;
  else process.env.UM_TEMPORAL_DECAY = value;
  try { return fn(); }
  finally {
    if (prior === undefined) delete process.env.UM_TEMPORAL_DECAY;
    else process.env.UM_TEMPORAL_DECAY = prior;
  }
}

// --- resolveDecayFlag: the whole truth table -------------------------------

test('resolveDecayFlag: ONLY boolean true and the exact string "true" enable decay', () => {
  assert.equal(resolveDecayFlag(true), 'true');
  assert.equal(resolveDecayFlag('true'), 'true');
});

test('resolveDecayFlag: everything else normalises to "false" (the preserved hermeticity guard)', () => {
  for (const v of [undefined, null, false, 'false', 'TRUE', 'True', 'yes', 'on', 1, 0, '', '1', {}, []]) {
    assert.equal(resolveDecayFlag(v), 'false', `expected 'false' for ${JSON.stringify(v)}`);
  }
});

test('resolveDecayFlag: always returns a string, never a boolean (env values are strings)', () => {
  for (const v of [true, false, undefined, 'true']) {
    assert.equal(typeof resolveDecayFlag(v), 'string');
  }
});

// --- withDecayEnv: writes, hands back the same value, then clears ----------

test('withDecayEnv: WRITES the resolved value into process.env for the duration of fn', async () => {
  await withAmbient(undefined, async () => {
    let seen;
    await withDecayEnv(true, async () => { seen = process.env.UM_TEMPORAL_DECAY; });
    assert.equal(seen, 'true');

    await withDecayEnv(false, async () => { seen = process.env.UM_TEMPORAL_DECAY; });
    assert.equal(seen, 'false');
  });
});

test('withDecayEnv: TRUTHFULNESS — the value passed to fn is exactly what is in process.env', async () => {
  await withAmbient(undefined, async () => {
    for (const input of [true, 'true', false, undefined, 'TRUE', 1]) {
      let passed, inEnv;
      await withDecayEnv(input, async (resolved) => {
        passed = resolved;
        inEnv = process.env.UM_TEMPORAL_DECAY;
      });
      assert.equal(passed, inEnv, `fn arg and env diverged for ${JSON.stringify(input)}`);
      assert.equal(passed, resolveDecayFlag(input));
    }
  });
});

test('withDecayEnv: normalises an AMBIENT true away when the run did not ask for decay', async () => {
  // The hazard the old hardcode existed to prevent: a caller's `.env` or shell exporting
  // UM_TEMPORAL_DECAY=true must not silently turn decay on for a default run.
  await withAmbient('true', async () => {
    let seen;
    await withDecayEnv(undefined, async () => { seen = process.env.UM_TEMPORAL_DECAY; });
    assert.equal(seen, 'false');
  });
});

test('withDecayEnv: CLEARS the variable after a normal return', async () => {
  await withAmbient(undefined, async () => {
    await withDecayEnv(true, async () => {});
    assert.equal(process.env.UM_TEMPORAL_DECAY, undefined);
    assert.ok(!('UM_TEMPORAL_DECAY' in process.env), 'key must be deleted, not set to a string');
  });
});

test('withDecayEnv: CLEARS the variable even when fn THROWS, and rethrows', async () => {
  await withAmbient(undefined, async () => {
    await assert.rejects(
      () => withDecayEnv(true, async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(process.env.UM_TEMPORAL_DECAY, undefined);
    assert.ok(!('UM_TEMPORAL_DECAY' in process.env));
  });
});

test('withDecayEnv: a second run does not inherit the first run\'s setting', async () => {
  await withAmbient(undefined, async () => {
    await withDecayEnv(true, async () => {});
    let seen;
    await withDecayEnv(undefined, async () => { seen = process.env.UM_TEMPORAL_DECAY; });
    assert.equal(seen, 'false', 'decay leaked from the previous run');
  });
});

test('withDecayEnv: returns fn\'s value', async () => {
  await withAmbient(undefined, async () => {
    assert.equal(await withDecayEnv(false, async () => 42), 42);
  });
});

// --- evalRunFlags: what gets RECORDED --------------------------------------

test('evalRunFlags: UM_TEMPORAL_DECAY is exactly what resolveDecayFlag returns', () => {
  for (const v of [true, 'true', false, undefined, 'TRUE', 1, null]) {
    assert.equal(evalRunFlags({ decay: v }).UM_TEMPORAL_DECAY, resolveDecayFlag(v));
  }
});

test('evalRunFlags: the RECORDED value equals the value withDecayEnv WRITES', async () => {
  await withAmbient(undefined, async () => {
    for (const v of [true, false, undefined, 'true']) {
      let written;
      await withDecayEnv(v, async () => { written = process.env.UM_TEMPORAL_DECAY; });
      assert.equal(evalRunFlags({ decay: v }).UM_TEMPORAL_DECAY, written);
    }
  });
});

test('evalRunFlags: autosupersede defaults to "true" and is overridable for the sweep', () => {
  assert.equal(evalRunFlags({ decay: false }).UM_AUTOSUPERSEDE_ENABLED, 'true');
  assert.equal(evalRunFlags({ decay: false, autosupersede: 'false' }).UM_AUTOSUPERSEDE_ENABLED, 'false');
});

test('evalRunFlags: the other three flags keep their pinned values', () => {
  const f = evalRunFlags({ decay: true });
  assert.equal(f.UM_DEDUP_ENABLED, 'true');
  assert.equal(f.UM_LANE_CLASSIFIER_ENABLED, 'true');
  // Literal ORDER, not sorted: key order is part of the emitted artifact bytes, and
  // "default behaviour byte-identical to today" is a requirement of this change.
  assert.deepEqual(Object.keys(f), [
    'UM_DEDUP_ENABLED', 'UM_AUTOSUPERSEDE_ENABLED', 'UM_LANE_CLASSIFIER_ENABLED', 'UM_TEMPORAL_DECAY',
  ]);
});

// --- source introspection: proves BOTH call sites were rewired -------------
//
// The helper tests above pass even if the helpers were added alongside the untouched
// hardcodes. These assertions are what actually pin the rewiring of runOnce AND
// runCorpusSweep (two separate functions). House pattern: memory-quality-eval.test.mjs:512.

const SRC = readFileSync(new URL('../eval/memory-quality-eval.mjs', import.meta.url), 'utf8');

// Strip block comments and whole-line `//` comments: the negative assertions below must
// describe CODE, not prose. Without this, documenting the flags block in a doc comment
// would red the suite, and the failure message would be actively misleading.
// Trailing `//` comments are stripped too — that is the most likely place someone writes
// prose ABOUT the removed hardcode, and a whole-line-only strip left it uncovered.
// `(^|\s)` keeps `http://…` inside string literals intact (its `//` follows a colon).
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

test('§decay: no hardcoded literal env assignment survives (quote/spacing tolerant)', () => {
  assert.doesNotMatch(
    CODE,
    /process\.env\.UM_TEMPORAL_DECAY\s*=\s*['"](?:true|false)['"]/,
    'the hardcoded decay pin must be replaced by the run parameter',
  );
});

test('§decay: no flags object records a LITERAL decay value', () => {
  // A literal here is how `flags` silently stops describing the run it belongs to.
  assert.doesNotMatch(
    CODE,
    /UM_TEMPORAL_DECAY:\s*['"](?:true|false)['"]/,
    'flags must derive UM_TEMPORAL_DECAY from resolveDecayFlag, never a literal',
  );
});

// The two assertions below are ANCHORED PER FUNCTION on purpose. A file-wide occurrence
// count cannot tell WHICH function was wrapped nor WHERE the wrap sits — an independent
// review demonstrated that unwrapping runCorpusSweep (plus any decoy third use), or
// inserting an env-capturing `await import(...)` ahead of the wrap, both survived a
// count-based guard. Anchoring the wrap as the FIRST statement of the exported function
// pins identity AND the ordering the file's own "review B1 / G2" comment depends on:
// the pin must precede the lazy imports, which capture env at import time.
// Neither run function is executable offline (both hit mem0ai + a live qdrant), so these
// source assertions are the only available guard on the wiring.

// The regexes also require the callback to RECEIVE the resolved value and pass it down as
// `decay`. Without that clause the inner frame re-derives the flag from its own default,
// giving two independent derivations that agree only by coincidence — a one-token change
// to the inner default then makes `flags` describe a configuration the run never used,
// while every test stays green and the gate stays green.

test('§decay: runOnce wraps its body in withDecayEnv as its FIRST statement, passing the resolved value down', () => {
  assert.match(
    CODE,
    /export async function runOnce\(\s*args\s*=\s*\{\}\s*\)\s*\{\s*return withDecayEnv\(\s*args\.decay\s*,\s*\(\s*resolved\s*\)\s*=>\s*runOnceDecayPinned\(\s*\{\s*\.\.\.args\s*,\s*decay:\s*resolved\s*\}\s*\)\s*\)\s*;?\s*\}/,
    'runOnce must delegate straight into withDecayEnv and forward the RESOLVED value — nothing may run (or import) before the pin, and the inner frame must not re-derive the flag',
  );
});

test('§decay: runCorpusSweep wraps its body in withDecayEnv as its FIRST statement, passing the resolved value down', () => {
  assert.match(
    CODE,
    /export async function runCorpusSweep\(\s*args\s*=\s*\{\}\s*\)\s*\{\s*return withDecayEnv\(\s*args\.decay\s*,\s*\(\s*resolved\s*\)\s*=>\s*runCorpusSweepDecayPinned\(\s*\{\s*\.\.\.args\s*,\s*decay:\s*resolved\s*\}\s*\)\s*\)\s*;?\s*\}/,
    'runCorpusSweep is a SEPARATE function and needs the same pin and the same forwarding',
  );
});

test('§decay: neither inner frame re-derives decay from its own default', () => {
  // A `decay = <anything>` default on the pinned inner functions is a SECOND source of
  // truth for the flag that lands in `flags`. There must be exactly one.
  assert.doesNotMatch(
    CODE,
    /async function run(?:Once|CorpusSweep)DecayPinned\([^)]*decay\s*=/,
    'the inner run functions must take decay from the wrapper, never default it',
  );
});

// Split the source at the sweep's declaration so each `flags:` assertion is scoped to the
// function it describes. A file-wide match cannot tell WHICH function it matched: with
// two unscoped assertions, SWAPPING the call sites (runOnce recording the sweep's form and
// vice versa) leaves both regexes satisfied and the suite green, while both functions then
// record a value the run never executed under.
const SWEEP_AT = CODE.indexOf('async function runCorpusSweepDecayPinned');
const RUNONCE_HALF = CODE.slice(0, SWEEP_AT);
const SWEEP_HALF = CODE.slice(SWEEP_AT);

test('§decay: the source splits cleanly into the two run-function halves', () => {
  // Guards the two assertions below from silently degrading into whole-file matches.
  assert.ok(SWEEP_AT > 0, 'runCorpusSweepDecayPinned not found — the split below is meaningless');
  assert.ok(RUNONCE_HALF.includes('async function runOnceDecayPinned'));
});

test('§decay: runOnce records autosupersede ON — in runOnce\'s own half of the file', () => {
  // Without this, mutating runOnce's call site to autosupersede:'false' left the whole
  // suite green while the run wrote 'true' to the env and recorded 'false' in the
  // artifact of record — exactly the truthfulness property this file exists to protect.
  assert.match(RUNONCE_HALF, /flags:\s*evalRunFlags\(\{\s*decay\s*\}\)/);
  assert.doesNotMatch(RUNONCE_HALF, /flags:\s*evalRunFlags\(\{\s*decay,\s*autosupersede:/);
});

test('§decay: runCorpusSweep records autosupersede OFF — in the sweep\'s own half', () => {
  assert.match(SWEEP_HALF, /flags:\s*evalRunFlags\(\{\s*decay,\s*autosupersede:\s*'false'\s*\}\)/);
  assert.doesNotMatch(SWEEP_HALF, /flags:\s*evalRunFlags\(\{\s*decay\s*\}\)/);
});

// --- documented hazard: withDecayEnv is not re-entrant ---------------------

test('withDecayEnv: nesting CLEARS the outer pin — pinned so the trap stays known', async () => {
  // delete-not-restore is the specified semantics, so this is documented, not fixed.
  // A two-arm harness must pass `decay` into each run call rather than wrapping a group.
  await withAmbient(undefined, async () => {
    let afterInner;
    await withDecayEnv(true, async () => {
      await withDecayEnv(true, async () => {});
      afterInner = process.env.UM_TEMPORAL_DECAY;
    });
    assert.equal(afterInner, undefined, 'nesting silently drops the outer pin — do not nest');
  });
});

test('withDecayEnv: CONCURRENT calls corrupt each other — pinned so the trap stays known', async () => {
  // process.env is process-global. The two-arm harness this parameter exists for MUST run
  // its arms sequentially; Promise.all is the shape someone will reach for first.
  await withAmbient(undefined, async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let seenByFirst;

    const first = withDecayEnv(true, async () => {
      await gate;                                   // still "inside" arm A
      seenByFirst = process.env.UM_TEMPORAL_DECAY;  // but arm B has already pinned it
    });
    const second = withDecayEnv(false, async () => {});
    await second;
    release();
    await first;

    // Arm A asked for 'true' and observed something else: B's pin, then B's delete.
    assert.notEqual(seenByFirst, 'true', 'concurrent arms must be shown to interfere — run them sequentially');
  });
});

test('evalRunFlags: callable with no argument (house convention for options objects)', () => {
  assert.equal(evalRunFlags().UM_TEMPORAL_DECAY, 'false');
  assert.equal(evalRunFlags().UM_AUTOSUPERSEDE_ENABLED, 'true');
});
