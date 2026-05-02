/**
 * cli/reindex.mjs — Reindex CLI host module (multi-phase pipeline).
 *
 * Spec ref: §6.3 (stamp-then-swap ordering), §6.4 (state schema), §6.5 (phase
 * pipeline). The CLI walks the user through a 7-phase reindex (validate →
 * snapshot → rebuild → stamp → swap → verify → report) with checkpointed
 * resumability. Each phase advances `phase_completed` exactly once and writes
 * the full updated state atomically (single writeCheckpoint call per phase
 * boundary) so a crash leaves the checkpoint either fully at phase N or fully
 * at phase N+1, never torn.
 *
 * DE9 lands phase 1 (validate). DE10 adds phase 2 (snapshot) and phase 3
 * (rebuild). DE11 adds phases 4-7 (stamp → swap → verify → report). Each phase
 * exports a `runPhaseN*` function with explicit dependency injection so phases
 * can be unit-tested in isolation without touching real Qdrant, the live
 * server, or the user's vault.
 *
 * Phase 1 (validate) — three pre-flight gates before the operator commits to
 * reindexing:
 *   1. Stamp-vs-env mismatch gate — refuse if the active stamp already matches
 *      env (`UM_EMBEDDING_PROVIDER`/`UM_EMBEDDING_MODEL`); reindex would be a
 *      no-op (test 2).
 *   2. Server-responsive gate — refuse if the API server answers /api/state at
 *      `serverProbeUrl`; the server holds connections to the source collection
 *      and a concurrent reindex risks split state (test 3). Operators can pass
 *      `--no-server-probe` to bypass when the probe URL is wrong but they're
 *      certain the server is stopped (test 5).
 *   3. Estimate-and-confirm gate — print {entries, tokens, cost_usd} and (in
 *      interactive mode) prompt before proceeding so operators see the cost
 *      before any embedding API calls (test 6).
 *
 * Phase 2 (snapshot) — enumerate the entries to rebuild. Walks the configured
 * vault for `.md` files (file-backed entries) AND queries the source Qdrant
 * collection for fact-only payloads (entries without a vault file). Writes
 * `state.snapshot = { vault_paths, fact_ids }` atomically with phase_completed=2
 * so a crash either replays the snapshot or skips it cleanly. DE12's e2e test
 * exercises this path; DE10 ships the implementation alongside the phase 3
 * tests so the snapshot dependency is in place before phase 3's resume tests.
 *
 * Phase 3 (rebuild) — replay the snapshot through the new Memory instance with
 * `infer: false` (we already extracted facts on the original write; we just need
 * fresh embeddings). Three rules govern the rebuild loop:
 *   • Resume-safe: entries already in `state.processed_ids` are skipped on
 *     replay. The CLI tolerates being re-run after a crash without re-embedding
 *     completed entries (the dominant cost driver).
 *   • Rate-limit retries: on `PROVIDER_RATELIMIT` class errors, retry with
 *     exponential backoff up to `maxRetries`. On exhaustion, write a checkpoint
 *     and surface the error with `--resume` instructions so the operator can
 *     wait for quota recovery and continue from the last good entry.
 *   • Atomic phase-advance (Adv-4 contract): the FINAL entry's
 *     `state.processed_ids.push(id)` AND `state.phase_completed = 3` MUST be
 *     persisted in the SAME `checkpoint.write(state)` call. A naive
 *     "push-then-record-then-write-twice" pattern opens a crash window where
 *     phase 3 finishes but phase_completed stays at 2 — `--resume` then re-runs
 *     the entire phase from scratch (idempotent on processed_ids, but expensive).
 *
 * Phase 4 (stamp) — write the new embedding stamp into the NEW Qdrant
 * collection BEFORE the alias swap. Per spec §6.3 (Round-4 Adv-1 ordering
 * correctness), the stamp lands in `target_collection` first; only after the
 * stamp is durable does phase 5 swap the public alias. Reverse ordering
 * (swap-then-stamp) opens a window where readers query the new collection but
 * the stamp still describes the old shape.
 *
 * Phase 5 (swap) — Qdrant alias swap (`alias → target_collection`). Two
 * defensive contracts:
 *   • Resume defensive read (Round-4 Adv-finding): on `--resume` after a
 *     partial reindex (e.g. crash between phase 4 and phase 5),
 *     `runPhase5Swap` first reads the new collection's stamp via
 *     `stamp.read({ collection: targetCollection })` and refuses the swap if
 *     null. Defends against checkpoint-says-phase-4-done-but-it-wasn't
 *     corruption — the checkpoint counter advanced but the underlying write
 *     didn't actually durabilize.
 *   • Old-collection retention default (R10 mitigation): the OLD collection
 *     is retained by default (`--keep-old=true`); operators must explicitly
 *     pass `--keep-old=false` to drop it. Phase 5 itself only performs the
 *     alias swap; an optional cleanup pass (handled in phase 7) drops the
 *     old collection only when explicitly opted in.
 *
 * Phase 6 (verify) — read the active stamp via the alias to confirm the swap
 * landed and the alias-resolved stamp matches the new shape. Optionally compare
 * a sample/count against `expectedCount` (snapshot length) for a coarse
 * sanity check. Returns `{ matches, expected, actual, stamp }` for the report.
 *
 * Phase 7 (report) — print summary stats + the operator-facing restart
 * instruction ("reindex complete; restart the server to load the new
 * collection"), advance `phase_completed: 7`, and either delete the
 * checkpoint state file or rename it to `<path>.archive.json` for
 * post-mortem inspection. The restart instruction is load-bearing: the running
 * server caches its embedder/Memory client at boot; only a process restart
 * picks up the new alias target.
 *
 * Atomic-phase-advance contract (echoed in DE10–DE11): on success, the SAME
 * `checkpoint.write` call persists BOTH the phase outputs AND
 * `phase_completed: N`. Don't write outputs first then bump phase in a separate
 * call — that opens a crash window where the next CLI run sees an incomplete
 * phase but a bumped counter, falsely skipping replay. Phases 4-7 each accept
 * OPTIONAL `state` and `checkpoint` parameters: when both are provided
 * (production CLI orchestration) the atomic write happens; when omitted (unit
 * tests focused on phase mechanics) the phase function still completes its
 * core work but skips the checkpoint write. This mirrors DE10's optional
 * `oldMemory.listFactIds` pattern — keep test ergonomics simple while
 * preserving the production atomicity contract.
 *
 * Public API:
 *   - runPhase1Validate({ ... }) → { proceed, estimate, fromStamp, toShape }
 *   - runPhase2Snapshot({ ... }) → { vault_paths, fact_ids }
 *   - runPhase3Rebuild({ ... })  → { processed, cancelled? }
 *   - runPhase4Stamp({ ... })    → void
 *   - runPhase5Swap({ ... })     → void
 *   - runPhase6Verify({ ... })   → { matches, expected, actual, stamp }
 *   - runPhase7Report({ ... })   → { archivedTo? }
 *   - installSigintHandler({ ... }) → disposer
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { ProviderError } from '../server/lib/provider/errors.mjs';
import { umAdd } from '../server/lib/add.mjs';

const SCHEMA_VERSION = 1;
// v0.8 G2 — userId resolution for rebuildOne. Mirrors server/mem0-mcp-http.mjs:182
// (env var MEM0_USER_ID, default 'test-user' since cli is not IS_MAIN). Kept local
// rather than promoted to a shared constants module because only one CLI call
// site needs it. Promote if a third call site appears.
const RESOLVED_USER_ID = process.env.MEM0_USER_ID || 'test-user';
const DEFAULT_SERVER_PROBE_URL = 'http://localhost:6335';
// Conservative per-entry token estimate used until snapshot phase (DE10) walks
// real fact bodies. Phase 1's job is to give an order-of-magnitude cost preview
// before the operator consents; the real cost is recomputed in phase 3 against
// actual embedding API token usage.
const ESTIMATE_TOKENS_PER_ENTRY = 200;
// Phase 3 rebuild defaults — kept as named constants so CLI flag wiring (and
// future tuning) has a single source of truth. Tests override via DI to avoid
// real wall-clock waits.
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_PROGRESS_EVERY = 100;
const DEFAULT_RETRY_BASE_MS = 100;

/**
 * Register a SIGINT (Ctrl-C) handler that aborts the provided AbortController
 * so cancellable phases (currently `runPhase3Rebuild`) stop cleanly between
 * entries. Pair with `runPhase3Rebuild({ abortSignal: controller.signal })`.
 *
 * Behaviour:
 *   - First Ctrl-C → controller.abort() + a one-line notice on `out`. The
 *     in-flight rebuild entry finishes; the next loop iteration observes the
 *     signal, persists progress, and returns `{ cancelled: true }`.
 *   - Second Ctrl-C → if `exitOnSecond` (default), `process.exit(130)` to
 *     force-bail when a phase isn't checking the signal yet (e.g. server-probe
 *     RTT in phase 1). Operators learn the pattern from the first-Ctrl-C
 *     notice.
 *
 * The disposer must be called when the long-running phase is done (success
 * OR error) to keep the SIGINT listener tightly scoped — leaking it across
 * phases would silently absorb default Ctrl-C behaviour after reindex exits.
 *
 * @param {object} params
 * @param {AbortController} params.controller - Controller whose signal phases observe.
 * @param {{ write: (s: string) => void }} [params.out=process.stderr]
 *   Stream for the cancellation notice. Tests pass a buffer.
 * @param {boolean} [params.exitOnSecond=true]
 *   On a SECOND SIGINT, hard-exit with code 130 instead of waiting for graceful
 *   cancel. Tests disable this to assert idempotency.
 * @returns {() => void} Disposer that removes the SIGINT listener.
 */
