# Deferred to v0.4

Task F2 of the v0.3 cross-platform plan — OpenAI Agents SDK example paralleling [`../openai-assistants/`](../openai-assistants/) — was deferred from v0.3.0-alpha.

## Why

Two pieces of evidence surfaced during Phase F:

1. **The Assistants API (F1's target) is deprecated.** Both `openai-node` 6.x and `openai-python` 2.x emit deprecation warnings on every Assistants call. OpenAI's posted successor is the **Responses API**, not the Agents SDK.
2. **Agent SDK stability wasn't confirmed** during the Phase F session. A confident F2 needs a live check of the SDK's custom-tool surface (signature shape, event loop semantics), and that check didn't happen this session.

Shipping a speculative example against a moving target violates this repo's "no untested code" rule (see F1's smoke-tested README — `Known issues` section is that discipline in action).

## What lands in v0.4 instead

Probably *not* an Agent SDK example. The realistic next OpenAI-side example is a **Responses API** variant — same flow as F1 but using the non-deprecated call surface. That matches where OpenAI is pushing users. Agent SDK becomes a separate, later decision gated on: (a) is the SDK stable enough to be worth documenting? (b) do developers asking about UM also reach for the Agent SDK, or do they stay on Assistants/Responses?

## See also

- [`../openai-assistants/README.md`](../openai-assistants/README.md) §Known issues — the Assistants API deprecation that triggered this deferral.
- `docs/codex-integration-notes.md` — parallel research discipline (E1 deferred Codex hooks to v0.4 for different upstream-stability reasons).
