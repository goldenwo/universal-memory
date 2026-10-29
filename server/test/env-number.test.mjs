// server/test/env-number.test.mjs — the one numeric env parser (lib/env-number.mjs).
//
// Every numeric env knob reads through these, so a malformed value means the same
// thing everywhere: no override, and the caller's default applies. Pins the shapes
// the lenient reads got wrong — a numeric prefix ('0.9x' read as 0.9 by parseFloat),
// a blank (' ' read as 0 by Number, '' as NaN by parseInt) and a fraction where an
// integer is wanted ('3.5' read as 3 by parseInt).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumberEnv, parseIntEnv, parsePositiveNumberEnv, parsePortEnv } from '../lib/env-number.mjs';

test('parseNumberEnv: a wholly numeric value, trimmed', () => {
  assert.equal(parseNumberEnv('0.9'), 0.9);
  assert.equal(parseNumberEnv(' 0.9 '), 0.9);
  assert.equal(parseNumberEnv('0'), 0);
  assert.equal(parseNumberEnv('-2'), -2);
  assert.equal(parseNumberEnv('1e3'), 1000);
});

test('parseNumberEnv: unset, blank, a numeric prefix, junk or a non-finite value is no override', () => {
  for (const raw of [undefined, null, '', ' ', '\t', '0.9x', '0.1garbage', 'abc', 'Infinity', '-Infinity', 'NaN']) {
    assert.equal(parseNumberEnv(raw), undefined, JSON.stringify(raw));
  }
});

test('parseIntEnv: a whole number at or above min (default 1)', () => {
  assert.equal(parseIntEnv('3'), 3);
  assert.equal(parseIntEnv(' 3 '), 3);
  assert.equal(parseIntEnv('1e3'), 1000);
  assert.equal(parseIntEnv('0', { min: 0 }), 0);
  assert.equal(parseIntEnv('65535', { max: 65535 }), 65535);
});

test('parseIntEnv: a fraction, a prefix, blank, below min or above max is no override', () => {
  for (const raw of [undefined, '', ' ', '3.5', '3x', '2.5e0', 'abc', '0', '-1', '9007199254740993']) {
    assert.equal(parseIntEnv(raw), undefined, JSON.stringify(raw));
  }
  assert.equal(parseIntEnv('-1', { min: 0 }), undefined);
  assert.equal(parseIntEnv('65536', { max: 65535 }), undefined);
});

test('parsePositiveNumberEnv: a number above 0, fractions included', () => {
  assert.equal(parsePositiveNumberEnv('7.5'), 7.5);
  assert.equal(parsePositiveNumberEnv(' 60 '), 60);
  for (const raw of [undefined, '', ' ', '0', '-1', '7.5x', 'abc']) {
    assert.equal(parsePositiveNumberEnv(raw), undefined, JSON.stringify(raw));
  }
});

test('parsePortEnv: a TCP port 1-65535, else the fallback', () => {
  assert.equal(parsePortEnv('6335', 6333), 6335);
  for (const raw of [undefined, '', ' ', '6335x', '0', '65536', '63.5']) {
    assert.equal(parsePortEnv(raw, 6333), 6333, JSON.stringify(raw));
  }
});