export function installSigintHandler({ controller, out = process.stderr, exitOnSecond = true } = {}) {
  let firstSeen = false;
  const handler = () => {
    if (firstSeen) {
      if (exitOnSecond) {
        // 128 + SIGINT(2) = 130 — POSIX convention for SIGINT-induced exit.
        // eslint-disable-next-line n/no-process-exit
        process.exit(130);
      }
      return;
    }
    firstSeen = true;
    controller.abort();
    out.write(
      '\n[reindex] cancellation requested; will stop after the current entry, then write a resumable checkpoint. Press Ctrl-C again to force-exit.\n',
    );
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

/**
 * Default interactive prompt — reads a single line from stdin. Replaced in
 * tests via the `prompt` DI parameter so test runs never block.
 *
 * @param {string} question - The prompt text shown to the operator.
 * @returns {Promise<string>} The trimmed line the operator typed (lowercased).
 */
export async function readUserConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return String(answer ?? '').trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/**
 * Derive the target Qdrant collection name for a given (provider, model). The
 * server uses sha8(provider:model) to namespace collections per embedding
 * shape so concurrent collections don't collide. DE11 (swap) writes the new
 * stamp into this collection; DE9 records it on the checkpoint so resume after
 * crash uses the same name.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {string} `memories_<8 hex chars>`
 */
function deriveTargetCollection(provider, model) {
  const hash = createHash('sha256').update(`${provider}:${model}`).digest('hex').slice(0, 8);
  return `memories_${hash}`;
}

/**
 * Count `.md` files under the configured vault. Used by phase 1 to estimate
 * how many entries the reindex will process; the snapshot phase (DE10) will
 * replace this with a real listing of fact-bearing entries.
 *
 * Skips silently (returns 0) when the vault dir doesn't exist or isn't
 * configured — phase 1 should still produce an estimate object so the operator
 * sees the cost format even when the vault is empty.
 *
 * @param {string|undefined} vaultDir - Absolute path; typically `env.UM_VAULT_DIR`.
 * @returns {Promise<number>}
 */
async function countVaultMarkdownFiles(vaultDir) {
  if (!vaultDir) return 0;
  try {
    await fs.access(vaultDir);
  } catch {
    return 0;
  }
  let count = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // Fail-soft on unreadable subdirs (EACCES, EPERM, etc.). Phase 1's
      // estimate is intentionally an order-of-magnitude preview; the real
      // count comes from the snapshot phase. A single permission error
      // shouldn't kill the entire validate gate.
      process.stderr.write(`[reindex] could not read ${dir}: ${err.code}; estimate may be low\n`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // Match server/lib/vault.mjs: ignore symlinks defensively, recurse dirs,
      // count regular .md files.
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count += 1;
      }
    }
  }
  await walk(vaultDir);
  return count;
}

