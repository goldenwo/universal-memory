# V3 — CC MCP forwarded-header capture (verification report)

## Purpose (Phase B blocker)

Verify that Claude Code's MCP HTTP transport does not emit any of the 10 forwarded/proxy headers listed in spec §4.2. If it does, Phase B's loopback-bypass rule breaks for legitimate CC plugin calls.

## Setup

1. Open a terminal in `E:\Projects\universal-memory`.
2. Start the echo server:
   ```bash
   node docs/research/2026-04-24-v0.6-verifications/echo-headers-server.mjs
   ```
   Leave it running. Default log file: `/tmp/cc-headers.log`. Override with
   `LOG_FILE=/abs/path/cc-headers.log node …` if needed.
   > Note: on Windows, Node resolves `/tmp/…` to `<current-drive>:/tmp/…` (e.g.
   > `E:/tmp/cc-headers.log`). The server prints the absolute path it's using
   > on startup — copy that exact path for the scan step below.
3. In a separate terminal, point CC at the echo server:
   ```bash
   export UM_SERVER_URL=http://127.0.0.1:6336
   ```
4. Open a Claude Code session in any project with the UM plugin installed. Let session-start run; invoke any UM MCP tool (e.g., `um list`, `um recent`, etc.) so at least one `/api/*` and one `/mcp` request hits the echo server.
5. After 5-10 request entries show up in the echo-server log, `Ctrl+C` the server.

## Run the scan

```bash
bash docs/research/2026-04-24-v0.6-verifications/V3-scan-headers.sh <log-path-from-server-startup>
```

(If you didn't override `LOG_FILE`, the path on Linux/macOS is
`/tmp/cc-headers.log`; on Windows it's typically `E:/tmp/cc-headers.log` or
whatever your current drive is when Node ran.)

Expected: zero forbidden headers. Record output + header-key list below.

## Automated capture via `claude -p`

Instead of an interactive CC session, the verification is now run as a
subprocess:

```bash
# 1. Write minimal MCP config pointing at the echo server
cat > /tmp/um-echo-mcp.json <<'EOF'
{
  "mcpServers": {
    "universal-memory-echo": {
      "type": "http",
      "url": "http://127.0.0.1:6336/mcp"
    }
  }
}
EOF

# 2. Start echo server (use the in-repo echo-headers-server.mjs or an
#    enhanced variant that also replies to MCP `initialize` + `tools/list`
#    so CC completes its handshake cleanly and we capture follow-up
#    requests, not just the first init POST).
LOG_FILE="E:/tmp/cc-headers.log" node docs/research/2026-04-24-v0.6-verifications/echo-headers-server.mjs &

# 3. Run a terse `claude -p` with that MCP config. `--strict-mcp-config`
#    both ignores the user's real MCP servers AND terminates the variadic
#    `--mcp-config` arg list so the prompt is parsed correctly.
UM_SERVER_URL=http://127.0.0.1:6336 \
  timeout 60 claude --mcp-config /tmp/um-echo-mcp.json --strict-mcp-config \
                    -p "Say ok."
```

Important Windows note: Node resolves `/tmp/cc-headers.log` to
`<drive>:\tmp\cc-headers.log` (e.g. `E:\tmp\cc-headers.log`). Pass
`LOG_FILE` explicitly and use the same absolute path for the scan.

## Findings

Captured 2026-04-24 on Windows 11 (Git Bash), via `claude -p` subprocess.

**CC version tested:** `claude 2.1.104 (Claude Code)` — user-agent string
emitted by the MCP client: `claude-code/2.1.104 (claude-desktop, agent-sdk/0.2.111)`.

**Requests captured:** 5 log lines = 1 `curl /health` sanity check + 4 real
CC MCP requests (`initialize`, `notifications/initialized`, one SSE
long-poll `GET /mcp`, `tools/list`). `claude -p` exited 0 and produced
the expected `ok.` output, confirming the MCP handshake completed.

**Unique header keys captured across all requests:**

```
accept
accept-encoding
accept-language
connection
content-length
content-type
host
mcp-protocol-version
sec-fetch-mode
user-agent
```

Every request carried only these keys. The `mcp-protocol-version` header
appears on all post-initialize requests with value `2025-03-26`. No
`x-*`, no `forwarded`, no `via`, no proxy-origin header of any kind.

**Forbidden-header grep result:** no matches against the full list
`x-forwarded-for | x-forwarded-host | x-forwarded-proto | x-real-ip |
forwarded | via | cf-connecting-ip | true-client-ip |
tailscale-user-login | tailscale-user-name`. `V3-scan-headers.sh` exit
code 0.

**`claude -p` stderr:** empty (no warnings, no MCP errors).

**Verdict: CLEAN.** Claude Code's MCP HTTP transport does not emit any
forwarded/proxy header. The spec §9.3 Phase B loopback-bypass rule (drop
requests that arrive on 127.0.0.1 but carry forwarded-header evidence of
an external hop) is safe — it will never false-positive on a legitimate
CC plugin MCP call.
