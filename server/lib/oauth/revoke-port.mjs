// server/lib/oauth/revoke-port.mjs — the port bin/oauth-revoke.mjs posts to.
//
// A lib module, not an export of the bin, so the bin can call main()
// unconditionally: a main-module guard comparing argv[1] to import.meta.url is
// false when the script is reached through a symlink or junction, and the
// panic-revoke CLI then exits 0 having done nothing.

import { parsePortEnv } from '../env-number.mjs';
import { requireCheckedKnob } from '../checked-knobs.mjs';

/**
 * --port wins, so it also rescues a malformed MEM0_MCP_PORT. Otherwise MEM0_MCP_PORT reads
 * as the server reads it (checked-knobs.mjs): unset or blank is 6335 (a blank one used to
 * reach http.request as '' and post to port 80), and a set-but-malformed one throws, as it
 * refuses server boot — falling back would revoke grants on whatever answers on 6335, or
 * blame the wrong port. A malformed --port throws too.
 */
export function resolveRevokePort(flag, env = process.env) {
  if (flag !== undefined) {
    const port = parsePortEnv(flag);
    if (port === undefined) throw new Error(`--port must be a TCP port 1-65535, got ${JSON.stringify(flag)}.`);
    return port;
  }
  try {
    return requireCheckedKnob('MEM0_MCP_PORT', env);
  } catch (err) {
    throw new Error(`${err.message}; pass --port <p>.`);
  }
}
