// server/test/checked-knobs.test.mjs — the knobs whose silent fallback would do harm
// (lib/checked-knobs.mjs). Readers read them with checkedKnob(); boot validates them with
// requireCheckedKnob() over the same table, so whatever boot accepts, the reader honours.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKED_KNOBS, checkedKnob, requireCheckedKnob } from '../lib/checked-knobs.mjs';

const CORPUS = ['', ' ', '0', '-1', '1', '1.5', '7.5', '5x', '512k', '1e3', '1e400', '6335',
  '65536', '9007199254740993', '127.0.0.1:6337', '"120"', 'abc'];

test('checkedKnob: unset or blank is the fallback', () => {
  for (const [name, { fallback }] of Object.entries(CHECKED_KNOBS)) {
    assert.equal(checkedKnob(name, {}), fallback, name);
    assert.equal(checkedKnob(name, { [name]: '  ' }), fallback, name);
  }
});

test('requireCheckedKnob: a set-but-malformed value throws, naming the variable and the value', () => {
  assert.throws(() => requireCheckedKnob('UM_RATE_LIMIT_RPM', { UM_RATE_LIMIT_RPM: '512k' }),
    /UM_RATE_LIMIT_RPM must be .*got "512k"/);
  assert.throws(() => requireCheckedKnob('UM_CAPTURE_LEDGER_RETENTION_DAYS', { UM_CAPTURE_LEDGER_RETENTION_DAYS: '400d' }),
    /UM_CAPTURE_LEDGER_RETENTION_DAYS must be .*got "400d"/);
  assert.equal(requireCheckedKnob('UM_CAPTURE_LEDGER_RETENTION_DAYS', { UM_CAPTURE_LEDGER_RETENTION_DAYS: '400' }), 400);
});

// Parity: for every knob and every value, boot either refuses it or the reader honours
// exactly what boot accepted; a non-blank value the reader would ignore never boots.
test('parity: what requireCheckedKnob accepts is what checkedKnob reads, for every knob', () => {
  for (const name of Object.keys(CHECKED_KNOBS)) {
    for (const raw of CORPUS) {
      const env = { [name]: raw };
      let required;
      try { required = requireCheckedKnob(name, env); } catch { required = undefined; }
      if (required === undefined) {
        assert.notEqual(raw.trim(), '', `${name}=${JSON.stringify(raw)}: blank must not throw`);
      } else {
        assert.equal(checkedKnob(name, env), required, `${name}=${JSON.stringify(raw)}`);
      }
    }
  }
});
