# Cross-provider facts-prompt sync (#181) — measurement record, 2026-07-28

Arc: cross-provider prompt sync + reaction-salience telemetry (#181, #187 telemetry half
separate). Spec/plan gitignored (`docs/plans/2026-07-28-cross-provider-prompt-sync-{spec,plan}.md`,
review-converged 2026-07-28). This doc is the committed record of the measurement matrix,
gate verdicts, and deferrals.

## What shipped

All four providers now source `FACTS_SYSTEM_PROMPT` from `lib/provider/facts-prompt.mjs`
(the v1.5.2 noise-abstention policy text, previously openai-only), pinned by the rebuilt
`test/provider-prompts-snapshot.test.mjs` (per-provider expectation map). anthropic/
google/ollama `factsInvoke` additionally gain openai's overridable `temperature: 0` pin —
prompt + temp shipped and measured as ONE package.

Cost note (named, not silent): the policy prompt is ~6× the old 4-line prompt's input
tokens (~500 vs ~80) on every facts call for the three synced providers — well under
$0.10 per 40-row eval run at haiku prices, negligible per production capture, and zero
for the live-unreachable providers (google/ollama).

## Run config (pinned)

- Fixture: `eval/extraction-set.jsonl` (40 rows / 32 fact-bearing / 49 gold / 8 noise
  rows e03/e06/e08/e11/e22/e23/e31/e32).
- Judge: gpt-4o-mini (`UM_EXTRACTION_GRADER_MODEL` default).
- No `--gate` on any run (extractionThresholds are verdict-only-pathed + CI-pool-sized;
  the harness now fail-fasts on that misuse — exit 2). Arc gates applied by hand below.
- Harness fixes landed first: truthful `factsProvider`/`factsModel` from facts()'s
  per-call return (the old env-only label misreported anthropic runs as
  "gpt-4.1-nano (provider default)" — visible in the committed baseline JSONs, which
  predate the fix and are re-annotated here: they are anthropic/claude-haiku-4-5 runs);
  `judgeError` per-row marker for judge invoke-error failsafes.

## Matrix

| provider | model | run | recall | precision | noiseAbstained | parseFails | file |
|---|---|---|---|---|---|---|---|
| anthropic (BASELINE, old 4-line prompt, temp ignored) | claude-haiku-4-5 | T0 run1 | 1.000 | 0.952 | 4/8 | 0 | 2026-07-28-anthropic-prompt-baseline-run1.json |
| anthropic (BASELINE) | claude-haiku-4-5 | T0 run2 | 1.000 | 0.984 | 4/8 | 0 | 2026-07-28-anthropic-prompt-baseline-run2.json |
| openai (regression, post-refactor) | gpt-4.1-nano | run1 | 1.000 | 1.000 | 7/8 (e11 miss) | 0 | 2026-07-28-openai-prompt-sync-regression-run1.json |
| anthropic (POST-change, policy + temp-0) | claude-haiku-4-5 | run1 | 1.000 | 1.000 | 8/8 | 0 | 2026-07-28-anthropic-prompt-sync-run1.json |
| anthropic (POST-change) | claude-haiku-4-5 | run2 | 1.000 | 1.000 | 8/8 | 0 | 2026-07-28-anthropic-prompt-sync-run2.json |

Baseline abstention set (both T0 runs, identical): e06 (intention), e08 (question),
e31 (chitchat), e32 (greeting) — failing e03 (gratitude/chitchat) + e11/e22/e23 (all
three hedge/tentative rows). This is the IDENTICAL gap pattern openai had pre-v1.5.2
(4/8, same rows) — the policy transfer hypothesis held.

## Pre-registered gate verdicts (anthropic post-change; frozen before run 1)

- (a) recall = 1.000 both runs: 1.000 / 1.000 ✓ (zero misses either run — the judge-
  wobble audit had nothing to audit; the merge spot-check found no suspected merges).
- (b) noiseAbstained ≥ 7/8 both runs + category coverage (pinned map: greeting=e32,
  intention=e06, question=e08, gratitude/chitchat=e03, hedge/tentative=e11/e22/e23;
  e31 non-representative) + no T0-abstaining category regressing: 8/8 BOTH runs,
  every category abstaining, identical sets ✓. Notably haiku abstains on e11 — the
  hedged-future row openai tolerates as its one miss.
- (c) precision ≥ 0.98 both runs: 1.000 / 1.000 ✓
- (d) parseFails = 0 both runs, zero judgeError rows ✓
- (e) floor-exact stability: 8/8 both runs — never at the 7 floor; no 3rd run required ✓
- (f) judge audit: no recall misses in either run — nothing to audit ✓

## openai regression verdict

Recall 1.000 / precision 1.000 / noiseAbstained 7/8 with e11 the single miss /
parseFails 0 — byte-for-byte the committed v1.5.2 baseline behavior
(2026-06-23-extraction-noiseabstain-STATUS.md). The shared-module refactor changed
nothing for openai, as designed (the string is byte-identical; the mocked call-site
test pins it).

## Deferrals (recorded, not silent)

- **google**: NO live run — Gemini free tier quota limit:0 (standing since 2026-05-01;
  re-verified posture 2026-07-28, not re-attempted per standing rule). Coverage is
  mocked-SDK only: the call-site test pins the policy text into `config.systemInstruction`
  and the temp contract into `config.temperature`. First live run = known follow-up when
  a keyed Gemini account exists.
- **ollama**: NO live run — no ollama daemon on the dev box or the Pi (both probed
  2026-07-28). Coverage is mocked-fetch only: the call-site test pins the composed
  `policy\n\n---\n\ntext` prompt prefix + `options.temperature`. Also recorded: the
  single-string compose has no system/user role separation — accepted for this arc
  (mechanism unchanged from status quo; provider live-unreachable); the recorded future
  fix if a live run surfaces injection issues is the chat endpoint with a proper system
  role, not delimiter hardening.

## Verdict

**PACKAGE ACCEPTED** — all six pre-registered gates pass on both post-change runs.
anthropic noiseAbstained 4/8 → **8/8** with recall held at 1.000/1.000. The per-provider
variant escape hatch and the fallback rule (revert anthropic to the pre-v1.5.2 local
literal + unpin temp) were NOT exercised; all four providers ship on the shared policy
text.
