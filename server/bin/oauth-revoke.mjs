#!/usr/bin/env node
// server/bin/oauth-revoke.mjs — Gap-3 OAuth PR-5 operator revocation CLI.
//
// The "load-bearing payoff of choosing opaque tokens over JWT" (spec §4.3):
// disconnect ONE vendor or panic-revoke EVERYTHING, instantly, without bouncing
// the server. It does this by POSTing to the loopback-only `POST /oauth/revoke`
// route on the RUNNING server — only that process owns the in-process state
// cache, so a CLI editing oauth-state.json directly would race the server's own
// atomic writes. The route is loopback-gated by the endpoint-class row, so this
// CLI needs no auth token: it must run on the same host as the server.
//
// Usage:
//   node server/bin/oauth-revoke.mjs --all
//   node server/bin/oauth-revoke.mjs --client <client_id>
//   [--port <p>]   default: $MEM0_MCP_PORT or 6335
//
// Exit codes: 0 success · 1 transport/non-2xx failure · 2 bad arguments.
//
// NUCLEAR OPTION (server stopped): delete `<UM_VAULT_DIR>/oauth-state.json`
// while the server is down — this kills ALL grants AND the consent-cookie HMAC
// key (every live cookie is orphaned). Mentioned on every failure path so an
// operator who cannot reach a running server always sees the fallback.

import http from 'node:http';

const NUCLEAR_HINT =
  'If the server is not running, stop it and delete <UM_VAULT_DIR>/oauth-state.json ' +
  'to panic-revoke ALL grants (and the consent-cookie key).';

const USAGE = [
  'Usage:',
  '  oauth-revoke --all                 revoke every grant (tokens + codes)',
  '  oauth-revoke --client <client_id>  revoke one client + its tokens/codes',
  '  [--port <p>]                       server port (default $MEM0_MCP_PORT or 6335)',
].join('\n');

function fail(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

// Minimal flag parse: --all | --client <id> | --port <p>. Anything else is a
// usage error. Exactly one of --all / --client is required.
function parseArgs(argv) {
  let all = false, client, port;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') all = true;
    else if (a === '--client') { client = argv[++i]; if (client === undefined) return { error: 'missing value for --client' }; }
    else if (a === '--port') { port = argv[++i]; if (port === undefined) return { error: 'missing value for --port' }; }
    else return { error: `unknown argument: ${a}` };
  }
  if (all === (client !== undefined)) return { error: 'specify exactly one of --all or --client <id>' };
  return { all, client, port };
}

function postRevoke(port, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, method: 'POST', path: '/oauth/revoke',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function formatCounts(counts) {
  if (!counts || typeof counts !== 'object') return '';
  return `access tokens: ${counts.accessTokens ?? '?'}, ` +
    `refresh tokens: ${counts.refreshTokens ?? '?'}, ` +
    `codes: ${counts.codes ?? '?'}`;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) fail(2, `${parsed.error}\n\n${USAGE}`);

  const port = parsed.port ?? process.env.MEM0_MCP_PORT ?? '6335';
  const body = parsed.all ? { all: true } : { client_id: parsed.client };

  let res;
  try {
    res = await postRevoke(port, body);
  } catch (e) {
    // Connection refused / DNS / socket error → server unreachable.
    fail(1, `Could not reach the server on 127.0.0.1:${port} (${e.code ?? e.message}).\n${NUCLEAR_HINT}`);
  }

  let json;
  try { json = JSON.parse(res.body); } catch { json = null; }

  if (res.status < 200 || res.status >= 300) {
    const detail = json?.error ? ` (${json.error})` : '';
    fail(1, `Revocation failed: HTTP ${res.status}${detail}.\n${NUCLEAR_HINT}`);
  }

  // Success: report what was revoked, human-readably.
  if (json?.revoked === 'all') {
    process.stdout.write(`Revoked ALL grants. ${formatCounts(json.counts)}\n`);
  } else if (json?.revoked === 'client') {
    process.stdout.write(`Revoked client ${json.client_id}. ${formatCounts(json.counts)}\n`);
  } else {
    process.stdout.write(`Revoked. ${res.body}\n`);
  }
  process.exit(0);
}

main();
