/**
 * Single source of truth for the server version string.
 *
 * Read once at module load from server/package.json so the MCP `serverInfo`
 * banner (mem0-mcp-http.mjs) and the OpenAPI `info.version` (openapi.mjs)
 * cannot drift from the released package version.
 *
 * Replaces hardcoded `'0.7.0-alpha'` literals that survived through v1.0.0.
 * See docs/plans/2026-05-08-universality-roadmap.md Phase A4.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const _pkg = JSON.parse(readFileSync(
  path.resolve(__dirname, '../package.json'),
  'utf8',
));

export const SERVER_VERSION = _pkg.version;
