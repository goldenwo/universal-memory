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

## Findings

_To be filled in by the user + verification subagent after CC session runs._

**CC version tested:**
**Unique header keys captured:**
**Forbidden-header grep result:**
**Verdict:**
