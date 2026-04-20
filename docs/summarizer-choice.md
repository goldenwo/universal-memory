# Summarizer choice (UM_SUMMARIZER)

Three backends supported for session-end summarization. All use the same prompt.

| Backend | Cost | Dependency | Quality | Default when |
|---|---|---|---|---|
| `openai` | ~$0.0003/session (gpt-4o-mini default) | OPENAI_API_KEY | High — mature, consistent | User has OpenAI key, no claude CLI |
| `claude-agent-sdk` | $0 incremental (uses your Claude subscription) | `claude` CLI in PATH | High — same model that wrote the content | User has CC installed |
| `ollama` | $0 | local Ollama instance + model pulled | Variable — depends on model | User runs local Ollama and wants no cloud |

## Choosing

If you already use Claude Code, default to `claude-agent-sdk` — zero extra cost or setup.
If you have an OpenAI key and prefer provider separation, keep `openai`.
`ollama` ships as v0.4 (stub in v0.3); choose when real-time local summarization matters.

## Switching

```
# In ~/.bashrc or server/.env
UM_SUMMARIZER=claude-agent-sdk
```

Restart Claude Code. No server restart required.

## Recursive-hook guard

`claude-agent-sdk` works by spawning `claude -p --output-format text` as a subprocess. The parent sets `UM_IN_SUMMARIZER_SUBPROCESS=1` before spawning; all four CC hooks check this sentinel at their first executable line and exit immediately when set. This prevents the nested `claude` instance from re-triggering summarization (infinite loop guard).

If you edit hooks, preserve the early-exit guard.

## Fallback semantics

- `claude-agent-sdk` with no `claude` in PATH → warns on stderr, falls back to openai
- `claude-agent-sdk` with claude exit != 0 (even with partial output) → warns on stderr, falls back to openai
- `claude-agent-sdk` with empty claude output → warns on stderr, falls back to openai
- `ollama` → warns, falls back to openai (stub until v0.4)
- Unknown value → warns, falls back to openai

Fallback requires `UM_OPENAI_API_KEY` to be set. If neither `claude` nor an API key is available, session-end summarization is a silent no-op.
