// server/test/decay-env.test.mjs — #297 T3 (spec D25): lib/decay-env.mjs is the ONE owner of
// the two decay env reads, so doSearch and buildStats can never disagree on H or on the flag.
//
// resolveHalfLifeDays() = `raw = Number(env)`, then `Number.isFinite(raw) && raw > 0 ? raw : 30`
// — `Number`, not `parseInt`: '1e3' → 1000 (spec §4.2 step 4 / F13.6), and a negative or zero H
// can never survive to `exp(-A_q/H)` (D18's hazard: `parseInt('-5') || 30` let −5 through and
// `exp(-28.7/-5)` clamped to exactly 1.0).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHalfLifeDays, isDecayEnabled, DEFAULT_HALF_LIFE_DAYS } from '../lib/decay-env.mjs';

async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('resolveHalfLifeDays: the pinned cases — "", "abc", "0", "-5", "1e3", unset → 30/30/30/30/1000/30', async () => {
  const cases = [['', 30], ['abc', 30], ['0', 30], ['-5', 30], ['1e3', 1000], [undefined, 30], ['30', 30], ['7.5', 7.5], ['Infinity', 30], ['  ', 30]];
  for (const [raw, expected] of cases) {
    await withEnv({ UM_DECAY_HALF_LIFE_DAYS: raw }, () => {
      assert.equal(resolveHalfLifeDays(), expected, `UM_DECAY_HALF_LIFE_DAYS=${JSON.stringify(raw)}`);
    });
  }
  assert.equal(DEFAULT_HALF_LIFE_DAYS, 30);
});

test('isDecayEnabled: exactly the string "true" enables; everything else is off', async () => {
  for (const [raw, expected] of [['true', true], ['TRUE', false], ['1', false], ['false', false], ['', false], [undefined, false]]) {
    await withEnv({ UM_TEMPORAL_DECAY: raw }, () => {
      assert.equal(isDecayEnabled(), expected, `UM_TEMPORAL_DECAY=${JSON.stringify(raw)}`);
    });
  }
});