/**
 * Probe the API server at `<serverProbeUrl>/api/state`. Returns true if the
 * server responded (any HTTP response — even 4xx/5xx counts as "responsive"
 * because something is listening), false if the connection failed or the
 * fetch threw. Phase 1 refuses to proceed when the probe says responsive.
 *
 * @param {Function} fetchFn
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function probeServer(fetchFn, url) {
  try {
    await fetchFn(`${url.replace(/\/$/, '')}/api/state`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Phase 1 (validate) — see file header for the three gates.
 *
 * @param {object} params
 * @param {{ read: () => Promise<object|null> }} params.stamp
 *   Stamp client; only `read()` is called in phase 1.
 * @param {Record<string, string|undefined>} params.env
 *   Env vars (typically `process.env`). Reads
 *   `UM_EMBEDDING_PROVIDER`/`UM_EMBEDDING_MODEL`/`UM_VAULT_DIR`.
 * @param {{ priceFor: (provider: string, model: string) => { in: number, out: number, type: string, dim?: number } }} params.pricing
 *   Pricing module; `priceFor(provider, model)` shape matches `server/lib/pricing.mjs`.
 * @param {string} [params.serverProbeUrl='http://localhost:6335']
 * @param {boolean} params.noServerProbe
 * @param {boolean} params.confirmInteractive
 *   `true` means `--confirm` was passed; the operator pre-approved the run, so
 *   skip the prompt. `false` means run interactively and call `prompt(...)`.
 * @param {Function} [params.fetch=global.fetch]
 *   Probe HTTP client (DI for tests).
 * @param {(question: string) => Promise<string>} [params.prompt=readUserConfirm]
 * @param {{ write: (state: object) => Promise<void> }} params.checkpoint
 *   Checkpoint client; phase 1 calls `write(state)` exactly once on success.
 * @returns {Promise<{ proceed: boolean, estimate: object, fromStamp: object|null, toShape: object }>}
 */
export async function runPhase1Validate({
  stamp,
  env,
  pricing,
  serverProbeUrl = DEFAULT_SERVER_PROBE_URL,
  noServerProbe,
  confirmInteractive,
  fetch = globalThis.fetch,
  prompt = readUserConfirm,
  checkpoint,
}) {
  // 1. Read current stamp; derive expected shape from env.
  const fromStamp = await stamp.read();
  const toProvider = env.UM_EMBEDDING_PROVIDER;
  const toModel = env.UM_EMBEDDING_MODEL;
  // pricing.priceFor returns { in, out, type, dim? }; dim may be undefined for
  // stub pricing modules used in tests. The no-op gate below compares dim only
  // when present on both sides (skip-null), so missing dim falls back to
  // provider+model equality. Dim is also recorded on the checkpoint for DE11's
  // swap phase.
  const toPrice = pricing.priceFor(toProvider, toModel);
  const toShape = { provider: toProvider, model: toModel, dim: toPrice?.dim };

  // No-op gate: stamp already matches env on (provider, model[, dim]). Refuse —
  // there is nothing to reindex.
  //
  // Dim handling uses skip-null pattern: if EITHER side lacks dim (e.g., test
  // pricing stub omits dim, or stamp predates dim recording), we fall back to
  // provider+model equality. When BOTH sides report dim, we require equality —
  // this catches the OpenAI text-embedding-3-small dim-truncation case (native
  // 1536 vs explicit 512), where provider+model match but the user legitimately
  // wants a reindex into a different-shape collection.
  if (
    fromStamp &&
    fromStamp.provider === toProvider &&
    fromStamp.model === toModel &&
    (toShape.dim == null || fromStamp.dim == null || fromStamp.dim === toShape.dim)
  ) {
    throw new Error(
      `no-op: stamp matches env (${toProvider}/${toModel}); nothing to reindex`,
    );
  }

  // 2. Server-responsive gate (skippable via --no-server-probe).
  if (!noServerProbe) {
    const responsive = await probeServer(fetch, serverProbeUrl);
    if (responsive) {
      throw new Error(
        `server is responsive at ${serverProbeUrl}; stop it before reindex (the server holds connections to the source collection)`,
      );
    }
    // Unreachable: refuse with explicit choices.
    throw new Error(
      `could not probe server at ${serverProbeUrl}; pass --server-url=<url> to point at the right port, or --no-server-probe to skip the probe entirely (only safe if you have stopped the server manually)`,
    );
  }

  // 3. Walk vault + count Qdrant entries → estimate.
  // DE9 simplification: we count `.md` files under UM_VAULT_DIR as a proxy for
  // entries. Real fact counts come from the snapshot phase (DE10), which will
  // also count Qdrant entries via a real client. Tests don't assert specific
  // numbers — only types — so 0 from a missing vault is acceptable here.
  const vaultEntries = await countVaultMarkdownFiles(env.UM_VAULT_DIR);
  // DE9: Qdrant count deferred to DE10 snapshot phase (requires a running
  // Qdrant instance and a client — out of scope for the validate gate).
  const qdrantEntries = 0;
  const entries = vaultEntries + qdrantEntries;
  const tokens = entries * ESTIMATE_TOKENS_PER_ENTRY;
  const cost_usd = (tokens / 1000) * (toPrice?.in ?? 0);
  const estimate = { entries, tokens, cost_usd };

  // 4. Print estimate + prompt (interactive mode only). When --confirm was
  // passed (confirmInteractive===true), skip the prompt entirely — the
  // operator pre-approved the run.
  if (!confirmInteractive) {
    process.stdout.write(
      `Reindex estimate: ${entries} entries, ~${tokens} tokens, ~$${cost_usd.toFixed(4)} USD\n` +
      `From: ${fromStamp ? `${fromStamp.provider}/${fromStamp.model}/${fromStamp.dim}` : '(no stamp)'}\n` +
      `To:   ${toShape.provider}/${toShape.model}/${toShape.dim ?? '?'}\n`,
    );
    const answer = await prompt('proceed? [y/N]: ');
    if (String(answer).trim().toLowerCase() !== 'y') {
      throw new Error('reindex cancelled by operator (answered no at confirm prompt)');
    }
  }

  // 5. Atomic-phase-advance: persist phase-1 outputs AND phase_completed=1 in
  // a single write. Crash before this returns → next run sees no checkpoint
  // and replays from phase 1; crash after → next run sees phase_completed=1
  // and skips to phase 2.
  const target_collection = deriveTargetCollection(toShape.provider, toShape.model);
  const state = {
    schema_version: SCHEMA_VERSION,
    started_at: new Date().toISOString(),
    from: fromStamp,
    to: toShape,
    target_collection,
    phase_completed: 1,
    estimate,
    processed_ids: [],
    last_error: null,
  };
  await checkpoint.write(state);

  return { proceed: true, estimate, fromStamp, toShape };
}

