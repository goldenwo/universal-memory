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

### §5.1 Anthropic article reference

Spec §2.3 references Anthropic's code-exec-with-MCP article: [https://www.anthropic.com/engineering/code-execution-with-mcp](https://www.anthropic.com/engineering/code-execution-with-mcp).

Article's actual argument: agents should write code that calls MCP tools rather than calling tools directly — enabling progressive tool discovery, in-environment data filtering, and state persistence inside the execution environment. The article's headline result (150K → 2K tokens, 98.7% reduction) came from a Google-Drive-to-Salesforce workflow where large data payloads previously passed through the model context twice; code execution let that filtering happen in the exec environment. The article does not advocate for collapsing multiple MCP tools into a single "exec" schema entry to save schema-listing tokens.

**Applicability to UM v0.4:** The article targets a different problem (data-plane efficiency inside agent-authored code) than UM's schema-token budget. Collapsing UM's 6 write tools into a single `memory_exec` would be a schema-trimming strategy the article doesn't actually advocate. The article's recommended pattern (agent writes code → code calls individual MCP tools) preserves the individual tool schemas and explicitly loads them on demand — the opposite of schema consolidation.

### §5.2 Write-tool schema token math

Measured from `server/test/token-cost-baseline.txt` (Task 0.3):

| Tool | tiktoken | anthropic |
|---|---|---|
| memory_add | 49 | 51 |
| memory_delete | 30 | 30 |
| memory_capture | 149 | 156 |
| memory_forget | 64 | 68 |
| memory_supersede | 152 | 161 |
| memory_checkpoint | 58 | 59 |
| **Sum (writes)** | **502** | **525** |

(Compare: spec §5.2.2 estimate of ~2.3 KB character-size; measured tiktoken sum is 502 tokens ≈ ~2.0 KB at ~4 chars/token. Spec estimate is consistent with the measured figure.)

### §5.3 Hypothetical memory_exec schema cost

A replacement `memory_exec(operation, args)` schema would describe an `operation` enum with ~6 values (add, delete, capture, forget, supersede, checkpoint) plus a generic `args` object. Estimated cost: ~100–150 tiktoken (~0.5 KB char-size). Using 125 tiktoken as the midpoint estimate.

### §5.4 Net savings analysis

- **Writes-enabled mode (opt-in):** savings = sum(writes) − memory_exec = 502 − 125 ≈ **377 tiktoken (~1.5 KB)**. (Spec estimated ~1.8 KB char-size; measured tiktoken math gives a consistent result.)
- **Writes-disabled mode (default after B.3):** savings = **0** — B.3 removes write schemas from listTools entirely, so there are no write-tool schemas present to consolidate.

### §5.5 Conclusion

**B.2 does NOT ship in v0.4.** Rationale:

- In the default configuration (writes-disabled after B.3), there is nothing to save — write schemas are already absent from listTools.
- In the opt-in writes-enabled configuration, the ~377-token (~1.5 KB) savings is real but small, and it benefits only users who explicitly enabled writes.
- The complexity cost of designing and validating `memory_exec` is non-trivial: operation dispatch, argument validation, error surface, and schema documentation all need work.
- B.3 schema-hygiene captures the realistic win for the default path; users who need writes can tolerate the current 6-tool surface.
- The Anthropic article cited in §2.3 does not support this approach — its pattern preserves individual tool schemas and uses code to call them selectively.

**`memory_exec` remains a post-v0.4 option** if Phase 0 discovers a surprise use case (unlikely) or if the writes-enabled surface becomes common enough to justify the schema collapse.

## 6. CLI canonical name decision

### §6.1 Targets checked

**Target A — Git Bash (Windows 11, this machine):**

```
=== which um ===
which: no um in (/c/Users/wogol/bin:/mingw64/bin:/usr/local/bin:/usr/bin:/bin:...)
exit: 1

=== type um ===
bash: type: um: not found
exit: 1

=== command -v um ===
(no output)
exit: 1

=== um --version ===
bash: um: command not found
exit: 127
```

Result: **no `um` binary found** anywhere on the Git Bash PATH (surveyed ~40 entries including system32, nvm, Docker, GitHub CLI, Tailscale, Claude plugins, etc.).

---

