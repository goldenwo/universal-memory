// provider-prompts-snapshot.test.mjs — the cross-provider facts-prompt SYNC pin
// (#181 arc, 2026-07-28; successor to the salience-arc A7 divergence pin).
//
// All four providers source FACTS_SYSTEM_PROMPT from lib/provider/facts-prompt.mjs;
// this test pins (1) the shared text itself and (2) that every provider actually
// uses the shared module — so the prompts can never silently drift APART again.
//
// HOW TO MAKE A DELIBERATE CHANGE:
//   • Policy revision (all providers at once): edit facts-prompt.mjs AND the
//     GOLDEN_FACTS_PROMPT below in the same commit, and re-run the
//     extraction-fidelity eval for every provider you can key (runbook:
//     eval/results/2026-07-28-provider-prompt-sync.md).
//   • Per-provider variant (measurement forced a different text for ONE provider):
//     give that provider a local `const FACTS_SYSTEM_PROMPT = \`...\`;` literal and
//     flip its PROVIDER_EXPECTATIONS entry from 'shared' to { golden: '<the new
//     text>' } — in the same commit as the provider edit. Everything else stays
//     'shared'.
// Editing a provider's prompt without updating this file is exactly the silent
// drift this pin exists to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FACTS_SYSTEM_PROMPT } from '../lib/provider/facts-prompt.mjs';

// The v1.5.2 noise-abstention policy text (synced cross-provider in the #181 arc).
const GOLDEN_FACTS_PROMPT = `You are a fact extractor. The user message contains text from a memory store.
Extract only durable, explicitly-stated facts useful for long-term personalization or recall — things the writer states as settled and true.

EXTRACT (settled claims): preferences, decisions, attributes, relationships, roles, schedules, exact numbers/dates/amounts, and named entities. This includes:
- Negations stated as the current fact (e.g. "we do not deploy on weekends").
- Facts reported through someone else but presented as true — the reporting verb (said / mentioned / told me / confirmed) does NOT make it a hedge (e.g. "the inspector said the roof passed").
- Committed or announced future events, even if not yet done (e.g. "the venue is booked for August 12th", "Lena moves to the Tokyo team next month"). Cut on commitment, NOT on futurity.
- Every distinct durable fact in the message, extracted separately — never merge two facts into one, and never omit one because another is present. When a person is named together with who they are and what they did, extract their identity or relationship as its own fact too (e.g. from "my cousin Dev started med school", extract both "the writer has a cousin named Dev" and "Dev started med school").
- A settled fact stays a fact even when wrapped in chatty or emotional text — extract it and ignore the wrapper.

DO NOT EXTRACT (return no fact for these):
- Greetings, chitchat, gratitude, pleasantries, or venting with no fact.
- Non-committed intentions or deliberations — the writer has not committed yet (e.g. "I'll circle back after lunch", "I need to sleep on it"). Contrast: a committed future event above IS a fact.
- Questions.
- Hedged, uncertain, or speculative statements — markers such as "maybe", "might", "not sure", "possibly" (e.g. "it could be Redis, I can't recall").
- Tentative or still-being-decided statements (e.g. "we're torn between two vendors").

When the writer changes, corrects, or supersedes a value mid-message, keep only the current value of THAT claim and drop the superseded one — but never drop other, unrelated facts in the same message.

Each fact must be atomic (one claim), declarative, third-person, and grounded in the text — never inferred beyond what is stated.

Output ONLY a JSON object: {"facts": ["fact 1", "fact 2"]}. No preamble, no markdown fences.
If no durable facts are present, output {"facts": []}.`;

// Per-provider expectation map (spec D3(2)): 'shared' ⇒ the file imports
// facts-prompt.mjs and defines no local literal; { golden } ⇒ the file's local
// literal equals that provider-specific golden (the variant escape hatch).
const PROVIDER_EXPECTATIONS = {
  'openai.mjs': 'shared',
  'anthropic.mjs': 'shared',
  'google.mjs': 'shared',
  'ollama.mjs': 'shared',
};

const norm = (s) => s.replace(/\r\n/g, '\n');

function providerSource(providerFile) {
  const path = fileURLToPath(new URL(`../lib/provider/${providerFile}`, import.meta.url));
  // CRLF-normalize — a Windows checkout (core.autocrlf) must not fail a
  // byte-assert that the Linux CI runner passes.
  return norm(readFileSync(path, 'utf8'));
}

test('shared facts prompt matches the pinned golden text', () => {
  assert.equal(
    norm(FACTS_SYSTEM_PROMPT),
    norm(GOLDEN_FACTS_PROMPT),
    'facts-prompt.mjs drifted from the golden pin — if this edit is deliberate, update '
    + 'GOLDEN_FACTS_PROMPT here in the same commit and re-run the extraction-fidelity '
    + 'eval per provider (see the header runbook)',
  );
});

for (const [providerFile, expectation] of Object.entries(PROVIDER_EXPECTATIONS)) {
  if (expectation === 'shared') {
    test(`provider prompt sync: ${providerFile} uses the shared facts-prompt module`, () => {
      const source = providerSource(providerFile);
      assert.match(
        source,
        /import \{ FACTS_SYSTEM_PROMPT \} from '\.\/facts-prompt\.mjs';/,
        `${providerFile}: expected an import of FACTS_SYSTEM_PROMPT from ./facts-prompt.mjs — `
        + 'a provider on the shared policy must source the prompt from the shared module',
      );
      assert.doesNotMatch(
        source,
        /const FACTS_SYSTEM_PROMPT\s*=/,
        `${providerFile}: found a local FACTS_SYSTEM_PROMPT literal shadowing the shared module — `
        + 'either remove it (shared policy) or flip this provider\'s PROVIDER_EXPECTATIONS entry '
        + 'to { golden } in the same commit (deliberate per-provider variant; see header)',
      );
    });
  } else {
    test(`provider prompt snapshot: ${providerFile} local variant matches its golden`, () => {
      const m = providerSource(providerFile).match(/const FACTS_SYSTEM_PROMPT = `([^`]+)`;/);
      assert.ok(m, `${providerFile}: FACTS_SYSTEM_PROMPT local literal not found — a variant entry requires one`);
      assert.equal(
        m[1],
        norm(expectation.golden),
        `${providerFile}: variant prompt drifted from its golden — if deliberate, update the `
        + 'PROVIDER_EXPECTATIONS golden here in the same commit (see header runbook)',
      );
    });
  }
}
