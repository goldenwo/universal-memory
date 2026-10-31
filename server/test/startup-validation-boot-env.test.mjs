// server/test/startup-validation-boot-env.test.mjs — validateBootEnv, the one list of the
// server's boot-time environment refusals, and the two programs that run it.
//
// The installer runs bin/check-env.mjs inside the target image before it starts or swaps the
// server (#400), so a configuration the image would refuse is caught while the running server
// keeps serving. That holds only if the check and the server refuse exactly the same
// environments: both call validateBootEnv, and the child-process cases below hold the two
// programs to the same FATAL text for the same environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateBootEnv } from '../lib/startup-validation.mjs';

const SERVER = fileURLToPath(new URL('../mem0-mcp-http.mjs', import.meta.url));
const CHECK_ENV = fileURLToPath(new URL('../bin/check-env.mjs', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('../Dockerfile', import.meta.url));
const VALID = { MEM0_USER_ID: 'boot-env-test', OPENAI_API_KEY: 'sk-test' };

// One environment per refusal class, in boot order, with the start of its FATAL text.
const REFUSED = [
  ['no user id', { OPENAI_API_KEY: 'sk-test' }, 'MEM0_USER_ID is required'],
  ['a malformed checked knob', { ...VALID, UM_RATE_LIMIT_BURST: '10.5' }, 'UM_RATE_LIMIT_BURST must be'],
  ['a provider without the surface', { ...VALID, UM_EMBEDDING_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' },
    'anthropic does not support embeddings'],
  ['an unpriced model', { ...VALID, UM_FACTS_PROVIDER: 'openai', UM_FACTS_MODEL: 'gpt-retired-1' },
    "facts: model 'gpt-retired-1' is not in PRICING for provider 'openai'"],
  ['a provider with no key', { MEM0_USER_ID: 'boot-env-test' },
    'UM_EMBEDDING_PROVIDER=openai requires one of: UM_OPENAI_API_KEY, OPENAI_API_KEY'],
  ['OAuth with no public URL', { ...VALID, UM_OAUTH_ENABLED: 'true' },
    'UM_OAUTH_ENABLED=true requires UM_PUBLIC_BASE_URL'],
];

/** The text after "FATAL: " on the program's first FATAL line, or null. */
function fatalOf(stderr) {
  const m = /FATAL: (.*)/.exec(stderr);
  return m ? m[1] : null;
}

function run(entry, env) {
  return spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30_000,
  });
}

test('validateBootEnv: a complete environment passes', () => {
  assert.doesNotThrow(() => validateBootEnv(VALID));
});

test('validateBootEnv: each boot refusal throws its FATAL text', () => {
  for (const [why, env, prefix] of REFUSED) {
    assert.throws(() => validateBootEnv(env), (err) => err.message.startsWith(prefix), why);
  }
});

test('check-env: an environment the server accepts exits 0', () => {
  const r = run(CHECK_ENV, VALID);
  assert.equal(r.status, 0, `exit status; stderr: ${r.stderr}`);
  assert.match(r.stdout, /\[check-env\] ok/);
});

// The contract the installer relies on: check-env refuses an environment exactly when the
// server's boot does, with the same reason.
test('check-env and the server refuse the same environments with the same FATAL text', () => {
  for (const [why, env, prefix] of REFUSED) {
    const check = run(CHECK_ENV, env);
    const boot = run(SERVER, env);
    assert.equal(check.status, 1, `${why}: check-env exit; stderr: ${check.stderr}`);
    assert.equal(boot.status, 1, `${why}: server exit; stderr: ${boot.stderr}`);
    assert.match(check.stderr, /^\[check-env\] FATAL: /m, why);
    assert.ok(fatalOf(check.stderr)?.startsWith(prefix), `${why}: check-env said ${check.stderr}`);
    assert.equal(fatalOf(check.stderr), fatalOf(boot.stderr), `${why}: same FATAL text`);
  }
});

// The image is where the installer runs it.
test('the image ships bin/check-env.mjs', () => {
  assert.match(readFileSync(DOCKERFILE, 'utf8'), /^COPY bin\/check-env\.mjs \.\/bin\/$/m);
});
