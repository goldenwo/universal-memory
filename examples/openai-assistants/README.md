# OpenAI Assistants API + universal-memory

Developer-facing example: an OpenAI Assistant that recalls past work from a
self-hosted universal-memory (UM) vault via two function tools (`memory_search`,
`memory_state`). Drop-in for any Assistants API app that wants a memory backend.

## What this does

Creates an Assistant with `memory_search` and `memory_state` registered as
function tools, opens a thread with a user message asking about a project, and
handles the `requires_action` loop by dispatching tool calls to UM's HTTP
surface (`POST /api/search`, `GET /api/state/{project}`) and submitting the raw
JSON back to OpenAI. The final assistant reply is printed. Both Node and Python
flavors are provided; pick whichever matches your stack.

The example is intentionally thin — ~200 lines per file — so it's easy to lift
pieces into your own code.

## Prereqs

1. **UM running locally.** Start the Docker stack:
   ```bash
   cd ../../server          # (from this dir)
   docker compose up -d
   curl http://localhost:6335/health   # -> {"ok":true,"memories":N}
   ```
   Full install walkthrough: [docs/quickstart.md](../../docs/quickstart.md).

2. **OpenAI API key** in the environment. Both examples read `OPENAI_API_KEY`
   directly — no hardcoded secrets.

3. **Node 20+** or **Python 3.10+**. Smoke-tested on Node 25.2 and Python 3.11.

## Run — Node

```bash
npm install openai
OPENAI_API_KEY=sk-... UM_ENDPOINT=http://localhost:6335 node assistants-memory-tool.mjs
```

`UM_ENDPOINT` defaults to `http://localhost:6335`; set it only if you tunneled
UM somewhere else.

## Run — Python

```bash
pip install openai httpx
OPENAI_API_KEY=sk-... UM_ENDPOINT=http://localhost:6335 python assistants-memory-tool.py
```

We use `httpx` for UM calls (readable, first-class timeouts). If you prefer
stdlib-only, swap it for `urllib.request` — the logic doesn't change.

## Expected output

Both scripts print a short run log, the tool calls the Assistant made, and the
final assistant reply. Truncated sample from a live run against a UM vault with
some test data:

```
[um] using endpoint http://localhost:6335
[openai] creating assistant...
[openai] thread thread_6DXBJ... / assistant asst_3ceW7...
[openai] starting run (createAndPoll)...
[run] requires_action — 2 tool call(s)
  -> memory_state({"project": "demo"}) => {"ok":true,"project":"demo","state":null,"valid_from":null}...
  -> memory_search({"query": "demo", "limit": 5}) => {"results":[...]}...

=============================================
Assistant reply:
=============================================
Here's what I found regarding the project "demo":

1. Project State: The current state.md for the project "demo" is not available...
2. Recent Session Summaries and Decisions:
   - Session Summary (Apr 20, 2026): ...implementing the password reset flow...
   - Key Decisions: JWT over session cookies, SendGrid for transactional emails...

(...truncated...)
=============================================
```

The reply content depends on what's in your vault. A fresh install with no
prior captures will get a polite "no results" response — the tools still
execute correctly, there just isn't anything to find.

## Cost

Each run spins up a full Assistants thread (one turn of tool calls + one turn
of final synthesis, model `gpt-4o-mini`). Typical cost per invocation is in the
**1-2 cent** range. UM logs every completion call to
`$VAULT/.telemetry/cost-log.csv` — but note that `.telemetry/` only exists
once UM has made at least one OpenAI call of its own (from summarizer or
catchup). The Assistants API calls from these examples are billed directly to
your OpenAI account and do **not** appear in UM's cost-log; check them via the
[OpenAI usage dashboard](https://platform.openai.com/usage).

## Caveats

- **These tools are read-only.** `memory_search` and `memory_state` query the
  vault but never write to it. For full capture during an Assistants session
  (session summaries, state.md updates, etc.), use UM's MCP surface directly
  or the Claude Code session-end hook. Workflow reference:
  [docs/workflow.md](../../docs/workflow.md).

- **One-shot Assistant.** Each invocation creates and deletes its own
  Assistant. If you want to reuse an Assistant across runs, store the id
  returned from `assistants.create(...)` and skip the delete step. (The example
  prioritizes being runnable without side effects.)

- **Model choice.** `gpt-4o-mini` is good enough to reason about UM tool
  outputs. For richer synthesis, swap to `gpt-4o` — but expect 5-10x cost.

- **Project filtering** in `memory_search` uses a post-filter on the
  `metadata.project` field. If your project slug isn't in the frontmatter of
  any captured doc yet, filtering returns empty even if the docs are relevant.

## Known issues

- **Assistants API deprecation warnings.** OpenAI has marked the Assistants
  API as deprecated in both SDK 6.x (Node) and SDK 2.x (Python) in favor of
  the Responses API. The API itself still works and this example runs
  end-to-end, but the Python SDK emits `DeprecationWarning` on every call.
  We suppress duplicates with `warnings.filterwarnings("once", ...)`. A
  Responses-API variant of this example is tracked for the v0.4 milestone.

- **SDK signature drift (openai-node 4.x → 6.x).** If you're pinning an older
  SDK, `submitToolOutputsAndPoll` used to take `(threadId, runId, params)`;
  in v6 it's `(runId, params)` with `thread_id` inside `params`. This example
  uses the v6 shape. The Python SDK 2.x is fully keyword-arg-based, so this
  doesn't apply there.

- **Windows paths.** If you're running on Windows and your UM vault contains
  telemetry at a POSIX path baked into Docker, the `$VAULT/.telemetry/` path
  in the cost note above may be inside the container rather than on the host.
  Check `docker exec <um-container> ls /vault/.telemetry`.

## See also

- [docs/workflow.md](../../docs/workflow.md) — runtime reference for the full UM stack.
- [docs/mcp-tools.md](../../docs/mcp-tools.md) — full MCP tool surface (for write access).
- [docs/architecture.md](../../docs/architecture.md) — two-tier design and three pillars.
- [`examples/openai-agents-sdk/`](../openai-agents-sdk/) — same flow using the OpenAI Agents SDK.
