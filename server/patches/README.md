# `server/patches/` — patch-package vendored patches

This directory holds patches that `patch-package` applies to vendored
`node_modules/` upstream sources at Docker-build time. Each patch is
version-pinned by filename (`pkg+x.y.z.patch`) and accompanied by a
SHA-256 source-hash pin (`pkg+x.y.z.source.sha256`) that the Dockerfile
verifies before applying the patch. The pin covers the ONE patched file
(`dist/oss/index.mjs`) — whole-tarball integrity rides the lockfile's
sha512. Hash drift = the published file mutated; build fails loud.

## Files

- `mem0ai+3.1.6.patch` — exactly TWO hunks against
  `node_modules/mem0ai/dist/oss/index.mjs` (#231 reconciliation; the
  W6.2-era patch carried 15 — see "History" below for why it shrank):
  - **pg import hunk (1 hunk, the W6.2 successor).** mem0 3.x made almost
    every provider an OPTIONAL peer (npm installs none of them) and loads
    them lazily, so the 13 W6.2 import-conversion hunks are retired.
    `pg` is the one surviving REQUIRED-peer static import whose package
    the Dockerfile still removes: the hunk converts
    `import pkg from "pg"` to a fail-soft dynamic import with a
    `let pkg = {}` catch-default — 3.1.6's module-init destructure pulls
    TWO names (`var { Client, escapeIdentifier } = pkg;`), and the `{}`
    default keeps it non-throwing when pg is absent. Emits the
    `[mem0-patch] pg not installed (peer-skipped) — expected on boot per
    W6.2` warn line the gates key on.
  - **Legacy-qdrant 400 "already exists" tolerance (1 hunk).** qdrant
    ≤1.7 returns HTTP 400 — not 409 — for a duplicate
    `createCollection`; mem0ai's `Qdrant.ensureCollection` catches only
    409/401/403, so against a legacy server with an existing collection
    (e.g. the Pi's `y0mg/qdrant-raspberry-pi` v1.7.3, used because the
    official image SIGABRTs on that host) init fails and — via mem0 3.x's
    deferred-init error surfacing — the first public call (the server
    warmup) throws and the HTTP server never binds (the #157 failure).
    The hunk adds a guarded case: a 400 whose body
    (`error.data.status.error`) says "already exists" is treated like a
    409 (falls into the existing dimension-verify branch); genuine 400s
    still throw. **Invariant:** the guard keeps BOTH conjuncts — the
    400-status check AND the body match; a bare `status === 400` guard is
    never acceptable. Contract-locked by
    `server/test/patch-contract.test.mjs`, including a red-control
    mutation that proves the contract rejects a body-match-stripped
    guard.
- `mem0ai+3.1.6.source.sha256` — single-line SHA-256 of the PRISTINE
  (pre-patch) upstream `dist/oss/index.mjs` for mem0ai@3.1.6. Verified at
  Docker build time and by the deps-guard CI job.

## Reconciliation procedure (when `server/package.json` bumps `mem0ai`)

The patch is **version-pinned**. A `mem0ai` version bump invalidates
both the `.patch` file and the `.sha256` pin and requires the procedure
below. The build-time hash-verify step ensures this can NEVER drift
silently — a mismatched hash fails the build with
`FAIL: mem0ai source hash drift`.

### Canonical counts (mem0ai@3.1.6)

**A reconciliation pass MUST update all three to whatever the new
version emits** (and the mirrors: `server/Dockerfile`'s
`W6.2-reconciliation-counts` block + `patch-contract.test.mjs`):

| Counter | Value | how measured |
|---|---|---|
| `awaitImports` | **7** | `grep -c "await import(" node_modules/mem0ai/dist/oss/index.mjs` (6 upstream lazy sites + 1 ours: pg) |
| `memPatchLogs` | **1** | `grep -c "[mem0-patch]" node_modules/mem0ai/dist/oss/index.mjs` (the pg warn line) |
| `bootRuntimeWarns` | **1** | `docker compose logs memory-server \| grep -c "[mem0-patch]"` (pg is rm'd from the image, so its fail-soft warn fires) |

### Step-by-step

1. **Bump `mem0ai` in `server/package.json`** and run `npm install` to
   regenerate `package-lock.json`. Check the peer landscape FIRST: mem0's
   peer ranges may need `overrides` entries (see "Overrides" below), and
   the required-vs-optional peer split determines both the patch surface
   and the Dockerfile rm list.

2. **Save a PRISTINE copy** of `node_modules/mem0ai/dist/oss/index.mjs`
   BEFORE touching it — it is the ONLY valid source for the step-8 pin.

3. **Pre-flight: TLA-support probe.** Confirm the new emitted ESM accepts
   the dynamic-import shape: copy the pristine file next to itself (so
   its imports resolve), convert one static import to the
   `await import()` shape, and `import()` the copy by file URL. On FAIL:
   the bundle changed shape; find the equivalent fail-soft shape before
   proceeding.

4. **Detect the new static-import surface.** The contract test's pinned
   ALLOWLIST is the tool: run
   `node --test test/patch-contract.test.mjs` against the bare tree —
   the allowlist test names every non-allowlisted top-level static
   import (these are your patch targets and/or new allowlist entries;
   adding to the allowlist requires the package to be a mem0 regular dep
   or shipped-in-image).

5. **Author the patch hunks** (shape table below; watch the module-init
   destructure hazard) and re-apply the legacy-qdrant 400 hunk to the
   new `ensureCollection` (keep BOTH invariant conjuncts). If upstream
   has widened its own catch to a body-matched 400, drop the hunk and
   its contract asserts instead. Generate via `npx patch-package mem0ai`.

6. **Verify the patch applies with the expected counts** — run the full
   contract file: `node --test test/patch-contract.test.mjs` (counts,
   allowlist, both hunks, red-control mutation, module load).

7. **This order is critical: the hash-pin is the lock, not a
   checkpoint** — pinning before verifying could silently lock a broken
   patch to the new source.

8. **Write the source-hash pin from the STEP-2 PRISTINE COPY** (never
   from the patched tree — hashing `node_modules` after step 5 pins the
   PATCHED bytes and every subsequent build fails the pre-patch verify):
   ```bash
   sha256sum <pristine-copy>/index.mjs | awk '{print $1}' > server/patches/mem0ai+<NEW>.source.sha256
   ```

9. **Update the canonical counts** here AND in `server/Dockerfile`'s
   `W6.2-reconciliation-counts` block AND `patch-contract.test.mjs`, and
   re-derive the Dockerfile rm list from the REAL installed tree.

10. **Record the operator-visible boot-log delta** (the `[mem0-patch]`
    warn count) in the NEXT release's GitHub release notes. There is no
    in-repo CHANGELOG (scrubbed 2026-07-28; do not recreate it) — this
    README is the durable reference.

11. **Cleanup prior-version artifacts** once green in CI:
    ```bash
    git rm server/patches/mem0ai+<OLD>.patch server/patches/mem0ai+<OLD>.source.sha256
    ```

## Overrides (peer-range reconciliation)

`server/package.json` carries `overrides` forcing mem0ai's stale
optional-peer ranges (`@anthropic-ai/sdk`, `@google/genai`) to our
top-level majors — npm ERESOLVEs on conflicting `peerOptional` edges even
though it never installs optional peers. The override must DEDUPE (one
top-level SDK copy, none nested under `node_modules/mem0ai/`): nesting
would make mem0's lazy `import()` load a different SDK version than UM's
provider registry. `test/lint/no-nested-provider-sdk.test.mjs` locks
this in the deps-guard suite. `--legacy-peer-deps` is forbidden (blanket
weakening of the resolution check deps-guard exists to run).

## Known reconciliation hazards

1. **Module-init destructures of patched names.** If a patched import is
   followed at module top-level by `var { A, B } = patchedName;` (any
   synchronous use that would throw on `undefined`), the catch block
   must leave the variable a safe default (`let pkg = {}`) so the
   destructure is non-throwing at module load. In mem0@3.1.6 `pg`
   triggers this with TWO names:
   ```js
   let pkg = {}; try { pkg = (await import("pg")).default; } catch (e) { console.warn(...); }
   var { Client, escapeIdentifier } = pkg;  // needs the {} default
   ```

2. **Read-API drift is part of the reconciliation surface.** The 2.4.6→
   3.1.6 major flipped entity payload keys (camel→snake), renamed
   `limit`→`topK`, added a default search threshold, and hard-required
   snake entity filters on getAll — see `lib/mem0-read.mjs` for the
   adapters and docs/plans/2026-08-18-mem0ai-3x-spec.md (F15-F17/D8) for
   the full record. A future bump must re-verify those adapters against
   the new internals, not assume them.

3. **Peer-satisfying lockfile flags.** Several critical direct deps
   (`@anthropic-ai/sdk`, `@google/genai`, `@qdrant/js-client-rest`,
   `ollama`, `better-sqlite3`) are flagged peer-satisfying because mem0
   also declares them as peers — `npm ci --omit=peer` would strip them.
   The Dockerfile uses `npm prune --omit=dev` + surgical `rm -rf`;
   **this order matters because `npm prune` after `rm` reinstalls the
   tree to match the lockfile**.

## Patch shape table (use to author new hunks)

| Original shape | Pattern | Patched form |
|---|---|---|
| Named (`{ X }`) | `import { X } from "pkg";` | `let X; try { ({ X } = await import("pkg")); } catch (e) { console.warn("[mem0-patch] pkg not installed (peer-skipped) — expected on boot per W6.2"); }` |
| Named with rename | `import { X as Y } from "pkg";` | `let Y; try { ({ X: Y } = await import("pkg")); } catch (e) { console.warn("[mem0-patch] pkg ..."); }` |
| Default | `import X from "pkg";` | `let X; try { X = (await import("pkg")).default; } catch (e) { console.warn("[mem0-patch] pkg ..."); }` |
| Multi-line named | `import {\n A, B, C\n} from "pkg";` | `let A, B, C; try { ({ A, B, C } = await import("pkg")); } catch (e) { console.warn("[mem0-patch] pkg ..."); }` |
| Module-init destructure follow-up | patched import followed by `var { Y } = X;` | Initialize `let X = {}` in the declaration so the destructure is non-throwing |

The `— expected on boot per W6.2` suffix is intentional: it makes the
warn line grep-able back to this README's reconciliation record (the
scrubbed CHANGELOG no longer exists), giving operators a self-documenting
trail when they tail logs.

## History

The original W6.2 patch (mem0ai@2.4.6) carried 15 hunks: 14 import
conversions across 11 unused-provider packages that npm auto-installed
as REQUIRED peers, plus the qdrant hunk. mem0 3.x flipped those providers
to optional peers with lazy loading, collapsing the patch to 2 hunks
(#231, 2026-08-18). The W6.2 name survives in the warn-line suffix and
the Dockerfile block name for operator-trail continuity.

## Anti-goals (preserved from W6.2 spec + #231)

- **No runtime patch-package dep.** `patch-package` is `devDependencies`
  only; the Dockerfile installs the full tree (incl. devDeps) at build
  time, applies the patch, then `npm prune --omit=dev`.
- **No `postinstall` hook in `server/package.json`.** Host installs
  must NOT auto-patch; the Dockerfile is the canonical patch site.
  Tests that require the patched mem0 invoke `npx patch-package`
  explicitly via CI steps or a local run.
- **Never pin the hash from a patched tree** (step 8).
- **Never weaken the qdrant-hunk invariant** to a bare status check.
