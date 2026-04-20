---
title: MCP vs API/CLI — does v0.4 pivot?
date: 2026-04-20
status: research
budget_used: 13 WebFetch/WebSearch calls
---

# MCP vs API/CLI — does v0.4 pivot?

## 1. TL;DR

The "industry is shifting away from MCP" framing is **overstated**. What actually happened in Q1 2026 is a measured pullback by *specific teams* (Perplexity, individual power users) who found MCP's context-window cost and auth friction too high for *their specific production workloads* — while Anthropic, AWS, Microsoft, Google, OpenAI, and Cloudflare simultaneously moved MCP into the Linux Foundation and doubled down on it as the cross-vendor standard. For UM — a cross-surface memory server whose value proposition **is** the protocol-level commonality — MCP remains load-bearing, but the critiques are real and UM should treat them as a design constraint, not a dismissal. **Recommendation: HYBRID-REBALANCE for v0.4 (confidence: medium-high).** Keep MCP as the primary surface, but promote REST and the `um-*` CLI from "also-ran" to "equal peer," and adopt the code-execution-with-MCP pattern to pre-empt the context-bloat critique.

## 2. Source verification

**The user said "Brian Tan, Y Combinator CEO." That person does not exist as stated.** The actual YC CEO in 2026 is **Garry Tan** (first-name mixup). Confirmed via multiple sources including YC's own people page and a February 2026 Mission Local article on YC political activity.

**The Tan → MCP/CLI claim itself is a telephone game:**

- Tan's actual March 12, 2026 viral post ([gstack](https://github.com/garrytan/gstack), [X post](https://x.com/garrytan/status/2032014570118922347)) is about a Claude Code **skills** bundle (23 opinionated `skill.md` files acting as CEO / designer / eng manager / QA), not a CLI-over-MCP manifesto. TechCrunch's coverage confirms gstack is skills-based and makes **no comparison to MCP at all**.
- Secondary reporting (Houdao, Awesome Agents) compressed this into "YC President lead shift to APIs and CLIs" — which misrepresents Tan's actual statement. The real "lead" here is **Denis Yarats, co-founder/CTO of Perplexity**, who announced at Ask 2026 (March 11, 2026) that Perplexity is moving its internal/production workloads off MCP to a unified Agent API. Perplexity still runs an MCP server for external developers.
- No direct quote from Tan criticizing MCP was found in 13 search/fetch calls. The Tan signal is **weak and likely misattributed**. The Yarats signal is the real one.

