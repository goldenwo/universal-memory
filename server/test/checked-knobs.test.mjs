// server/test/checked-knobs.test.mjs — the knobs whose silent fallback would do harm
// (lib/checked-knobs.mjs). Readers read them with checkedKnob(); boot validates them with
// requireCheckedKnob() over the same table, so whatever boot accepts, the reader honours.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// The parse contract (checked-knobs.mjs): a parse returns undefined to reject and never
// substitutes a default — else boot could not refuse. Holds for every entry, present and future.
test('every entry parse rejects malformed and blank values, so boot refuses them', () => {
  for (const [name, { parse }] of Object.entries(CHECKED_KNOBS)) {
    for (const blank of [undefined, '', ' ']) {
      assert.equal(parse(blank), undefined, `${name} parse(${JSON.stringify(blank)})`);
    }
    for (const bad of ['abc', '5x', '"120"', '1e400', '-1']) {
      assert.throws(() => requireCheckedKnob(name, { [name]: bad }), new RegExp(`${name} must be`),
        `${name}=${JSON.stringify(bad)} must refuse`);
    }
  }
});

// The defaults operators see and run must be the table's: .env.example's lines, and the
// defaults server/install.sh writes into every .env.
test('.env.example and the installer show each checked knob with the table default', () => {
  const root = new URL('../', import.meta.url);
  const example = readFileSync(new URL('.env.example', root), 'utf8');
  const installer = readFileSync(new URL('install.sh', root), 'utf8');
  let exampleLines = 0, installerLines = 0;
  for (const [name, { fallback }] of Object.entries(CHECKED_KNOBS)) {
    for (const m of example.matchAll(new RegExp(`^#?\\s*${name}=(\\S+)`, 'gm'))) {
      assert.equal(m[1], String(fallback), `.env.example ${name}`);
      exampleLines++;
    }
    for (const m of installer.matchAll(new RegExp(`^\\s*(\\S+)\\s+#\\s*${name}\\b`, 'gm'))) {
      assert.equal(m[1], String(fallback), `install.sh v06 default for ${name}`);
      installerLines++;
    }
  }
  // Not vacuous: every checked knob appears in .env.example, and the installer writes the
  // rate-limit trio and the body cap.
  assert.equal(exampleLines, Object.keys(CHECKED_KNOBS).length, '.env.example lines checked');
  assert.equal(installerLines, 4, 'install.sh v06 defaults checked');
});

test('an unknown knob name is a named error, and the table cannot be edited at runtime', () => {
  assert.throws(() => checkedKnob('UM_NOT_A_KNOB', {}), /unknown checked knob: UM_NOT_A_KNOB/);
  assert.throws(() => requireCheckedKnob('constructor', {}), /unknown checked knob: constructor/);
  for (const [name, k] of Object.entries(CHECKED_KNOBS)) {
    assert.ok(Object.isFrozen(k), `${name} entry is frozen`);
  }
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
