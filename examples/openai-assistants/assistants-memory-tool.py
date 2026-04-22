#!/usr/bin/env python3
"""
OpenAI Assistants API example — using universal-memory as a memory tool.

Python equivalent of assistants-memory-tool.mjs. Demonstrates an Assistant with
`memory_search` and `memory_state` function tools backed by UM's HTTP surface.
Handles the `requires_action` state by dispatching tool calls and submitting
outputs back to OpenAI.

Dependencies: openai, httpx.
  We picked httpx over urllib.request for readable async-ish code and first-class
  timeouts. If you want a stdlib-only variant, drop httpx and use
  urllib.request.Request + urlopen; the logic is identical.

Environment:
  OPENAI_API_KEY  — required
  UM_ENDPOINT     — optional, default http://localhost:6335

Usage:
  pip install openai httpx
  OPENAI_API_KEY=sk-... python assistants-memory-tool.py

Exit codes:
  0  — run completed, assistant reply printed
  1  — UM unreachable / OpenAI error / malformed tool call
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from typing import Any

# openai-python 2.x emits DeprecationWarning on every Assistants API call because the
# Assistants API is deprecated in favor of the Responses API. The call sites still
# work, so we collapse the noise to a single warning per location. A Responses-API
# variant is tracked for v0.4. See README "Known issues" for context.
warnings.filterwarnings("once", category=DeprecationWarning, module=r"openai\..*")

import httpx  # noqa: E402
from openai import OpenAI  # noqa: E402

UM_ENDPOINT = os.environ.get("UM_ENDPOINT", "http://localhost:6335")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")

if not OPENAI_API_KEY:
    print("ERROR: OPENAI_API_KEY not set in environment.", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Tool definitions — schemas given to the Assistant
# ---------------------------------------------------------------------------
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "memory_search",
            "description": (
                "Semantic search over the universal-memory vault. Returns up to "
                "`limit` documents ranked by relevance to `query`. Use this to "
                "recall past decisions, session summaries, or authored knowledge. "
                "Default response is compact: each result has `id`, `title`, `score`, "
                "and `snippet` (first ~240 chars of body). The snippet is usually "
                "enough to answer the question — only use `?full=1` (append to the "
                "URL) when you need the complete document body."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Natural-language search query."},
                    "limit": {
                        "type": "integer",
                        "description": "Max results (1-20). Default 5.",
                        "minimum": 1,
                        "maximum": 20,
                    },
                    "project": {
                        "type": "string",
                        "description": "Optional project slug filter (e.g. \"demo\").",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_state",
            "description": (
                "Load the current state.md for a project. Returns the frontmatter and body. "
                "state.md is the LLM-merged snapshot of the project — current focus, "
                "in-flight work, recent decisions, next actions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "project": {"type": "string", "description": "Project slug (^[a-zA-Z0-9._-]+$)."}
                },
                "required": ["project"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Tool handlers — call UM HTTP surface
# ---------------------------------------------------------------------------
def handle_memory_search(*, query: str, limit: int = 5, project: str | None = None) -> Any:
    body: dict[str, Any] = {"query": query, "limit": limit}
    if project:
        body["filters"] = {"project": project}
    r = httpx.post(f"{UM_ENDPOINT}/api/search", json=body, timeout=30.0)
    r.raise_for_status()
    return r.json()


def handle_memory_state(*, project: str) -> Any:
    r = httpx.get(f"{UM_ENDPOINT}/api/state/{project}", timeout=30.0)
    r.raise_for_status()
    return r.json()


HANDLERS = {
    "memory_search": handle_memory_search,
    "memory_state": handle_memory_state,
}


def dispatch_tool_call(tool_call) -> Any:
    name = tool_call.function.name
    arg_json = tool_call.function.arguments or "{}"
    handler = HANDLERS.get(name)
    if handler is None:
        return {"error": f"unknown tool: {name}"}
    try:
        args = json.loads(arg_json)
    except json.JSONDecodeError as e:
        return {"error": f"invalid tool arguments: {e}"}
    try:
        return handler(**args)
    except Exception as e:  # noqa: BLE001 — surface any tool failure to the model
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Preflight — fail fast if UM is down
# ---------------------------------------------------------------------------
def preflight_um() -> None:
    try:
        r = httpx.get(f"{UM_ENDPOINT}/health", timeout=3.0)
        r.raise_for_status()
        body = r.json()
        if not body.get("ok"):
            raise RuntimeError(f"health body.ok=false: {body}")
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: universal-memory unreachable at {UM_ENDPOINT}: {e}", file=sys.stderr)
        print("Start it with: cd server && docker compose up -d", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    preflight_um()

    client = OpenAI(api_key=OPENAI_API_KEY)
    print(f"[um] using endpoint {UM_ENDPOINT}")
    print("[openai] creating assistant...")

    assistant = client.beta.assistants.create(
        name="UM Memory Assistant (example)",
        instructions=(
            "You are a helpful assistant with access to a personal memory store "
            "(universal-memory). When the user asks about past work, project state, "
            "or prior decisions, call the appropriate memory tool before answering. "
            "Cite the document title / id from the tool output so the user can trace "
            "your claims. If a tool returns no results, say so honestly."
        ),
        model="gpt-4o-mini",
        tools=TOOLS,
    )

    thread = client.beta.threads.create(
        messages=[
            {
                "role": "user",
                "content": (
                    "What do we know about the project \"demo\"? Check its state.md and "
                    "also search for any recent session summaries or decisions mentioning "
                    "it. Summarize what you find."
                ),
            }
        ]
    )

    print(f"[openai] thread {thread.id} / assistant {assistant.id}")
    print("[openai] starting run (create_and_poll)...")

    # SDK helper: creates run, polls until terminal state or requires_action.
    # See https://github.com/openai/openai-python for helper signatures.
    run = client.beta.threads.runs.create_and_poll(
        thread_id=thread.id,
        assistant_id=assistant.id,
    )

    while run.status == "requires_action":
        tool_calls = run.required_action.submit_tool_outputs.tool_calls
        print(f"[run] requires_action — {len(tool_calls)} tool call(s)")

        tool_outputs = []
        for call in tool_calls:
            output = dispatch_tool_call(call)
            preview = json.dumps(output)[:120]
            print(f"  -> {call.function.name}({call.function.arguments}) => {preview}...")
            tool_outputs.append({"tool_call_id": call.id, "output": json.dumps(output)})

        run = client.beta.threads.runs.submit_tool_outputs_and_poll(
            thread_id=thread.id,
            run_id=run.id,
            tool_outputs=tool_outputs,
        )

    if run.status != "completed":
        print(f"[run] terminated with status={run.status}", file=sys.stderr)
        if getattr(run, "last_error", None):
            print(f"  error: {run.last_error}", file=sys.stderr)
        try:
            client.beta.assistants.delete(assistant.id)
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)

    messages = client.beta.threads.messages.list(thread_id=thread.id, order="desc", limit=10)
    reply = next((m for m in messages.data if m.role == "assistant"), None)
    reply_text = ""
    if reply is not None:
        reply_text = "\n\n".join(
            c.text.value for c in reply.content if getattr(c, "type", None) == "text"
        )

    print("\n=============================================")
    print("Assistant reply:")
    print("=============================================")
    print(reply_text or "(no text content)")
    print("=============================================\n")

    try:
        client.beta.assistants.delete(assistant.id)
    except Exception:  # noqa: BLE001
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