**Target B — Ubuntu (via Docker):**

Ubuntu 24.04 (`docker run --rm ubuntu:24.04`):

```
--- which ---
exit: 1
--- type ---
bash: type: um: not found
exit: 1
--- command -v ---
exit: 1
--- um --version ---
bash: um: command not found
exit: 127
--- apt-cache search (^um$, default repos) ---
(no output)
```

Ubuntu 22.04 (`docker run --rm ubuntu:22.04`):

```
--- which ---
exit: 1
--- type ---
exit: 1
--- command -v ---
exit: 1
--- um --version ---
bash: um: command not found
exit: 127
--- apt-cache search (^um$, universe + multiverse enabled) ---
(no output — no package literally named 'um' exists)
```

Additional apt investigation (22.04 with universe + multiverse enabled): `apt-cache search "^um$"` returns nothing. There is a `umview` package ("View-OS in user space") in universe, but:
1. The binary is `umview`, not `um`.
2. It is NOT installed by default on any Ubuntu image.
3. It is a completely separate project (user-mode virtual filesystem).

Result: **no default-installed `um` binary** on Ubuntu 22.04 or 24.04. No apt package named `um` in default or universe/multiverse repos.

---

**Target C — macOS (via Homebrew formulae API):**

```
=== formula (https://formulae.brew.sh/api/formula/um.json) ===
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 3408

curl exit: 0

Formula details:
  name: um
  full_name: um
  tap: homebrew/core
  desc: Command-line utility for creating and maintaining personal man pages
  homepage: https://github.com/sinclairtarget/um
  versions: stable=4.2.0
  keg_only: False
  dependencies: [ruby]
  install analytics (30d/90d/365d): 9 / 12 / 42

=== cask (https://formulae.brew.sh/api/cask/um.json) ===
HTTP/1.1 404 Not Found

curl exit: 22
```

A Homebrew formula named `um` EXISTS in `homebrew/core` (v4.2.0, "Command-line utility for creating and maintaining personal man pages"). It is a Ruby CLI for managing personal man pages (a different project from Universal Memory). It is:
- NOT default-installed on macOS (requires explicit `brew install um`)
- Very low usage: 42 installs over 365 days
- NOT keg-only (would land on PATH if installed)

macOS default tools at `/usr/bin/`, `/bin/`, `/usr/local/bin/`: no `um` binary ships with any macOS version (well-known Apple utility list does not include `um`).

Result: **no default-installed `um` binary on macOS**. Latent conflict exists (Homebrew formula with 42 installs/year) but is NOT install-by-default.

---

### §6.2 Conflict analysis

| Target | Default installed? | Apt/Brew available? | Conflict type |
|--------|-------------------|---------------------|---------------|
| Git Bash (Windows 11) | NO | N/A | None |
| Ubuntu 22.04 (Docker) | NO | NO (no package named `um`) | None |
| Ubuntu 24.04 (Docker) | NO | NO (no package named `um`) | None |
| macOS (Homebrew) | NO | YES (`homebrew/core`, 42 installs/yr) | Latent only |

Summary: `um` is not installed by default on any of the three targets. The only potential friction is the existing `homebrew/core` formula `um` (personal man pages CLI), which a small number of macOS users (~42/year) install explicitly. Users who install Universal Memory alongside that formula would have a PATH collision they'd need to resolve by uninstalling the other `um` or using explicit paths.

This is a known and acceptable risk for a short CLI name. It is not a default conflict.

### §6.3 Decision

**Locked canonical name: `um`**

Rationale:
1. No default-installed binary named `um` exists on any checked target (Windows/Git Bash, Ubuntu 22.04, Ubuntu 24.04, macOS).
2. The Homebrew formula `um` (personal man pages) is a latent conflict only — 42 installs in the past 365 days across all Homebrew users. The realistic overlap between that user base and Universal Memory CLI users is near zero. Users who do have both installed can `brew uninstall um` or alias to resolve.
3. Per the task spec: "A package being AVAILABLE but not installed-by-default does NOT count as a conflict." This applies to the Homebrew formula.
4. `um` is the correct canonical name. No rename to `umem` is needed.

N/A: name-propagation enumeration (MEDIUM punchlist item) — only required if `umem` is chosen.

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
