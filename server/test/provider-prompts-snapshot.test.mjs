// provider-prompts-snapshot.test.mjs — A7 golden-string pin for the non-openai facts prompts
// (salience arc T7). The anthropic/google/ollama providers still carry the 4-line pre-v1.5.2
// extraction prompt; the write-path salience policy lives in openai.mjs only. This pin makes
// any future edit to those prompts a DELIBERATE test update rather than silent drift — the
// cross-provider prompt-sync arc (spec §6 carry-forward) owns bringing them up to policy,
// with per-provider fixtures and measurement. No provider file is edited or given new
// exports: the test reads SOURCE TEXT and extracts the template literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The 4-line pre-v1.5.2 facts prompt, byte-identical across all three providers
// (verified against the tree at the salience arc's A0 premise check, 2026-07-27).
const GOLDEN_FACTS_PROMPT = `You are a fact extractor. The user message contains text from a memory store.
Extract atomic, declarative facts useful for personalization or recall.
Output ONLY a JSON object: {"facts": ["fact 1", "fact 2"]}. No preamble, no markdown fences.
If no facts can be extracted, output {"facts": []}.`;

function factsPromptFromSource(providerFile) {
  const path = fileURLToPath(new URL(`../lib/provider/${providerFile}`, import.meta.url));
  // Normalize line endings on both sides — a Windows checkout (core.autocrlf) must not
  // fail a byte-assert that the Linux CI runner passes.
  const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const m = source.match(/const FACTS_SYSTEM_PROMPT = `([^`]+)`;/);
  assert.ok(m, `${providerFile}: FACTS_SYSTEM_PROMPT template literal not found in source`);
  return m[1];
}

for (const providerFile of ['anthropic.mjs', 'google.mjs', 'ollama.mjs']) {
  test(`provider prompt snapshot: ${providerFile} facts prompt is the pinned 4-line pre-v1.5.2 text`, () => {
    assert.equal(
      factsPromptFromSource(providerFile),
      GOLDEN_FACTS_PROMPT.replace(/\r\n/g, '\n'),
      `${providerFile}: facts prompt drifted from the golden pin — if this edit is deliberate, `
      + 'update GOLDEN_FACTS_PROMPT here as part of the cross-provider prompt-sync arc (spec §6)',
    );
  });
}
