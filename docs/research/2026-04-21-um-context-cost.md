---
title: UM context-cost measurement + v0.4 Phase 0 investigations
date: 2026-04-21
status: research (feeds v0.4 Phase 0 gates)
---

# Summary

_To be filled by Task 0.8 after all Phase 0 investigations complete._

## 1. Token-cost map (6 locations, numbers)

_Baseline captured by Task 0.3 at `server/test/token-cost-baseline.txt`. Final numbers + interpretation by Task 0.8._

## 2. Tokenizer methodology + effective thresholds

_To be filled by Task 0.8. LOCK: effective ≥2.5K threshold (see Step 1b of Task 0.8)._

## 2b. Apideck API surface cross-reference

_To be filled by Task 0.8 (Step 1c)._

## 3. SessionStart injection boundary

### §3.1 What UM's session-start.sh injects

`plugins/claude-code/universal-memory/hooks/session-start.sh` makes exactly **one** HTTP call to the UM server, on line 179:

```bash
response=$(curl -sfm 3 "$endpoint/api/state/$PROJECT" 2>/dev/null || echo '{}')
```

Flags: `-s` (silent), `-f` (fail on HTTP error), `-m 3` (3-second timeout). No other `curl` or `/api/` call exists in the script.

The response body is piped into an inline Python block that applies staleness rules and writes the final `{"additionalContext": "..."}` JSON to stdout. Claude Code consumes this stdout as the `additionalContext` for the session. The injected string is:

- state.md body (verbatim when age ≤ 7 days, prefixed when 7–30 days, omitted when > 30 days or missing valid_from)
- followed by the memory-routing rubric (always appended)
- preceded by a first-session welcome banner (only on the very first-ever session)

No other endpoint is called. There is no `/api/search`, `/api/captures`, or any other HTTP call in session-start.sh.

**Task 0.3 baseline (L3, `server/test/token-cost-baseline.txt`):**

| Fixture | tiktoken | anthropic | chars |
|---------|----------|-----------|-------|
| state.md body | 998 | 1067 | 3720 |
| /api/state envelope (body + JSON overhead) | 1072 | 1134 | — |

The anthropic figure (1067 tokens) is the CC-consumed budget for a representative active v0.4 project state.

### §3.2 What mem0-pi injects (NOT UM)

The user's global CC config at `~/.claude/CLAUDE.md` configures the mem0-pi MCP server independently of UM. The relevant passage (verbatim):

> **On session start:** A `SessionStart` hook auto-injects the top-10 most relevant mem0 facts for the current project into context. You usually do not need to call `memory_search` immediately — read the injected block first.

This injection is owned entirely by the user's global `CLAUDE.md` and the `mem0-pi` MCP server running on `pi-openclaw`. UM's server has no visibility into this injection: it does not know which facts were selected, how many tokens they consume, or when the injection occurs relative to UM's own `additionalContext` emission.

Conclusion: mem0-pi injection is a CC-side configuration outside UM's control. UM's `/api/state` call and mem0-pi's top-10 injection are two independent hooks that both contribute context at session start; neither is aware of the other.

### §3.3 Dedup feasibility

Could UM deduplicate between its state.md injection and mem0-pi's top-10 fact injection? Analysis:

1. **No shared pre-inject handshake.** UM's session-start.sh calls `/api/state` and exits before mem0-pi fires (or vice-versa — ordering is CC-internal). There is no synchronization point between them.

2. **UM cannot read the mem0 store.** Dedup would require UM to query the user's mem0 database and compare its state.md content against the top-10 results. This would require mem0 credentials, Pi network access, and a semantic diff — all out of scope for UM's server role and violating the boundary between the two systems.

3. **CC does not expose cross-hook dedup.** CC's hook protocol emits `additionalContext` independently per hook; CC does not provide a mechanism for one hook to inspect or suppress another hook's output.

4. **Even if overlap occurs, it is low-cost.** The state.md injection (~1067 anthropic tokens) and the mem0 top-10 facts are drawn from different data stores (UM vault vs. mem0-pi DB). Structural overlap is unlikely. Any semantic overlap (e.g., a fact also mentioned in state.md) wastes at most a few tokens.

**Decision: no server-side dedup feasible in v0.4.** This is the expected outcome. Defer any cross-system dedup to v0.5+ if and when mem0-pi becomes a UM-integrated surface and a formal dedup protocol can be designed.

### §3.4 Implication for v0.4 threshold analysis

UM's session-start.sh injection (~998/1067 tokens for state.md body) is the **only context UM controls** at session start. Key implications:

- This ~1K injection is below the effective 2.5K Phase 0 threshold established in the v0.4 plan (§5.1 design principles). State.md injection alone is **not a primary optimization target**.

- The larger context-cost levers within UM's control are:
  - **MCP tool schemas** (Task 0.3 L1: 769/798 tokens — B.3 schema hygiene target): 10 tools × avg ~77/80 tokens each; schema pruning here has broader impact across all surfaces.
  - **MCP response payloads** (Task 0.3 L2: 884–1386 tokens per search/list — B.1 compact shape target): these are consumed on every tool call, not just session start, making them the highest-leverage target.

- Any future session-start.sh changes (e.g., rubric injection trimming, staleness window tuning) should be driven by multi-surface mem0 dedup becoming a concrete cross-cutting initiative, not by optimizing UM's ~1K state injection in isolation.

- **Defer session-start.sh changes to v0.5+** when/if mem0-pi becomes a UM-integrated surface.

## 4. ETag feasibility

_To be filled by Task 0.5._

## 5. Code-exec-with-MCP spike

_To be filled by Task 0.7._

## 6. CLI canonical name decision

_To be filled by Task 0.6._

## 6b. Vault-as-git signal — A.9 conditional gate

_To be filled by Task 0.5b._

## 7. Phase 0 decisions — go/no-go per downstream gate

_To be filled by Task 0.8._
