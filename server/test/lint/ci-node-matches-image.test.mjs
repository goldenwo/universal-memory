// server/test/lint/ci-node-matches-image.test.mjs — #387 follow-up.
//
// deps-guard (.github/workflows/smoke.yml) is the only gate a secret-less
// Dependabot PR runs before the image build, and it catches lock failures
// only while CI runs the same npm as the image. Both use Node 22 today, so
// both run npm 10. npm 10 and npm >= 11.5 disagree about optional peers
// (server/patches/README.md §Overrides). Measured in the #387 review loop:
// with the mongodb override removed, `npm ci` fails EUSAGE under Node 22's
// npm 10.9.8 but passes under Node 24's npm 11.19.1. A CI-only move to
// Node 24 would therefore pass locks the image rejects, and nothing would
// notice before `docker build`.
//
// The pin: every `actions/setup-node` step names an explicit node-version
// whose major equals the Dockerfile's `FROM node:<major>`. A deliberate
// Node bump moves both together. This test makes a one-sided bump fail.
//
// Runs in the same suite the deps-guard CI job executes → standing gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const SERVER_ROOT = resolve(dirname(__filename), '..', '..');
const WORKFLOWS_DIR = join(SERVER_ROOT, '..', '.github', 'workflows');
const DOCKERFILE = join(SERVER_ROOT, 'Dockerfile');

function imageNodeMajors() {
  const text = readFileSync(DOCKERFILE, 'utf8');
  return [...text.matchAll(/^FROM\s+node:(\d+)\b/gim)].map((m) => m[1]);
}

function setupNodeSteps() {
  const steps = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const workflow = YAML.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        if (typeof step?.uses === 'string' && step.uses.startsWith('actions/setup-node@')) {
          steps.push({ where: `${file} › ${jobId}`, nodeVersion: step.with?.['node-version'] });
        }
      }
    }
  }
  return steps;
}

test('the image pins a single Node major', () => {
  const majors = imageNodeMajors();
  // Guard against a vacuous pass: no FROM node:N line means nothing is pinned.
  assert.ok(majors.length > 0, `no "FROM node:<major>" line in ${DOCKERFILE}`);
  assert.equal(new Set(majors).size, 1, `Dockerfile stages disagree on the Node major: ${majors.join(', ')}`);
});

test("every setup-node step pins the image's Node major", () => {
  const [imageMajor] = imageNodeMajors();
  const steps = setupNodeSteps();
  // Guard against a vacuous pass: a renamed workflows dir or action would
  // otherwise certify nothing.
  assert.ok(steps.length > 0, `no actions/setup-node steps found under ${WORKFLOWS_DIR}`);
  const mismatched = steps.filter(
    ({ nodeVersion }) => String(nodeVersion ?? '').match(/^(\d+)\b/)?.[1] !== imageMajor,
  );
  assert.deepEqual(
    mismatched.map(({ where, nodeVersion }) => `${where}: node-version ${JSON.stringify(nodeVersion ?? null)}`),
    [],
    `setup-node must pin an explicit node-version on the image's major (${imageMajor}). ` +
    `CI on a different npm than the image lets deps-guard pass locks the image's ` +
    `npm ci rejects. Move CI and server/Dockerfile together; see server/patches/README.md §Overrides.`,
  );
});
