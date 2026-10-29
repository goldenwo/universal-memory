// server/test/startup-validation-numeric-knobs.test.mjs — boot refusal for a malformed
// protection knob (validateNumericKnobs).
//
// The rate limiter, the request-body cap and the two ports read a malformed value as no
// override (lib/env-number.mjs). For these knobs that fallback is silent loosening, so a
// set-but-malformed value refuses boot instead — the #321 rule UM_OAUTH_CONSENT_TTL_HOURS
// already follows. Unset or blank stays the default, with no refusal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateNumericKnobs } from '../lib/startup-validation.mjs';

const KNOBS = [
  'UM_RATE_LIMIT_RPM', 'UM_RATE_LIMIT_BURST', 'UM_RATE_LIMIT_MAX_IPS',
  'UM_HTTP_MAX_REQUEST_BYTES', 'MEM0_MCP_PORT', 'QDRANT_PORT',
];

test('validateNumericKnobs: unset and blank knobs pass (the default applies)', () => {
  assert.doesNotThrow(() => validateNumericKnobs({}));
  for (const name of KNOBS) {
    for (const raw of ['', ' ']) {
      assert.doesNotThrow(() => validateNumericKnobs({ [name]: raw }), `${name}=${JSON.stringify(raw)}`);
    }
  }
});

test('validateNumericKnobs: well-formed knobs pass, a fractional rate included', () => {
  assert.doesNotThrow(() => validateNumericKnobs({
    UM_RATE_LIMIT_RPM: '7.5',
    UM_RATE_LIMIT_BURST: '10',
    UM_RATE_LIMIT_MAX_IPS: ' 10000 ',
    UM_HTTP_MAX_REQUEST_BYTES: '2097152',
    MEM0_MCP_PORT: '6335',
    QDRANT_PORT: '6333',
  }));
});

test('validateNumericKnobs: a malformed knob throws, naming the variable and the value', () => {
  const cases = [
    ['UM_RATE_LIMIT_RPM', '512k'],
    ['UM_RATE_LIMIT_RPM', '120"'],
    ['UM_RATE_LIMIT_RPM', '0'],
    ['UM_RATE_LIMIT_RPM', '-60'],
    ['UM_RATE_LIMIT_BURST', '2.5'],
    ['UM_RATE_LIMIT_BURST', 'abc'],
    ['UM_RATE_LIMIT_MAX_IPS', '10000x'],
    ['UM_HTTP_MAX_REQUEST_BYTES', '512k'],
    ['MEM0_MCP_PORT', '127.0.0.1:6337'],
    ['MEM0_MCP_PORT', '70000'],
    ['QDRANT_PORT', 'abc'],
  ];
  for (const [name, raw] of cases) {
    assert.throws(
      () => validateNumericKnobs({ [name]: raw }),
      (err) => err.message.includes(name) && err.message.includes(JSON.stringify(raw)),
      `${name}=${JSON.stringify(raw)} must refuse boot`,
    );
  }
});

// The boot wiring itself: run as main, the server must exit 1 on a malformed knob before
// it reaches anything that needs a provider key or Qdrant.
test('server boot: a malformed protection knob exits 1 with a FATAL line', () => {
  const entry = fileURLToPath(new URL('../mem0-mcp-http.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, MEM0_USER_ID: 'knob-test', UM_RATE_LIMIT_RPM: '512k' };
  const r = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, `exit status; stderr: ${r.stderr}`);
  assert.match(r.stderr, /FATAL: UM_RATE_LIMIT_RPM must be/);
});