**Primary quote sources** (closest available; no fully-transcribed Ask 2026 recording surfaced):
- [Perplexity CTO Moves Away from MCP Toward APIs and CLIs (Awesome Agents, Mar 2026)](https://awesomeagents.ai/news/perplexity-agent-api-mcp-shift/)
- [Threads post by @sandro.ieva summarizing the Ask 2026 announcement](https://www.threads.com/@sandro.ieva/post/DVxrr3IDXq0/)
- [Perplexity Ditches MCP: 72% Context Waste (byteiota, Mar 2026)](https://byteiota.com/perplexity-ditches-mcp-72-context-waste-kills-protocol/) — cites Apideck deployment data but without a direct link

## 3. Signal landscape

### 3a. Pushback signals (the user's thesis)

- **Perplexity, March 11, 2026**: Denis Yarats announces internal shift off MCP; launches [Agent API](https://docs.perplexity.ai/docs/agent-api/overview) — single endpoint, one API key, OpenAI-compatible syntax, routes to OpenAI/Anthropic/Google/xAI/NVIDIA. Public MCP server still maintained for external devs. ([source](https://awesomeagents.ai/news/perplexity-agent-api-mcp-shift/))
- **"72% context waste" claim**: Apideck-documented deployment where 3 MCP servers consumed 143K of 200K tokens. Versalence independently cites "7 MCP servers: 67,300 tokens / 33.7% of 200K"; "GitHub MCP server alone: ~25% of Claude Sonnet's context." ([source](https://blogs.versalence.ai/mcp-model-context-protocol-evolution-2026))
- **Loud-critique blog posts**: Eric Holmes's ["MCP is dead. Long live the CLI"](https://ejholmes.github.io/2026/02/28/mcp-is-dead-long-live-the-cli.html) (Feb 2026), Jannik Reinhard's [CLI-vs-MCP piece](https://jannikreinhard.com/2026/02/22/why-cli-tools-are-beating-mcp-for-ai-agents/), Excalibur's [Medium piece](https://medium.com/@primeexcalibur/mcp-is-losing-the-production-war-heres-why-cli-and-agent-apis-are-winning-cd7d306170ec) (Mar 2026). Common themes: debuggability (pipe to `jq`), reliability (MCP servers crash), composition (shell pipes beat JSON-RPC).
- **Garry Tan gstack**: skills-based, not CLI-based, and makes no anti-MCP argument — but the fact that a YC-CEO-level power-user reaches for skills over MCP for his personal Claude Code setup is itself a data point that MCP is not the obvious default for single-user productivity. ([gstack](https://github.com/garrytan/gstack), [TechCrunch](https://techcrunch.com/2026/03/17/why-garry-tans-claude-code-setup-has-gotten-so-much-love-and-hate/))

### 3b. Entrenchment signals (the counter-thesis)

- **MCP → Linux Foundation, Dec 2025 / Mar 2026**: Anthropic donated MCP to the new Agentic AI Foundation. Co-founded with Block and OpenAI; backed by Google, Microsoft, AWS, Cloudflare, Bloomberg. ([source 1](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation), [source 2](https://mcpproxy.app/blog/2026-03-21-mcp-linux-foundation-gateways/)) This is the opposite of a protocol in decline — major vendors do not donate dying protocols.
- **Adoption numbers (Q1 2026)**: MCP SDK at **97M monthly downloads** (from 100K at launch = 970x growth). **17,468 MCP servers** indexed across registries (Nerq census). Remote MCP servers up **~4x since May 2025**. ([source](https://mcpmanager.ai/blog/mcp-adoption-statistics/), [source](https://effloow.com/articles/mcp-ecosystem-growth-100-million-installs-2026))
- **Vendor commitments (April 2026)**: [AWS "all-in on MCP"](https://aws.amazon.com/blogs/opensource/shaping-the-future-of-mcp-aws-commitment-and-vision/). Microsoft shipped Agent Framework 1.0 with MCP built in, long-term support commitment. OpenAI Responses API has shipped remote MCP support (GPT-4o, GPT-4.1, o-series); ChatGPT Developer Mode has full MCP client support. ([source](https://openai.com/index/new-tools-and-features-in-the-responses-api/), [source](https://platform.openai.com/docs/mcp))
- **Anthropic's own response**: The [code-execution-with-MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern (presenting MCP servers as filesystems of code APIs that agents discover on-demand) reportedly cuts token consumption **~98.7%** (150K → 2K). Anthropic explicitly acknowledges the context-bloat critique and ships a mitigation rather than deflecting.
- **Balanced commentary**: [Charles Chen's "MCP is Dead; Long Live MCP!"](https://chrlschn.dev/blog/2026/03/mcp-is-dead-long-live-mcp/) — argues the distinction is stdio-local vs HTTP-centralized: single-user CLI tooling doesn't need MCP, but org/cross-surface delivery does. [Tobias Pfuetze's "The MCP vs CLI Debate Is the Wrong Fight"](https://medium.com/@tobias_pfuetze/the-mcp-vs-cli-debate-is-the-wrong-fight-a87f1b4c8006) — "The right architecture is not determined by which protocol is theoretically superior. It is determined by who your users are, what environment they operate in, and where they actually are on the adoption curve."

### 3c. Reading the signal

This is **not** a protocol abandonment. It is a hype-cycle correction. MCP is simultaneously (a) becoming permanent infrastructure via the Linux Foundation and (b) losing its "the answer to everything" halo as production teams discover where it's the wrong tool (single-user CLI productivity; tight-latency inner-loop agent tool-use). That split matters for UM: UM's use case — durable, cross-surface, cross-device memory — is the use case MCP was actually designed for. UM is *not* in the category of workload Perplexity moved off MCP to serve.

## 4. Critique map — does each critique apply to UM?

| Critique | Applies to UM? | Why |
|---|---|---|
| Context-window bloat from tool schemas | **Partial** | UM exposes 10 tools (~mid-sized). Not a top offender (GitHub MCP at 25% is far worse) but not negligible. **Fixable** via (a) trimming the write tools from the always-loaded surface when `UM_MCP_WRITE_ENABLED=false`, (b) a code-execution pattern where UM exposes a single `um_run` entrypoint that loads tool specs on demand. |
| Authentication friction / OAuth complexity | **No** | UM is a self-hosted single-user server. No OAuth delegation, no cross-org auth. The critique targets enterprise federation scenarios UM doesn't touch. |
| Connection lifecycle / MCP servers failing to start | **Partial** | UM is an HTTP server, not stdio-per-client — this class of bug (Claude Code stdio flakiness) does not apply. But SSE reconnect issues could; should verify UM handles reconnect gracefully on its `/mcp` endpoint. |
| Lack of composition / pipe-ability vs CLI | **Yes, and UM already hedges this** | UM ships `um-preview`, `um-tunnel`, `um-forget`, `um-supersede` as CLI. But they're a narrow utility set, not a daily-use composition surface. This is UM's biggest actual gap vs the critique. |
| Provider lock-in concern | **No** | UM is MCP + REST + CLI, all against the same vault. Users can leave UM at any time — the vault is plain markdown. UM is one of the least lock-in-y options in the space. |
| Latency / performance overhead | **No** | UM's `memory_state` is a direct file read; `memory_search` is a mem0+Qdrant call that would cost the same over REST. MCP JSON-RPC framing adds microseconds, not milliseconds. |
| Debuggability / visibility into what the agent did | **Yes** | Hard to reproduce an MCP tool call from a shell. UM should expose every MCP tool as an equivalent `curl` recipe and `um-*` command. Partially done; should be elevated. |
| Centralized-delivery benefits (Chen's counter-argument) | **Applies in UM's favor** | UM's whole reason to exist is pushing a single source of truth to Claude Code + Claude.ai + Claude Desktop + Discord OpenClaw simultaneously. This is exactly the use case Chen identifies as where MCP wins. |

**Net:** 2 critiques hit UM hard (CLI composition gap, debuggability). 2 hit partially (context bloat, connection lifecycle). 4 don't apply. The hard ones are addressable without dropping MCP.

## 5. Three possible v0.4 directions

### Option A — STAY (MCP-primary, incrementally expand CLI)

v0.4 looks like: ship the planned features (memory_graph? vault web UI? whatever was on the roadmap pre-signal). CLI stays at current scope. REST/OpenAPI stays as an auxiliary for Custom GPT only. Document MCP as THE surface.

**Pros:** Lowest-cost path. Honors the v0.3 thesis. If the pushback is a Q1 2026 overreaction, this bet ages well.

**Cons:** Leaves the real critiques (CLI composability, debuggability) unaddressed. "MCP-only" framing increasingly looks out-of-step with 2026 discourse even when it's technically right. Users evaluating UM alongside a CLI-first competitor will see UM as monolithic.

### Option B — HYBRID-REBALANCE (recommended)

v0.4 looks like:

1. **Promote all three surfaces to equal billing** in README, quickstart, and docs landing. Today's phrasing: "UM is an MCP server" → new phrasing: "UM is one vault with three surfaces — MCP for agents, REST for integrations, CLI for you."
2. **Expand `um-*` into a real toolkit**: `um search <q>`, `um state <project>`, `um recent <project>`, `um capture --type adr`, `um supersede <id>`, `um forget <id>`, `um tail` (stream raw captures), `um diff` (before/after state.md), `um validate` (lint frontmatter). Pipe-friendly JSON output by default. This closes the debuggability and composability gap in one swing.
3. **Adopt code-execution-with-MCP for the write tools**. Keep read tools (`memory_state`, `memory_search`, `memory_recent`, `memory_list`) as direct MCP tools — they're small and cheap. Collapse the four write tools into one `memory_exec` tool whose spec says "ask for a tool by name and UM will return the spec + invoke it." Cuts the loaded-tool-count to ~5 without removing capability. Anthropic's pattern, already blessed.
4. **Document REST/OpenAPI as first-class**: write `docs/quickstart-rest.md` matching the MCP and Claude Code quickstarts. Add a worked example against the Responses API (since that's where OpenAI's tool-use momentum is going).
5. **Ship a `um` single-binary distribution** (or equivalent) so a user can `curl | sh` and have the CLI on their PATH without a Docker-first setup.

**Pros:** Directly answers the loud critiques. Preserves UM's cross-surface thesis. Makes UM the counter-example to "MCP is monolithic" rather than an exemplar of it. Broadens addressable users — skeptics can start with `um search` and never touch MCP until they want to.

**Cons:** Meaningful scope. CLI expansion is probably 2-3 weeks of work. Doc reshuffle is a day. Code-execution pattern is a real design task.

### Option C — PIVOT (MCP as a thin shim)

v0.4 looks like: REST becomes the canonical surface. CLI is the flagship experience. MCP shrinks to a thin adapter over REST, maintained but not advertised. Quickstart leads with Responses API examples.

**Pros:** Hedges against a full MCP collapse. Positions UM with OpenAI's Responses API where tool-use actually happens in 2026 for non-Anthropic users.

**Cons:** Abandons UM's strongest differentiator. Every vendor is shipping REST APIs — UM becomes undifferentiated from every other headless mem0 wrapper. Cross-surface value is highest when the protocol is portable; pivoting away from MCP as Anthropic/AWS/Microsoft/Google/OpenAI/Cloudflare all invest deeper in it is fighting the tape on vendor commitment. Most of the critiques UM actually suffers (CLI gap, debuggability) can be fixed without pivoting.

## 6. Recommendation

**Go with Option B (HYBRID-REBALANCE). Confidence: medium-high.**

Why:

- The entrenchment signal (Linux Foundation, 97M downloads, unified vendor roadmap, OpenAI shipping MCP client support) outweighs the pushback signal on *protocol survival*. The pushback signal is real on *UX/DX*, which Option B directly addresses.
- UM's thesis is cross-surface portability. Dropping MCP (Option C) would make UM worse at its own core job, to chase a signal that on inspection is about inner-loop tool use (Perplexity's actual workload) not durable memory (UM's workload).
- Option A under-invests in critiques that are real (CLI composability, debuggability) and will eventually bite UM's adoption — those are cheap-ish to fix now.
- Garry-Tan-style users reach for skills/CLI before MCP for personal productivity. UM's CLI today is an ops tool, not a daily-use tool. Option B fixes that asymmetry.

**What evidence would flip the call to Option C (PIVOT):**
- A second Tier-1 vendor publicly drops MCP from their core stack (not just a single team, not just internal use).
- Anthropic itself deprecates or freezes the MCP spec, or stops shipping new MCP features in Claude Code / Claude.ai.
- The Agentic AI Foundation stalls (no meaningful governance output in 6 months, signatories going silent).
- Responses API + some equivalent of MCP-over-REST emerges as a de facto standard and starts eating MCP market share on the server side.

**What evidence would flip the call to Option A (STAY):**
- The Perplexity/CLI narrative turns out to be largely Q1 2026 theater — no durable pullback in downloads, server counts, or new MCP launches.
- Expanding the CLI surface in user testing shows nobody reaches for it — users prefer the MCP surface even for shell-adjacent tasks.
- UM's actual deployed users report the loud critiques don't match their experience with UM specifically.

## 7. Follow-up research questions

Things I couldn't answer in 13 calls that would sharpen the call:

1. **Direct Yarats Ask 2026 quote / recording.** All secondary reporting paraphrases. The exact distinction between "Perplexity is abandoning MCP" and "Perplexity is optimizing a specific workload" matters for how much weight to put on this signal. A primary video or transcript would lock this down.
2. **Apideck's original research on 72% context waste.** Multiple articles cite it; the primary source link wasn't surfaced. Reproducing their methodology against UM's actual tool surface (with real token counts) would be a concrete way to answer the context-bloat critique for UM specifically.
3. **Code-execution-with-MCP fit for UM.** Anthropic's pattern is built around agents writing code to traverse a filesystem of tool APIs. Would UM benefit? Likely yes for write tools, likely no for the 4 read tools. Worth a design spike before committing to Option B step 3.
4. **Responses API tool-use volume vs MCP.** Is the shift toward Responses API a shift *away from* MCP or additive to it? OpenAI ships both. Would want to see month-over-month numbers on function-calling vs MCP-tool-calling inside ChatGPT/Responses before concluding anything about the long game.
5. **Skills vs MCP trajectory inside Claude Code.** Gstack is skills-based. If Anthropic pushes skills as the "in-client" extensibility mechanism and reserves MCP for "cross-process, cross-surface" use cases, UM's MCP bet is cleanly safe. If skills eat the cross-surface use case too, UM has a problem. Worth a targeted read of Anthropic's skills roadmap.
6. **Is UM discoverable from `pulsemcp.com` / MCP registries?** If the v0.4 thesis is "MCP is permanent infrastructure," UM should be in the registries with good metadata.