/**
 * Walk a vault directory and return all `.md` file paths (relative to the
 * vault root). Mirrors `countVaultMarkdownFiles` but collects paths instead of
 * counting. Symlinks are skipped to match `server/lib/vault.mjs`. Permission
 * errors on subdirs are reported once to stderr and skipped — phase 2 should
 * not abort on a single unreadable subtree (the operator will see the warning;
 * partial coverage is better than a full halt mid-snapshot).
 *
 * @param {string|undefined} vaultDir - Absolute vault root.
 * @returns {Promise<string[]>}        - Vault-relative `.md` paths.
 */
async function listVaultMarkdownPaths(vaultDir) {
  if (!vaultDir) return [];
  try {
    await fs.access(vaultDir);
  } catch {
    return [];
  }
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      process.stderr.write(`[reindex] could not read ${dir}: ${err.code}; some entries may be missing from the snapshot\n`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const lst = await fs.lstat(abs);
      if (lst.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.relative(vaultDir, abs).split(path.sep).join('/'));
      }
    }
  }
  await walk(vaultDir);
  return out;
}

/**
 * Phase 2 (snapshot) — enumerate everything that needs to be rebuilt.
 *
 * Two sources contribute to the snapshot:
 *   1. The vault directory — every `.md` file is a vault-backed entry whose
 *      body+frontmatter will be re-embedded under the new model in phase 3.
 *   2. The OLD Qdrant collection — fact-only payloads (entries that have NO
 *      vault file because they were stored as facts via `infer:true`). The
 *      `oldMemory` client is expected to expose a `listFactIds()` method that
 *      returns IDs whose payloads do not correspond to a vault file. DE12's
 *      e2e test exercises this against a real Qdrant; the DI shape here lets
 *      future tests fake it cheaply.
 *
 * Atomic phase-advance: the snapshot AND `phase_completed: 2` are persisted
 * in a single `checkpoint.write` call so a crash between writing the snapshot
 * and bumping the phase counter is impossible.
 *
 * @param {object} params
 * @param {{ dir?: string }} params.vault - Vault config; `dir` is the absolute
 *   path under which to walk for `.md` files.
 * @param {{ listFactIds?: () => Promise<string[]> }} [params.oldMemory]
 *   Optional source for fact-only IDs. Phase 2 tolerates a missing client
 *   (no facts contributed). DE12 wires the real client.
 * @param {object} params.state - Mutable checkpoint state. Phase 2 mutates
 *   `state.snapshot` and `state.phase_completed`.
 * @param {{ write: (s: object) => Promise<void> }} params.checkpoint
 * @returns {Promise<{ vault_paths: string[], fact_ids: string[] }>}
 */
export async function runPhase2Snapshot({ vault, oldMemory, state, checkpoint }) {
  const vault_paths = await listVaultMarkdownPaths(vault?.dir);
  // Fact-only IDs: prefer an explicit listFactIds() method on the old memory
  // client. Returning [] when the client isn't available keeps the e2e test
  // (DE12) the source of truth for the live-Qdrant path while letting unit
  // tests stub the snapshot directly without a Qdrant.
  let fact_ids = [];
  if (oldMemory && typeof oldMemory.listFactIds === 'function') {
    fact_ids = await oldMemory.listFactIds();
  }
  state.snapshot = { vault_paths, fact_ids };
  state.phase_completed = 2;
  await checkpoint.write(state);
  return { vault_paths, fact_ids };
}

