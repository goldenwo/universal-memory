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
// The pin has two halves:
// - Declared: every `actions/setup-node` step names an explicit
//   node-version whose major equals the Dockerfile's `FROM node:<major>`.
// - Actual: in CI, the Node running this suite has that major. That covers
//   a job with no setup-node step at all, which #255 found in the smoke job
//   before.
// A deliberate Node bump moves CI and the image together. This file makes a
// one-sided bump fail.
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

// Every FROM line's image, `--platform=` flag skipped. An image that is not
// `node:<digits>…` maps to a null major, so it fails the test loudly rather
// than being skipped.
function imageFroms() {
  const text = readFileSync(DOCKERFILE, 'utf8');
  return [...text.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map(([, image]) => ({
    image,
    major: image.match(/^node:(\d+)\b/)?.[1] ?? null,
  }));
}

function imageNodeMajor() {
  return imageFroms()[0]?.major;
}

function setupNodeSteps() {
  const steps = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const workflow = YAML.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      for (const step of job?.steps ?? []) {
        // Action refs are case-insensitive on GitHub.
        if (typeof step?.uses === 'string' && /^actions\/setup-node@/i.test(step.uses)) {
          steps.push({ where: `${file} › ${jobId}`, nodeVersion: step.with?.['node-version'] });
        }
      }
    }
  }
  return steps;
}

test('the image pins a single Node major', () => {
  const froms = imageFroms();
  // Guard against a vacuous pass: no FROM line means nothing is pinned.
  assert.ok(froms.length > 0, `no FROM line in ${DOCKERFILE}`);
  assert.deepEqual(
    froms.filter(({ major }) => major === null).map(({ image }) => image),
    [],
    'every Dockerfile stage must be FROM node:<major>… so its Node major can be checked',
  );
  const majors = froms.map(({ major }) => major);
  assert.equal(new Set(majors).size, 1, `Dockerfile stages disagree on the Node major: ${majors.join(', ')}`);
});

test("every setup-node step pins the image's Node major", () => {
  const imageMajor = imageNodeMajor();
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

test('in CI, the Node running this suite has the image major', {
  skip: process.env.GITHUB_ACTIONS !== 'true' && 'local run: only CI has to match the image',
}, () => {
  const imageMajor = imageNodeMajor();
  assert.equal(
    process.versions.node.split('.')[0],
    imageMajor,
    `this CI job runs Node ${process.versions.node} but the image is node:${imageMajor}. ` +
    `Give the job an actions/setup-node step with node-version '${imageMajor}'.`,
  );
});
