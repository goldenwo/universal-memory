/**
 * server/lib/write-enabled.mjs — shared UM_MCP_WRITE_ENABLED gate.
 *
 * Lifted out of mem0-mcp-http.mjs (#171 Stage B, U2.5 extraction) to break a
 * circular import: the new server/lib/stats-payload.mjs needs isWriteEnabled()
 * for the `server.writes_enabled` field, but mem0-mcp-http.mjs is the
 * entrypoint that imports stats-payload.mjs — entrypoint→lib imports are
 * safe, lib→entrypoint imports are not. isWriteEnabled() already had a dozen+
 * internal call sites inside the entrypoint (every write-tool gate), so it is
 * lifted here as the single owner rather than duplicated or read via env in
 * two places.
 */

/**
 * Returns true if UM_MCP_WRITE_ENABLED is set to 'true' or '1'.
 * Unset, 'false', '0', or any other value → false (writes disabled).
 */
export function isWriteEnabled() {
  const v = process.env.UM_MCP_WRITE_ENABLED;
  return v === 'true' || v === '1';
}
