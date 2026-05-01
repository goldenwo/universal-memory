# Adding a Provider

This is the canonical reference for adding a new LLM provider to Universal Memory.
Source-of-truth: v0.7 provider-neutrality design spec §3.1 (Add-a-Provider
Checklist) and §3.2 (Standard Provider Contract). The runtime contract is
encoded in [`server/lib/provider/registry.mjs`](../../server/lib/provider/registry.mjs)
and [`server/lib/provider/openai.mjs`](../../server/lib/provider/openai.mjs)
(canonical reference implementation).

The acceptance test for "future-proof" is concrete: **adding a 5th provider in
v0.8 (e.g. `groq`) is a checklist, not an architectural exercise.** If during
implementation you discover a 7th place that needs touching beyond the six
below, the abstraction has failed and gets fixed before merge — do not work
around it by sprinkling provider-specific conditionals into surface code.

---

## 1. Add-a-Provider Checklist (6 mechanical touches)

Lifted verbatim from spec §3.1. That's it. Anything beyond is a smell.

1. **Provider module.** Create `server/lib/provider/<name>.mjs` exporting the
   standard provider contract (§2 below).
2. **Registry entry.** Register the provider in each surface registry where
   supported: `BACKENDS` in `server/lib/summarize.mjs`, `EMBEDDING_BACKENDS` in
   `server/lib/embed.mjs`, `FACTS_BACKENDS` in `server/lib/facts.mjs`. The
   registry filters by the provider's `supports` flags — modules with
   `supports.embeddings === false` are not added to `EMBEDDING_BACKENDS`.
3. **Wizard validator.** Add the API-key validator entry — a single call in
   `installer/wizard-lib.sh`'s registry-driven `wizard_validate_api_key
   <provider>` (no per-provider validator function).
4. **Pricing rows.** Add pricing rows to `server/lib/pricing.mjs` with
   `last_verified` date (see §5 below for the staleness discipline).
5. **Auto-derived enums.** Add allowed-value entries to `.env.example` and
   OpenAPI enums — both auto-derived from the registry. **No manual editing
   of the OpenAPI enum list.**
6. **Tests.** Tests auto-include the new provider via the registry-loop
   pattern (see §4 below); only provider-specific edge cases need a focused
   test file.

---

## 2. Standard Provider Contract

Every `server/lib/provider/<name>.mjs` exports the same shape. The canonical
working reference is [`server/lib/provider/openai.mjs`](../../server/lib/provider/openai.mjs)
— read it alongside this section.

```js
export const providerName = 'openai';

// Surface invocations — null if unsupported (e.g. anthropic.embedderConfig = null).
export async function summarizerInvoke(prompt, opts) { ... }
export function embedderConfig(env) { ... }   // returns mem0 embedder config block
export function factsLlmConfig(env) { ... }   // returns mem0 llm config block

// Defaults (data-driven, never in dispatch logic).
export const defaults = {
  summarizerModel: 'gpt-4o-mini',
  embeddingModel:  'text-embedding-3-small',
  embeddingDim:    1536,
  factsModel:      'gpt-4.1-nano-2025-04-14',
};

// Validation.
export const requires = ['UM_OPENAI_API_KEY', 'OPENAI_API_KEY'];  // env-key search order
export function resolveApiKey(env) { ... }      // walks `requires`, returns first non-empty
export function validateKeyFormat(key) { ... }  // sk-* / sk-ant-* / etc.
export function extractUsage(rawResponse) { ... } // unified { tokensIn, tokensOut }
export function normalizeError(err) { ... }    // strips URL/headers/body; returns { status, message }