/**
 * Sleep for `ms` milliseconds. Lifted to a named function so tests that want
 * to override timing (none in DE10 — the tests stub on attempt count, not
 * wall-clock) have a single seam.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Re-embed a single entry through the new Memory instance. Pulls the source
 * text via `vault.read(id)` and calls `umAdd(body, { metadata, infer:false })`.
 *
 * Per the DE10 test contract: vault.read is called for every entry, regardless
 * of whether it originated from `vault_paths` or `fact_ids`. Real-world
 * deployments back this with a vault implementation that knows how to materialize
 * a fact-only payload as `{ frontmatter: { id }, body: <fact memory text> }`;
 * tests stub it directly.
 */
async function rebuildOne(newMemory, vault, id, { _qdrantClient, _embedProviderOverride } = {}) {
  const { frontmatter, body } = await vault.read(id);
  await umAdd({
    memory: newMemory,
    text: body,
    // forward-compat: no current writer emits userId in vault frontmatter
    // (canonical schema in docs/frontmatter-schema.md does not define it),
    // so RESOLVED_USER_ID is the always-fires path in production.
    userId: frontmatter.userId ?? RESOLVED_USER_ID,
    metadata: { id: frontmatter.id, ...frontmatter },
    infer: false,
    _qdrantClient,
    _embedProviderOverride,
  });
}

/**
 * Phase 3 (rebuild) — replay the snapshot through the new Memory with
 * `infer: false`.
 *
 * Resume contract: entries already in `state.processed_ids` are filtered out
 * before the loop runs. After a successful add, `state.processed_ids.push(id)`
 * runs synchronously so the in-memory state matches what we will persist at
 * the next checkpoint write.
 *
 * Retry contract (Adv-4): on `PROVIDER_RATELIMIT`-class errors we retry with
 * exponential backoff (`baseMs * 2^attempt`) up to `maxRetries`. On exhaustion
 * we write the checkpoint (so the operator's next `--resume` skips everything
 * we already processed) and throw a fresh `ProviderError` whose message
 * includes `--resume` so the CLI surface layer can print actionable guidance.
 * Non-rate-limit errors (e.g., `PROVIDER_UPSTREAM`, network blips) propagate
 * immediately — phase 3 doesn't second-guess the operator on configuration or
 * data-shape failures — but we still best-effort-persist progress made BEFORE
 * the failed entry so a `--resume` after the operator addresses the root cause
 * picks up from the last completed entry rather than replaying the whole phase.
 *
 * Atomic phase-advance contract: the FINAL entry's `processed_ids.push` AND
 * `phase_completed = 3` are bundled into a single terminal
 * `checkpoint.write(state)` call. Any per-entry progress writes triggered by
 * `progressEvery` happen BEFORE this terminal write — they NEVER set
 * `phase_completed = 3`. This avoids the crash window where phase 3's last
 * entry succeeds but the next CLI run sees `phase_completed = 2` and replays
 * the entire phase from scratch (idempotent, but expensive on a 10k-entry vault).
 *
 * @param {object} params
 * @param {{ add: (text: string, opts: object) => Promise<void> }} params.newMemory
 * @param {{ snapshot: { vault_paths: string[], fact_ids: string[] }, processed_ids: string[] }} params.state
 *   Mutable. Phase 3 pushes to `processed_ids` and sets `phase_completed`.
 * @param {{ write: (s: object) => Promise<void> }} params.checkpoint
 * @param {{ read: (id: string) => Promise<{ frontmatter: object, body: string }> }} params.vault
 * @param {number} [params.maxRetries=3]    - Per-entry retry budget on PROVIDER_RATELIMIT.
 * @param {number} [params.progressEvery=100] - Write a progress checkpoint every N entries.
 * @param {number} [params.retryBaseMs=100] - Base delay for exponential backoff. Tests pass 0.
 * @param {AbortSignal} [params.abortSignal] - Optional cancellation signal. When
 *   aborted, the rebuild loop persists progress + returns `{ cancelled: true }`
 *   without bumping `phase_completed`. Pair with `installSigintHandler` to wire
 *   a Ctrl-C handler in CLI driver scripts.
 * @returns {Promise<{ processed: number, cancelled?: boolean }>}
 */
