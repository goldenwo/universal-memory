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

### §4.1 Question
Would serving ETag / 304 responses on `/api/state/{project}` meaningfully reduce SessionStart token cost?

### §4.2 Server-side capability (experiment)
Throwaway branch `phase-0-etag-experiment` (based on `1523c01`) added ETag = sha1(mtime:size) + 304 handling to the `/api/state/:project` handler in `server/mem0-mcp-http.mjs`.

Changes:
- Import `createHash` from `node:crypto` and `statVaultFile` from `./lib/vault.mjs`
- Before reading the file: `stat` → `sha1("${mtime.getTime()}:${size}")` → `ETag: "<hash>"`
- If `If-None-Match` matches: return `304` with no body
- If no match (or no file): return `200` with `ETag` header set

Server-side logic was verified via a standalone Node unit test (live server start was not performed due to the server requiring OPENAI_API_KEY + Qdrant warmup before `server.listen()` is called — the `/api/state` handler does not touch mem0, but the bootstrap sequence gates server startup on mem0 init). Unit test output:

```
File mtime: 2026-04-21T12:36:19.422Z
File size: 147 bytes
ETag: "233006fab0ec62f13fdc0996f4ff15b090bf2b08"
ETag matches (deterministic): true
Different mtime → different ETag: true
Matching If-None-Match → HTTP 304
Mismatched If-None-Match → HTTP 200

All ETag logic verified correctly.
```

The server-side code is correct: ETag is emitted on 200, 304 is returned when `If-None-Match` matches.

### §4.3 Client-side reality
`plugins/claude-code/universal-memory/hooks/session-start.sh` uses:

```bash
response=$(curl -sfm 3 "$endpoint/api/state/$PROJECT" 2>/dev/null || echo '{}')
```

Flags: `-s` (silent), `-f` (fail on HTTP error), `-m 3` (3-second timeout). Grep for `If-None-Match`, `etag`, `ETag`, `cache`, or `conditional` in the script: **no matches**. The client never sends a conditional request and has no mechanism to store or re-send an ETag value between sessions. Any server-side ETag is emitted but never consumed.

### §4.4 CC internal HTTP layer (`additionalContext`)

Best-effort investigation — 4 targeted searches performed.

**Search 1:** Web search `"claude Code hooks additionalContext HTTP ETag If-None-Match 304 caching 2026"` → returned the Claude Code hooks reference page and RFC/MDN ETag docs. The hooks reference was not found to discuss ETag/304/caching at all.

**Search 2:** WebFetch of `https://code.claude.com/docs/en/hooks` with ETag/caching prompt → The hooks doc shows HTTP hook invocations as fire-and-forget POST requests. Response handling covers only 2xx (JSON body parsed) vs non-2xx (non-blocking error). No mention of ETag, If-None-Match, 304, or HTTP cache validation anywhere in the spec.

**Search 3:** Web search `"claude code" additionalContext HTTP cache conditional request hook optimization` → Results surfaced issues about Anthropic **API-level prompt caching** (KV cache/5-minute TTL) — a completely different caching system from HTTP ETag. No mention of HTTP conditional requests in hook execution.

**Search 4:** Web search `site:github.com anthropics/claude-code additionalContext ETag cache hook response` → Results were all about `additionalContext` field behavior (injection ordering, duplication bug, PreToolUse support). Zero hits for ETag, If-None-Match, or HTTP-layer caching in CC's hook execution path.

**Finding:** No public evidence found that Claude Code's internal HTTP layer caches hook responses via ETag / If-None-Match / 304. The hooks documentation explicitly describes each HTTP hook call as a fresh request with simple 2xx/non-2xx error handling. Treat as non-caching for v0.4 feasibility purposes.

### §4.5 Conclusion
ETag is not productive in v0.4. The injection path is a shell `curl` in `session-start.sh` without conditional-request support, and there is no public signal that CC's internal HTTP layer caches hook responses via ETag. The server-side implementation is correct and functional, but it would sit permanently unused given the current client.

Defer to ROADMAP v0.5+; revisit only if:
- `session-start.sh` is rewritten to store the last ETag on disk and send `If-None-Match` on subsequent requests, OR
- CC adopts a cached-hook-response model with ETag support upstream.

Throwaway branch `phase-0-etag-experiment` deleted (Step 5).

## 5. Code-exec-with-MCP spike

_To be filled by Task 0.7._

## 6. CLI canonical name decision

_To be filled by Task 0.6._

## 6b. Vault-as-git signal — A.9 conditional gate

### §6b.1 Signal check

Ran `[ -d "$UM_VAULT_DIR/.git" ] && echo PRESENT || echo ABSENT` on the authoring machine:

- Resolved `$UM_VAULT_DIR` path: `/c/Users/wogol/.um/vault` (source: `$UM_VAULT_DIR` unset; derived via `vault.sh` default `$HOME/.um/vault`)
- Vault directory exists: YES (contains `authored/`, `captures/`, `sessions/`, `state/`)
- Result: **ABSENT**

### §6b.2 Decision

- **PRESENT:** A.9 `um validate` SHIPS as the 8th daily-use subcommand. Phase A headline: 8 subcommands.
- **ABSENT / VAULT_NOT_FOUND:** A.9 `um validate` DROPS. Phase A headline: 7 subcommands. Plan orientation "outcome 2" updated accordingly.

**Locked call for v0.4:** DROPS — the authoring vault at `/c/Users/wogol/.um/vault` has no `.git` directory. The vault-as-git signal is ABSENT; `um validate` has no meaningful git-aware semantic to expose. Phase A ships 7 subcommands.

## 7. Phase 0 decisions — go/no-go per downstream gate

_To be filled by Task 0.8._
