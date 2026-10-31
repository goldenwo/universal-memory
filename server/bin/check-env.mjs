#!/usr/bin/env node
// server/bin/check-env.mjs — would the server boot with this environment? Answers without
// booting it: runs validateBootEnv (lib/startup-validation.mjs), the same list of
// environment refusals the server runs at boot, and touches nothing else.
//
// The installer runs it inside the target image, through compose so it sees exactly the
// environment the server would get, before it starts or swaps the server (#400). By hand:
//   docker compose run --rm --no-deps -T --entrypoint node memory-server bin/check-env.mjs
//
// Exit 0: no refusal. Exit 1: the server would refuse; the FATAL line says why.

import { validateBootEnv } from '../lib/startup-validation.mjs';

try {
  validateBootEnv(process.env);
} catch (err) {
  console.error(`[check-env] FATAL: ${err.message}`);
  process.exit(1);
}
console.log('[check-env] ok: the server accepts this environment');