// Capabilities (machine-readable; drives wizard, validators, doc gen, OpenAPI enums).
export const supports = {
  embeddings: true,
  summarizer: true,
  facts:      true,
};
```

### 2.1 Export reference

| Export                | Type     | Required | Purpose                                                                                                              |
|-----------------------|----------|----------|----------------------------------------------------------------------------------------------------------------------|
| `providerName`        | string   | yes      | Matches the registry key. Used in metric labels (`provider`).                                                        |
| `supports`            | object   | yes      | Capability flags `{ embeddings, summarizer, facts }`. Drives registry filters and OpenAPI enum derivation.           |
| `defaults`            | object   | yes      | Default models per surface. Surface modules read `env.UM_*_MODEL || defaults.<surface>Model`.                        |
| `requires`            | string[] | yes      | Env-var names checked in order by `resolveApiKey` (e.g. `['UM_OPENAI_API_KEY', 'OPENAI_API_KEY']`). Empty for Ollama. |
| `resolveApiKey(env)`  | fn       | yes      | Walks `requires`, returns first non-empty value or `null`.                                                           |
| `validateKeyFormat`   | fn       | yes      | Returns boolean; format check (`sk-*`, `sk-ant-*`, `AIza*`, etc.). Always `true` for Ollama.                         |
| `embedderConfig(env)` | fn / null | yes     | Returns mem0 embedder config block. **Literal `null`** if unsupported (e.g. Anthropic).                              |
| `factsLlmConfig(env)` | fn / null | yes     | Returns mem0 llm config block. `null` if unsupported.                                                                 |
| `summarizerInvoke`    | async fn | yes      | Direct-dispatch summarizer entry point. Returns `{ content, usage }`.                                                |
| `extractUsage(raw)`   | fn       | yes      | Provider-specific token-count extraction. Returns `{ tokensIn, tokensOut }`.                                         |
| `normalizeError(err)` | fn       | yes      | Strips URL / headers / body / query params. Returns `{ status, message }`. See R11.                                  |

### 2.2 Error contract

Every provider's invoke function MUST throw `ProviderError` (defined in
[`server/lib/provider/errors.mjs`](../../server/lib/provider/errors.mjs)).
Single class for all upstream LLM errors so callers and metrics get a uniform
shape:

```js
export class ProviderError extends Error {
  constructor({ class: errClass, provider, status, message, retryable, cause }) {
    super(message);
    this.name = 'ProviderError';
    this.class = errClass;       // 'PROVIDER_CONFIG' | 'PROVIDER_UPSTREAM' | 'PROVIDER_RATELIMIT'
    this.provider = provider;    // 'openai' | 'anthropic' | ...
    this.status = status;        // HTTP status if any (e.g. 401, 429, 500)
    this.retryable = retryable;  // boolean — true for 429 + 5xx; false for 4xx config errors
    this.cause = cause;          // original SDK error (already passed through normalizeError)
  }
}
```

| Class                | When                                                              | retryable | Maps to v0.6 envelope        |
|----------------------|-------------------------------------------------------------------|-----------|------------------------------|
| `PROVIDER_CONFIG`    | 401/403, missing key, key format invalid, model unsupported       | false     | `INPUT_INVALID`              |
| `PROVIDER_UPSTREAM`  | 5xx, network error, timeout                                       | true      | `UPSTREAM_FAILURE`           |
| `PROVIDER_RATELIMIT` | 429                                                               | true      | `UPSTREAM_FAILURE` (sub-class)|

Surface code (`summarize.mjs`, etc.) catches `ProviderError`, increments the
matching `um_provider_errors_total{error_class}` metric, and propagates through
the v0.6 envelope. Provider modules NEVER throw raw SDK errors — they always
wrap into `ProviderError` with `cause` set to the normalized SDK error.

The provider module is the *only* place provider-specific logic lives. Surface
modules (`summarize.mjs`, `embed.mjs`, `facts.mjs`) iterate the registry; they
never `if (provider === 'openai')`.

---

## 3. Per-surface support matrix

Cross-reference each provider's `supports` field. Keep this table in sync if
adding a provider — it is also derivable at runtime via
`supportingProviders(surface)` in [`server/lib/provider/registry.mjs`](../../server/lib/provider/registry.mjs).

| Provider    | embeddings | summarizer | facts | Notes                                                                       |
|-------------|------------|------------|-------|-----------------------------------------------------------------------------|
| `openai`    | yes        | yes        | yes   | Default for all three surfaces.                                              |
| `anthropic` | **no**     | yes        | yes   | No first-party embeddings API; `embedderConfig` is literal `null`.           |
| `google`    | yes        | yes        | yes   | Three-key precedence (see §6).                                               |
| `ollama`    | yes        | yes        | yes   | Local; no API keys; `skipModelValidation: true` (Adv-5 exemption).            |

A provider with `supports.<surface> === false` MUST NOT appear in that
surface's registry. Tests in `embed.test.mjs` / `facts.test.mjs` /
`summarize.test.mjs` enforce this by walking `supportingProviders(surface)` and
asserting `BACKENDS[name]` presence/absence.

---

## 4. Tests auto-included

Surface tests use the **registry-loop pattern** to exercise every provider that
declares correct registry entries. You do NOT write per-provider boilerplate
tests; you only add a focused test file for provider-specific edge cases.

The pattern, from [`server/test/embed.test.mjs`](../../server/test/embed.test.mjs):

```js
import { EMBEDDING_BACKENDS, getEmbedderConfig } from '../lib/embed.mjs';
import { providers, supportingProviders } from '../lib/provider/registry.mjs';