export async function runPhase3Rebuild({
  newMemory,
  state,
  checkpoint,
  vault,
  maxRetries = DEFAULT_MAX_RETRIES,
  progressEvery = DEFAULT_PROGRESS_EVERY,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  abortSignal,
  _qdrantClient,
  _embedProviderOverride,
}) {
  const snapshot = state.snapshot || { vault_paths: [], fact_ids: [] };
  // Iterate vault entries first, then fact-only IDs. Order is incidental for
  // correctness (each add is independent), but stable for log readability.
  const allIds = [...(snapshot.vault_paths || []), ...(snapshot.fact_ids || [])];
  // Resume: skip anything already processed. Use Set for O(1) membership.
  const done = new Set(state.processed_ids || []);
  const todo = allIds.filter((id) => !done.has(id));

  // processed_ids may be a Set on a resumed state (the checkpoint client
  // upgrades it on first addProcessedId call). Re-canonicalize to Array here
  // so the final write surfaces the shape the tests assert and the JSON
  // serializer round-trips cleanly. addProcessedId is intentionally NOT used
  // — its Set upgrade trips assert.deepEqual against an Array.
  if (!Array.isArray(state.processed_ids)) {
    state.processed_ids = [...(state.processed_ids ?? [])];
  }

  let processedThisRun = 0;
  for (let i = 0; i < todo.length; i++) {
    // Graceful-cancel check (SIGINT via installSigintHandler, or any caller-
    // provided AbortSignal). Stops between entries so the in-flight rebuildOne
    // is never interrupted mid-write. Persist whatever was completed before
    // bailing — phase_completed stays unset so a subsequent --resume picks up
    // here; processed_ids carries the durability of completed entries.
    if (abortSignal?.aborted) {
      try { await checkpoint.write(state); } catch (_e) { /* best-effort */ }
      return { processed: processedThisRun, cancelled: true };
    }
    const id = todo[i];
    const isLast = i === todo.length - 1;

    // Per-entry retry loop. Exponential backoff on PROVIDER_RATELIMIT only;
    // every other error class propagates immediately.
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await rebuildOne(newMemory, vault, id, { _qdrantClient, _embedProviderOverride });
        break;
      } catch (err) {
        const isRateLimit = err instanceof ProviderError && err.class === 'PROVIDER_RATELIMIT';
        if (!isRateLimit) {
          // Persist progress made before this entry so --resume can pick up
          // after a transient upstream error (PROVIDER_UPSTREAM, network blip,
          // etc.). Best-effort: a checkpoint write failure must not mask the
          // original error the operator needs to see.
          try { await checkpoint.write(state); } catch (_e) { /* best-effort */ }
          throw err;
        }
        if (attempt >= maxRetries) {
          // Exhausted the budget. Persist whatever we managed to complete so
          // the next --resume picks up exactly where we left off, then throw
          // a fresh PROVIDER_RATELIMIT with --resume guidance baked in.
          try { await checkpoint.write(state); } catch (_e) { /* best-effort */ }
          throw new ProviderError({
            class: 'PROVIDER_RATELIMIT',
            provider: err.provider,
            status: err.status,
            message: `phase-3 rate-limit retries exhausted (${maxRetries} attempts) on entry "${id}": ${err.message}; pass --resume to continue from the last completed entry once the provider quota recovers`,
            retryable: true,
            cause: err,
          });
        }
        const delay = retryBaseMs > 0 ? retryBaseMs * Math.pow(2, attempt) : 0;
        if (delay > 0) await sleep(delay);
        attempt += 1;
      }
    }

    state.processed_ids.push(id);
    processedThisRun += 1;

    if (isLast) {
      // Terminal atomic write — Adv-4 contract: phase_completed AND the final
      // processed_id MUST land in the same writeCheckpoint call.
      state.phase_completed = 3;
      await checkpoint.write(state);
    } else if (processedThisRun % progressEvery === 0) {
      // Progress checkpoint — phase_completed deliberately NOT bumped here.
      await checkpoint.write(state);
    }
  }

  // Edge case: snapshot was empty or fully covered by processed_ids on resume.
  // Still need to advance phase_completed = 3 so phase 4 can run; do it in one
  // write to honour the atomic contract.
  if (todo.length === 0 && state.phase_completed !== 3) {
    state.phase_completed = 3;
    await checkpoint.write(state);
  }

  return { processed: processedThisRun };
}

/**
 * Phase 4 (stamp) — write the new embedding stamp into the NEW Qdrant
 * collection BEFORE the alias swap (spec §6.3, Round-4 Adv-1 ordering).
 *
 * The stamp records the active embedding shape ({provider, model, dim}) so
 * later boots and reindexes can verify the collection's contents match the
 * configured embedder. This call lands the stamp in `targetCollection` —
 * NOT in the alias — because the alias still points at the OLD collection
 * until phase 5 performs the swap. Writing the stamp into the alias here
 * would mutate the live readers' view before the new vectors are publicly
 * addressable.
 *
 * Atomic-phase-advance: when both `state` and `checkpoint` are provided, the
 * function advances `phase_completed: 4` in the same `checkpoint.write` call
 * that follows the stamp write. When either is absent (unit-test path), the
 * stamp write still happens but the checkpoint advance is skipped — the
 * caller is expected to be a test exercising the stamp mechanics in
 * isolation, not the full production pipeline.
 *
 * @param {object} params
 * @param {object} params.memory - Memory instance scoped to `targetCollection`.
 *   Forwarded to `stamp.write` so the underlying `writeStamp` writes against
 *   the NEW collection's vector store, not the alias-resolved one.
 * @param {{ write: (args: { memory: object, collection: string, stamp: object }) => Promise<void> }} params.stamp
 *   Stamp client; the `write` shape matches `server/lib/embedding-stamp.mjs`'s
 *   `writeStamp({ memory, collection, stamp })`. Tests pass a mock that
 *   captures the `collection` arg.
 * @param {string} params.targetCollection - The new sha8-derived collection name.
 * @param {object} params.newStampShape - `{ provider, model, dim }` for the new
 *   embedding model. Sourced from env+pricing in the production CLI; tests
 *   pass a literal.
 * @param {object} [params.state] - Mutable checkpoint state (optional).
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint] - Optional
 *   checkpoint client. When both `state` and `checkpoint` are present, the
 *   atomic phase-4 advance happens.
 * @returns {Promise<void>}
 */
export async function runPhase4Stamp({
  memory,
  stamp,
  targetCollection,
  newStampShape,
  state,
  checkpoint,
}) {
  // Write the stamp into the NEW collection. Per spec §6.3 ordering, this
  // MUST complete before phase 5's alias swap so the new collection is
  // self-describing the moment readers can reach it.
  await stamp.write({ memory, collection: targetCollection, stamp: newStampShape });

  // Atomic-phase-advance — only when production-mode args are present.
  // Tests exercising stamp.write order in isolation skip this branch.
  if (state && checkpoint) {
    state.phase_completed = 4;
    await checkpoint.write(state);
  }
}

