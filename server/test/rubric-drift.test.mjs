// server/test/rubric-drift.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const CANONICAL_PATH = path.join(REPO, 'docs/memory-routing-rubric.md');
const MIRROR_PATHS = [
  'plugins/codex/universal-memory/README.md',
  'plugins/chatgpt-custom-gpt/universal-memory/README.md',
  'plugins/chatgpt-custom-gpt/universal-memory/system-prompt.md',
  'docs/connecting-chatgpt-desktop.md',
  'docs/connecting-claude-ai.md',
].map((p) => path.join(REPO, p));

function extractRubric(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  const m = src.match(/<!-- CANONICAL-RUBRIC-START -->([\s\S]*?)<!-- CANONICAL-RUBRIC-END -->/);
  if (!m) throw new Error(`no rubric markers found in ${absPath}`);
  return m[1].trim();
}

test('rubric drift-gate: all 5 mirrors byte-match canonical', () => {
  const canonical = extractRubric(CANONICAL_PATH);
  for (const p of MIRROR_PATHS) {
    const mirror = extractRubric(p);
    assert.equal(mirror, canonical, `${path.relative(REPO, p)} drifted from canonical`);
  }
});