test('EMBEDDING_BACKENDS contains every provider with supports.embeddings===true', () => {
  for (const [name, p] of Object.entries(providers)) {
    if (p.supports?.embeddings) {
      assert.ok(EMBEDDING_BACKENDS[name], `missing ${name}`);
    } else {
      assert.equal(EMBEDDING_BACKENDS[name], undefined, `${name} should not be in embedding backends`);
    }
  }
});

for (const name of Object.keys(EMBEDDING_BACKENDS)) {
  test(`${name}: embedderConfig returns mem0 config block`, () => {
    // ... shared contract assertions run for every registered provider
  });
}
```

Same pattern in `facts.test.mjs` (loops `Object.keys(FACTS_BACKENDS)`) and
`summarize.test.mjs` (loops `Object.keys(BACKENDS)`). When you register a new
provider correctly, these tests automatically cover its contract surface on the
next CI run. If your provider fails one of these loops, the failure is in the
registry entry or contract export — not the test.

---

## 5. Pricing

Add an entry to `PRICING` in [`server/lib/pricing.mjs`](../../server/lib/pricing.mjs).
Required fields per model:

```js
'gpt-4o-mini': { in: 0.00015, out: 0.00060, type: 'chat' },
'text-embedding-3-small': { in: 0.00002, out: 0, type: 'embed', dim: 1536 },
```

| Field           | Type                              | Notes                                                               |
|-----------------|-----------------------------------|---------------------------------------------------------------------|
| `in`            | number                            | USD per 1k INPUT tokens.                                            |
| `out`           | number                            | USD per 1k OUTPUT tokens. `0` for embedding-type entries.            |
| `type`          | `'chat'` \| `'embed'` \| `'unknown'`| Determines cost-attribution direction.                              |
| `dim`           | number                            | Vector dimension. **Required for `type: 'embed'`**, omitted for chat.|
| `last_verified` | ISO date or `'n/a'`               | Per-provider field, applies to all models in that block.             |

**Units convention:** ALL rates are USD per 1k tokens. `computeCost` divides
token counts by 1000 before multiplying. If you ever change the unit basis,
update both `PRICING` and `computeCost` in lockstep.

### 5.1 `last_verified` discipline (R7)

Each provider entry carries one `last_verified` ISO date. The day you copy a
rate from the provider's published pricing page, set `last_verified` to that
day's ISO date.

[`server/test/pricing.test.mjs`](../../server/test/pricing.test.mjs) walks
`PRICING[*].last_verified` and **warns (does not fail)** if any entry is more
than 90 days old. The advisory surfaces the maintenance signal in CI without
blocking releases — pricing changes are doc updates, not architecture.

**Scope clarification (R7):** the staleness check is date-based only. It
cannot detect upstream model removals (e.g. a provider deprecating a model and
removing the rate). Model-removal is detected reactively via DE7
`validateModelExists` (refuses startup if the env model is absent from
`PRICING`) and provider 401/404 errors at runtime.

For self-hosted providers without published rates (e.g. Ollama), use
`last_verified: 'n/a'` and an empty `models: {}` map.

---

## 6. API key conventions

The standard precedence is `UM_<P>_API_KEY || <P>_API_KEY` — UM-prefixed wins
to allow power users to override a global env var (used by other tools) with a
UM-specific key. This is encoded in each provider's `requires` array; iteration
order is the precedence order.

| Provider    | `requires` (precedence top-to-bottom)                              |
|-------------|--------------------------------------------------------------------|
| `openai`    | `['UM_OPENAI_API_KEY', 'OPENAI_API_KEY']`                          |
| `anthropic` | `['UM_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY']`                    |
| `google`    | `['UM_GOOGLE_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']`        |
| `ollama`    | `[]` (local; no auth)                                              |

### 6.1 Google's three-key precedence

Google is the one special case. Per [`server/lib/provider/google.mjs`](../../server/lib/provider/google.mjs)
(Feas-4 from review loop), three keys are checked in order:

1. `UM_GOOGLE_API_KEY` — UM-prefixed wins (override for power users).
2. `GOOGLE_API_KEY` — standard Google env var.
3. `GEMINI_API_KEY` — alternate Google key name; honoured because the Gemini
   ecosystem has historically used this name.

`resolveApiKey(env)` walks the `requires` array and returns the first
non-empty value. Tests assert each key wins at its precedence position when
higher-precedence keys are absent.

### 6.2 Key-format validation

`validateKeyFormat(key)` is a string-prefix check used by the wizard before
making any network call. Examples:

| Provider    | Prefix      |
|-------------|-------------|
| `openai`    | `sk-`       |
| `anthropic` | `sk-ant-`   |
| `google`    | `AIza`      |
| `ollama`    | `true` (no key) |

Format failures map to `PROVIDER_CONFIG`.

### 6.3 normalizeError redaction (R11)

`normalizeError(err)` is the leak-prevention surface. Use a **whitelist-only**
approach: return `{ status, message }` and nothing else. Critically:

- Do not include `config` (Google's SDK puts the API key in `config.url`'s
  `?key=AIza-...` query string AND `config.params.key`).
- Do not include `request` or `response` (may carry headers).
- Do not include the original `err` object.

The contract is enforced by per-provider `normalizeError` tests asserting that
sensitive substrings are absent from the returned object's JSON serialisation.

---

## 7. Where to look for examples

The canonical reference is [`server/lib/provider/openai.mjs`](../../server/lib/provider/openai.mjs).
It is the cleanest implementation of every export in the contract, supports
all three surfaces, and is the test fixture every other provider was modelled
on.

Secondary references for special cases:

| Want to see...                                              | Read                                                                                          |
|-------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| Surface unsupported (`embedderConfig = null`)               | [`server/lib/provider/anthropic.mjs`](../../server/lib/provider/anthropic.mjs)                |
| Three-key precedence + redaction-heavy `normalizeError`     | [`server/lib/provider/google.mjs`](../../server/lib/provider/google.mjs)                      |
| No-auth local provider, `skipModelValidation`, model probe  | [`server/lib/provider/ollama.mjs`](../../server/lib/provider/ollama.mjs)                      |
| Registry shape and `supportingProviders(surface)` lookup    | [`server/lib/provider/registry.mjs`](../../server/lib/provider/registry.mjs)                  |
| `ProviderError` class + error taxonomy                      | [`server/lib/provider/errors.mjs`](../../server/lib/provider/errors.mjs)                      |
| Registry-loop test pattern                                  | [`server/test/embed.test.mjs`](../../server/test/embed.test.mjs)                              |

When in doubt, copy `openai.mjs`, rename the exports, swap the SDK calls, and
run the registry-loop tests. If they pass, you are done with steps 1–6 of the
checklist.