/**
 * Phase 5 (swap) — perform the Qdrant alias swap (`alias → targetCollection`).
 *
 * Defensive resume read (Round-4 Adv-finding): the function reads the new
 * collection's stamp BEFORE swapping. If the stamp is missing — meaning
 * phase 4 either didn't run, ran partially, or was rolled back since the
 * checkpoint advanced — phase 5 throws with operator-actionable guidance to
 * `--resume from phase 4`. This narrows a corruption window that would
 * otherwise leave the alias pointing at an unstamped collection.
 *
 * Atomic-phase-advance: when both `state` and `checkpoint` are provided,
 * `phase_completed: 5` lands in the same write that occurs after the alias
 * swap completes. Tests omit these and observe only the swap mechanics.
 *
 * Old-collection retention is intentionally NOT performed here. The R10
 * mitigation default (`--keep-old=true`) keeps the old collection on disk
 * until the operator explicitly opts in to a drop; that drop happens in
 * phase 7's report/cleanup pass, not phase 5.
 *
 * @param {object} params
 * @param {{ updateAlias: (args: { alias: string, collection: string }) => Promise<void> }} params.qdrant
 *   Qdrant client; `updateAlias` performs an atomic alias-redirect.
 * @param {string} params.alias - Public alias name (e.g. `'memories'`).
 * @param {string} params.targetCollection - The new collection name to point at.
 * @param {{ read: (args: { collection: string }) => Promise<object|null> }} params.stamp
 *   Stamp client; only `read` is called. Returns `null` when no stamp exists.
 * @param {object} [params.state]
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint]
 * @returns {Promise<void>}
 */
export async function runPhase5Swap({
  qdrant,
  alias,
  targetCollection,
  stamp,
  state,
  checkpoint,
}) {
  // Defensive resume read — refuse if phase 4 didn't actually durabilize a
  // stamp. The error message MUST match `/no stamp.*rerun --resume from
  // phase 4/i` (test contract) so the CLI surface layer can recognize the
  // failure and print actionable resume guidance.
  const targetStamp = await stamp.read({ collection: targetCollection });
  if (!targetStamp) {
    throw new Error(
      `refusing alias swap: target collection ${targetCollection} has no stamp; rerun --resume from phase 4`,
    );
  }

  // Stamp present → swap is safe. The alias swap is atomic on Qdrant's side
  // (it's the whole reason we use an alias rather than mutating a fixed
  // collection name).
  await qdrant.updateAlias({ alias, collection: targetCollection });

  if (state && checkpoint) {
    state.phase_completed = 5;
    await checkpoint.write(state);
  }
}

/**
 * Phase 6 (verify) — confirm the alias swap landed by reading the stamp via
 * the alias and (optionally) sanity-checking the entry count.
 *
 * The plan tests don't cover phase 6 directly (DE12's e2e fills that role
 * against a real Qdrant). This implementation is intentionally conservative:
 *   • Read the alias-resolved stamp. Compare against `newStampShape` if
 *     provided; otherwise just confirm a stamp exists.
 *   • Optionally count entries in the alias and compare to `expectedCount`
 *     when both `qdrant.count` and `expectedCount` are available.
 *   • Return `{ matches, expected, actual, stamp }` so phase 7's report can
 *     surface a verification line for the operator.
 *
 * `matches` is `true` when the stamp resolves AND (when both sides are
 * present) the count matches; it is `false` if the stamp is missing or the
 * counts disagree. The function does NOT throw on mismatch — it returns the
 * shape so phase 7 can render a clear report. The caller (CLI orchestrator)
 * decides whether `matches: false` is fatal or just a warning.
 *
 * Atomic-phase-advance: same optional-state pattern as phases 4-5.
 *
 * @param {object} params
 * @param {object} [params.memory] - Memory instance scoped to the alias (for
 *   stamp.read via the public alias).
 * @param {{ read: (args: { collection: string }) => Promise<object|null> }} params.stamp
 * @param {object} [params.qdrant] - Optional client exposing `count(alias)`.
 * @param {string} params.alias - Public alias name.
 * @param {object} [params.newStampShape] - Expected `{ provider, model, dim }`.
 * @param {number} [params.expectedCount] - Expected entry count from snapshot.
 * @param {object} [params.state]
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint]
 * @returns {Promise<{ matches: boolean, expected: number|null, actual: number|null, stamp: object|null }>}
 */
export async function runPhase6Verify({
  memory,
  stamp,
  qdrant,
  alias,
  newStampShape,
  expectedCount,
  state,
  checkpoint,
}) {
  // Stamp readback — confirm the alias resolves to a stamped collection.
  const aliasStamp = await stamp.read({ collection: alias });

  // Stamp shape comparison — only when an expected shape was provided.
  let stampMatches = aliasStamp != null;
  if (stampMatches && newStampShape) {
    stampMatches =
      aliasStamp.provider === newStampShape.provider &&
      aliasStamp.model === newStampShape.model &&
      (newStampShape.dim == null ||
        aliasStamp.dim == null ||
        aliasStamp.dim === newStampShape.dim);
  }

  // Count comparison — only when both sides are available.
  let actualCount = null;
  let countMatches = true;
  if (qdrant && typeof qdrant.count === 'function' && typeof expectedCount === 'number') {
    actualCount = await qdrant.count(alias);
    countMatches = actualCount === expectedCount;
  }

  const matches = stampMatches && countMatches;

  if (state && checkpoint) {
    state.phase_completed = 6;
    state.verify = { matches, expected: expectedCount ?? null, actual: actualCount, stamp: aliasStamp };
    await checkpoint.write(state);
  }

  return {
    matches,
    expected: typeof expectedCount === 'number' ? expectedCount : null,
    actual: actualCount,
    stamp: aliasStamp,
  };
}

/**
 * Phase 7 (report) — print the operator-facing summary + restart instruction,
 * advance `phase_completed: 7`, and clean up the checkpoint state file.
 *
 * The restart instruction is load-bearing: the running server caches its
 * embedder and Memory client at boot, so even a successful alias swap won't
 * be observed by a long-running server until it restarts. The report makes
 * this requirement explicit.
 *
 * Cleanup behavior:
 *   • If `statePath` is provided, the state file is renamed to
 *     `<path>.archive.json` on a BEST-EFFORT basis. The atomic phase-advance
 *     (phase_completed=7) happens FIRST so the run is durably "complete" even
 *     if the rename fails. Archive failure is logged as a warning suggesting
 *     manual cleanup, but does not throw — a leftover state.json next to a
 *     phase=7 checkpoint is a non-fatal cleanup issue, not a correctness one.
 *   • Windows note: `fs.rename` over an existing target can throw
 *     `EEXIST`/`EPERM` (depending on Node version + filesystem). We mirror the
 *     unlink-fallback pattern from `server/lib/vault-write.mjs` to keep the
 *     happy path working on NTFS.
 *   • If the operator passed `--keep-old=false`, that decision is honored at
 *     the orchestrator level — phase 7 reports it, but the actual collection
 *     drop is delegated to a separate cleanup pass (out of scope for the
 *     phase-function unit; DE12's e2e exercises real cleanup).
 *
 * Atomic-phase-advance: same optional-state pattern as phases 4-6. Phase 7's
 * advance is the LAST checkpoint write; after it completes the next
 * `--resume` will see `phase_completed: 7` and exit cleanly with a "nothing
 * to do" message. The archive rename runs AFTER the atomic advance so the
 * durable "phase 7 complete" record exists even when archive fails.
 *
 * @param {object} params
 * @param {object} [params.state] - Mutable checkpoint state.
 * @param {{ write: (s: object) => Promise<void> }} [params.checkpoint]
 * @param {string} [params.statePath] - Path to the checkpoint state file. When
 *   provided, the file is renamed to `<path>.archive.json` after the final
 *   atomic write so the state directory is clean for future runs.
 * @param {{ stdout?: { write: (s: string) => any } }} [params.io] - Output
 *   sink (DI for tests). Defaults to `process.stdout`.
 * @param {{ rename?: (a: string, b: string) => Promise<void>, unlink?: (p: string) => Promise<void> }} [params.fs]
 *   Filesystem injection (tests can stub rename + unlink without touching
 *   disk). `unlink` is invoked for the Windows EEXIST/EPERM fallback path.
 * @returns {Promise<{ archivedTo: string|null }>}
 */
export async function runPhase7Report({
  state,
  checkpoint,
  statePath,
  io = { stdout: process.stdout },
  fs: fsLike,
} = {}) {
  // Render summary + restart instruction. Use a defensive accessor so a stub
  // io.stdout that doesn't implement `write` doesn't crash the phase.
  const out = io && io.stdout && typeof io.stdout.write === 'function'
    ? io.stdout
    : { write: () => {} };

  const fromShape = state?.from
    ? `${state.from.provider}/${state.from.model}/${state.from.dim ?? '?'}`
    : '(no prior stamp)';
  const toShape = state?.to
    ? `${state.to.provider}/${state.to.model}/${state.to.dim ?? '?'}`
    : '(unknown)';
  const processedCount = Array.isArray(state?.processed_ids)
    ? state.processed_ids.length
    : (state?.processed_ids?.size ?? 0);
  const verify = state?.verify ?? null;

  out.write(
    `reindex complete; restart the server to load the new collection\n` +
    `From: ${fromShape}\n` +
    `To:   ${toShape}\n` +
    `Entries processed: ${processedCount}\n` +
    (state?.estimate
      ? `Estimate: ${state.estimate.entries} entries / ~${state.estimate.tokens} tokens / ~$${(state.estimate.cost_usd ?? 0).toFixed(4)} USD\n`
      : '') +
    (verify
      ? `Verify: matches=${verify.matches}` +
        (verify.expected != null ? ` (expected=${verify.expected}, actual=${verify.actual})` : '') +
        `\n`
      : '') +
    `Target collection: ${state?.target_collection ?? '(unknown)'}\n`,
  );

  // Atomic-phase-advance: this MUST happen before the archive rename so the
  // run is durably "complete" (phase_completed=7) even if the archive step
  // fails. A leftover state.json sitting next to a phase=7 checkpoint is a
  // cleanup issue, not a correctness issue — a subsequent --resume sees
  // phase_completed=7 and exits cleanly.
  if (state && checkpoint) {
    state.phase_completed = 7;
    await checkpoint.write(state);
  }

  // Archive checkpoint state file (BEST-EFFORT). Renaming preserves a
  // forensic trail without polluting the active state slot. On Windows,
  // fs.rename over an existing target throws EEXIST/EPERM — we mirror the
  // unlink-fallback pattern from server/lib/vault-write.mjs:124-130 to keep
  // the happy path working on NTFS. If the rename ultimately fails we warn
  // and continue (the run IS complete; archive is a janitor step).
  let archivedTo = null;
  if (statePath) {
    const fsImpl = fsLike ?? fs;
    if (typeof fsImpl.rename === 'function') {
      const target = `${statePath}.archive.json`;
      try {
        await fsImpl.rename(statePath, target);
        archivedTo = target;
      } catch (err) {
        if ((err.code === 'EEXIST' || err.code === 'EPERM') && typeof fsImpl.unlink === 'function') {
          // Windows: rename-over-existing not always atomic. Unlink target
          // then retry the rename once.
          try { await fsImpl.unlink(target); } catch { /* ignore */ }
          try {
            await fsImpl.rename(statePath, target);
            archivedTo = target;
          } catch (err2) {
            out.write(
              `[reindex] archive rename failed: ${err2.message}; manual cleanup of ${statePath} recommended\n`,
            );
          }
        } else {
          out.write(
            `[reindex] archive rename failed: ${err.message}; manual cleanup of ${statePath} recommended\n`,
          );
        }
      }
    }
  }

  return { archivedTo };
}
