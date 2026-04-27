# Review playbook

How we run multi-round Opus reviews on plans, specs, and major changes.
Distilled from the v0.5 13-round cycle (R1–R12, plus R13 sanity-check) and
re-confirmed by v0.6's R1/R2 spec + R1/R2 plan + R1/R2 Phase B+C cycles —
all converged on the same shape.

The goal is not "more rounds" — it's **lens diversity**. Most material
findings cluster in a few specific lenses; running them deliberately catches
more than five sequential general reviews would.

## Contents

- [When to use](#when-to-use)
- [Cadence](#cadence)
- [The four high-yield specialized lenses](#the-four-high-yield-specialized-lenses)
- [Lens diversity > round count](#lens-diversity--round-count)
- [Convergence is observable](#convergence-is-observable)
- [Rename sweep protocol](#rename-sweep-protocol)
- [Fictional-reference check](#fictional-reference-check)
- [Punchlist scope](#punchlist-scope-per-feedback_punchlist_scopemd)
- [Pairing model](#pairing-model)
- [Past examples](#past-examples)
- [When to skip](#when-to-skip)
- [Anti-patterns](#anti-patterns)
- [See also](#see-also)
- [Recurring lessons](#recurring-lessons) — case studies that produced enforced rules
  - [v0.6 — phase-boundary smoke gate](#v06--phase-boundary-smoke-gate)

## When to use

- Spec / design docs before implementation starts
- Implementation plans (multi-week phases with subagent dispatch)
- Major in-flight changes (pre-merge, post-implementation)
- Anything where rolling back later is expensive

For small / mechanical changes (≤200 LOC, ≤2 files, no API changes), run a
single targeted review or skip and rely on standard code-review.

## Cadence

```
Round 1   (general Opus)            ──┐
Round 2   (general Opus)              ├── 3–5 general rounds
Round 3   (general Opus)              │   surface obvious issues
Round 4   (general Opus, optional)  ──┘
                  │
                  ▼
Round 5   (specialized lens A)      ──┐
Round 6   (specialized lens B)        │
Round 7   (specialized lens C)        ├── lens passes — high yield
Round 8   (specialized lens D)        │
Round 9   (specialized lens E)      ──┘
                  │
                  ▼
Round 10  (rename sweep + grep)
Round 11  (sanity check)            ── two consecutive zero-finding rounds
Round 12  (zero findings)              = CONVERGED
```

The shape is invariant; the **count** can be 8 or 13 depending on how many
material findings each lens surfaces. Stop when two consecutive rounds
return zero material findings — that's the convergence signal.

## The four high-yield specialized lenses

In v0.5 + v0.6, each of these surfaced material findings the prior 4–5
general rounds missed. **Always run all four.** They take ~20 min each.

### 1. Cross-system / cross-section

> "Find the place where component A and component B disagree about the
> same fact."

v0.5 found: middleware-chain step 3 unconditionally bypassed auth that
step 4 was supposed to enforce. v0.6 R1 found: 7 v0.5 shell CLIs lacked
the new Authorization header, producing silent 401s on day-one for any
non-loopback install.

Prompt the reviewer to look across module boundaries — what does
component X assume that component Y guarantees, and is that guarantee
actually written down?

### 2. Adversarial / threat-model

> "How would an attacker (or a hostile bridge upstream, or a malicious
> markdown file in the vault) abuse this?"

v0.5 found: HTML-entity-escaped `</external-summary>` markers in bridge
content defeat naive escaping because LLM consumers decode entities back
to raw tags during reasoning — the fix was REJECT-on-literal-marker, not
encode-and-hope. v0.6 found: `realpath`-on-the-target-of-the-check
follows attacker-planted symlinks; only `realpath` the trusted parent
and `lstat` the leaf.

Don't read this lens as "audit for OWASP top 10" — read it as "what's
the weirdest input that still type-checks?"

### 3. UX / migration

> "What does the user have to do to get from version N-1 to version N?
> Where will they get stuck?"

v0.5 found: a fictional `install.sh` env-loader at lines ~53-65 that the
spec assumed existed but nobody had ever written. Caught only because
the reviewer ran `grep` against the spec's reference. v0.6 found: 6
shell CLIs needed `Authorization` header retrofit; without that, every
non-loopback install would silently 401.

This lens routinely surfaces fictional references — instructions in the
spec that point at code that doesn't exist or has been renamed. Cheap
insurance.

### 4. Future-proofing / maintainability

> "Will this design rot in 6 months when someone adds a third backend?
> What lock-in are we shipping?"

v0.5 found: error codes hard-coded as strings throughout the codebase
made future renames a 30-file sweep — fix was the `ERROR_CODES` central
table. v0.6 found: bridge contract needed extracting from claude-mem-
specific code so a second bridge could be added without a fork.

Distinct from adversarial — this is about the SECOND user of the
abstraction, not the first.

## Lens diversity > round count

This is the single biggest lesson from v0.5. Running 4 parallel
specialized lenses in **one** round consistently surfaced more findings
than 4 sequential general rounds would have. We learned this the hard
way: R1–R5 of v0.5 were mostly general, and R6–R9 (specialized) caught
findings that should have surfaced earlier.

For v0.6's plan review we ran the 4 lenses in parallel from R1 — it
converged in 3 rounds (R1: 18, R2: 5, R3: 0) instead of v0.5's 12.

## Convergence is observable

Two consecutive rounds returning zero **material** findings is the
shippable signal. "Material" excludes:
- Style nits
- Hypothetical concerns with no concrete failure mode
- "Should we maybe also..." scope expansions
- Things explicitly deferred to a later version

A round that returns 0 material + N nice-to-haves still counts as a
convergence round.

If you cross 10 rounds without convergence, that's a signal to **stop and
rescope** rather than push through. The plan or spec is probably wrong
in a way the lenses are correctly catching.

## Rename sweep protocol

Whenever a review round renames a public symbol, error code, file path,
or env var, the IMMEDIATE NEXT round must include a `grep` pass for
stale references. v0.5 R10 found 1 stale ref after R9's rename; R11
found 1 more.

The pattern: same-class bugs cluster around renames. Don't trust that
"I fixed all of them" — grep is cheap insurance.

```bash
# After renaming SYMBOL or PATH:
git diff HEAD~ | grep -E '^\-' | grep -oE 'SYMBOL_OR_PATH' | sort -u
# For each, grep the rest of the codebase to confirm zero remaining refs.
```

## Fictional-reference check

For specs and plans, run a `grep` of the document against the actual
codebase to flag any reference (file path, function name, line number,
flag, env var) that doesn't exist. v0.5 R8 caught a fictional
`install.sh` env-loader; v0.6 plan R2 caught `um-forget` / `um-supersede`
mislabeled as Node when they were bash.

The codebase-reality lens is a one-pass linter for this — bake it into
every review until you've shipped twice without finding any.

## Punchlist scope (per `feedback_punchlist_scope.md`)

When aggregating findings across multiple lenses:

- **Mechanical findings:** resolve autonomously (typos, missing imports,
  formatting, stale references, simple sign errors).
- **Design-heavy findings:** surface to the user. ≤2 unauthorized
  directional calls per execution session (i.e., per Phase). Beyond that,
  pause and align.
- **Report metrics in scope, not minutes** — Claude can't measure
  wall-clock time accurately. "5 findings closed, 2 surfaced for design
  call" is a useful report; "took 45 min" is not.

## Pairing model

Per `feedback_opus_reviews.md`: for design-depth review on plans / specs /
architecture docs, **pair two Opus reviewers** with different lenses.
Sonnet misses design gaps that Opus catches in side-by-side comparison.

Pair-model pattern:
- Reviewer A: spec-alignment + cross-system
- Reviewer B: adversarial + UX/migration + future-proofing

Aggregate the two reports BEFORE responding to either. Often a finding
that one reviewer flagged as low-confidence becomes high-confidence when
the other independently flagged a related symptom.

## Past examples

- **v0.5 R6:** specialized cross-system lens caught the 7 v0.5 shell CLIs
  silent-401 issue — would have been a day-one outage on every non-
  loopback install.
- **v0.5 R8:** UX/migration lens caught the fictional install.sh env-
  preservation that nobody had written.
- **v0.5 R9:** future-proofing lens drove the error-code prefix
  discipline rename, surfacing 8 maintainability lock-ins.
- **v0.6 spec R10–R12:** rename sweep protocol caught stale `.bridges/`
  paths after R9's `.local/locks/` reorg.
- **v0.6 plan R2:** adversarial lens caught the `realpath` symlink-bypass
  + the LLM-entity-decode escape weakness.

## When to skip

- Hot-fix patches: skip review rounds, ship fast, schedule the playbook
  for the next non-hot-fix change.
- Documentation-only changes: one read-through is enough.
- Already-converged designs (R12 caught nothing): a single sanity round
  on the implementation diff is fine; don't re-run the full cycle.

## Anti-patterns

- **Running 12 rounds of the same general prompt** — diminishing returns
  start at round 4. Force lens specialization at R5+.
- **Trusting "I'll fix all of them"** without a grep — same-class bug
  clusters bite. Always sweep.
- **Treating R0 as "implementation done, time to review"** — R0 should be
  the spec / plan, not the implementation. Reviewing implementation
  without first reviewing the plan that produced it doubles the catch
  cost.
- **Counting non-material findings toward convergence** — "2 nits" is
  not the same as "0 material." Convergence requires zero of the latter.

## See also

- `feedback_opus_reviews.md` (auto-memory) — pairing model for plans
- `feedback_punchlist_scope.md` (auto-memory) — directional-call budget
- `MIGRATION.md` v0.5→v0.6 — reflects the security findings R1/R2 surfaced
- `docs/plans/2026-04-22-v0.5-design.md` — v0.5 spec retrospective notes
- `docs/plans/2026-04-24-v0.6-design.md` — v0.6 spec with R1–R12 history

---

## Recurring lessons

Case studies of release cycles that surfaced rules worth enforcing
beyond the round-by-round review process. Each lesson is a story first,
a rule second, with the enforcement mechanism noted inline so a future
contributor can find both the *what* and the *how*.

### v0.6 — phase-boundary smoke gate

#### What happened

PR #31 (the v0.6.0-alpha release) opened with 79 phase commits accumulated
on the `v0.6` work-branch over several weeks. Those commits had been
merged directly into `v0.6` without an intermediate PR, so CI had never
exercised any of them against a fresh-stack smoke run or a shellcheck
sweep. When the release PR finally opened, every previously-silent
contract drift came due — one CI round at a time, across 9 sequential
fix commits.

Five of the nine were **true phase regressions** — contract changes a
planned phase task introduced that broke the live-stack contract:

- `5f9b68a` — Phase D.2 added `BRIDGES.md` at the repo root, outside the
  `server/` Docker build context. The image never shipped the file and
  the resolver couldn't find it inside `/app/`. Fix: co-locate under
  `server/config/`.
- `4dfc633` — Phase B made bearer auth mandatory on `/api/*`; Phase C.5
  made `/metrics` loopback-only. The smoke didn't send the bearer header
  and called `/metrics` from outside the container. Fix: add the header,
  scrape `/metrics` via `docker exec`.
- `79480c0` — Phase C.6/C.7 introduced a per-IP token-bucket limiter at
  60 RPM / 10 burst. The smoke's dozens of `/api/*` calls drained the
  bucket and 429'd. Fix: CI `.env` override raised the cap.
- `5ff8cd2` — Phase E.2 dropped file-level SC2034 disables but didn't
  finish migrating capture sites to `_tx_capture`. 14+ shellcheck
  warnings accumulated silently. Fix: complete the migration.
- `05b1b32` — Phase E.4 added a `grep | tail | cut` pipeline that exits
  1 under `set -o pipefail` when grep finds no match. With `set -e` this
  killed `install.sh` silently on re-runs. Fix: trailing `|| true`.

Four of the nine were **debugging-cascade artifacts** — bugs introduced
*by the iteration fixes themselves*, surfaced only because someone was
finally re-running the gate that had been skipped:

- `07d778a` — `5f9b68a` had used `git add -A` and accidentally committed
  `.claude/settings.local.json`. Cleanup commit untracked it and added
  the path to `.gitignore`.
- `ca8c4a0` — `4dfc633`'s `/metrics` fix used `docker compose ps -q
  memory-server`, which doesn't reliably detect the container in CI.
  Switched to `docker ps --format '{{.Names}}' | grep memory-server`.
- `673b056` — `79480c0`'s rate-limit override appended to `.env` then
  ran `docker compose restart`. `restart` reuses the running container's
  env and does NOT re-read `env_file`, so the override didn't take
  effect. Switched to `up -d --force-recreate --no-deps`.
- `3876b10` — `5ff8cd2` placed a `# shellcheck disable=SC2034` directive
  above the `local tx_out tx_exit=0` declaration; shellcheck flags the
  next-line assignment, not the local. Moved the directive.

Total CI wall cost: **~23 minutes across 9 round trips** (measured from
GitHub Actions run history, not estimated). On top of that: the cognitive
cost of nine sequential diagnoses across phases the contributor hadn't
touched in weeks. That second cost is the one that matters and the one
that's hard to put a number on — context-switch back into a phase
nominally "done" three weeks ago is expensive every time.

#### What we learned

The five true phase regressions all shared a property: they manifested
**only** against the production-shaped Docker stack — not against unit
tests, not against the dev environment, not against a partial smoke run.
Phase changes that affect runtime contracts (auth defaults, rate-limit
thresholds, container file layout, network reachability, env-file
semantics) are invisible to `npm test`. The unit suite was passing on
every one of those phase commits at the time it landed.

The four cascade artifacts shared a different property: they only
manifested when someone finally tried to **re-run the gate** that had
been skipped at phase boundary. The fix authors were making
container-shape changes against a stack they hadn't recently exercised,
so each fix introduced its own new contract-shape bug. Cascade bugs
look like negligence in retrospect; in the moment they look like
"obviously this is the right `docker` invocation, I've used it a
hundred times" — the kind of thing only a fresh run would have flagged.

Both classes of regression compress to "minutes of debugging at the
moment of introduction" if a gate runs at the phase boundary. They
expand to "hours of cascading diagnosis" if the gate runs only at
release time. The wall-clock CI difference is small (~23 min total
either way); the human-cost difference is large.

#### The rule going forward

A **phase boundary** is the commit that closes a planned phase task per
the implementation plan — the integration commits at the end of each
phase block (`B.14` for Phase B, `C.12` for Phase C, `D.10` for Phase
D, etc.). Phase boundaries are identifiable from the plan's task list.

**Mark integration commits with a `Phase-boundary:` git trailer** so
tooling can detect them unambiguously:

```
feat(server): integration gate for Phase B

Phase-boundary: B.14
```

The trailer is the canonical signal. Subject-line patterns like
`feat(B.14):` or `(B.13)` in trailing parens also match the gate's
detection regex (mirroring v0.6's actual commit conventions), but the
trailer is the only form that's guaranteed unambiguous.

> **Note on the SHA list above.** The 9 SHAs cited in the catches
> section are *fix* commits (the work that closed each regression).
> The introducing commits — Phase D.2 `2f5a21a`, Phase E.2 `00a6b05`,
> Phase E.4 `18d1a28`, etc. — are noted in the body of each fix
> commit. Read both: the fix shows what the live-stack contract drift
> looked like; the introducing commit shows what the phase change
> intended.

Before pushing a phase-boundary commit to a `v0.X` work-branch, run
locally (in this order — unit tests catch some regressions smoke alone
misses, e.g. Phase E.4 `05b1b32` surfaced via `install.test.sh` T18
idempotency, not via smoke):

1. **Smoke against a freshly-rebuilt stack:**
   ```bash
   ( cd server && docker compose up -d --force-recreate --no-deps memory-server )
   bash server/test/smoke.sh
   ```
   `--force-recreate` is required — `docker compose restart` does NOT
   re-read `env_file` (catch `673b056`).

2. **Server installer unit tests** (catches T18-class idempotency bugs):
   ```bash
   ( cd server && bash install.test.sh )
   ```

3. **CLI installer unit tests** (parity with CI's installer-test job):
   ```bash
   bash installer/install-cli.test.sh
   ```

4. **Shellcheck — file list MUST mirror `.github/workflows/smoke.yml`**
   so the local gate catches the same warnings CI would. Drift between
   the local recipe and CI's command was an R2 finding; this list is
   the canonical one (re-sync if either side changes):
   ```bash
   shellcheck --severity=warning \
     installer/*.sh installer/lib/*.sh \
     plugins/claude-code/universal-memory/bin/um \
     plugins/claude-code/universal-memory/bin/um-capture \
     plugins/claude-code/universal-memory/bin/um-forget \
     plugins/claude-code/universal-memory/bin/um-preview \
     plugins/claude-code/universal-memory/bin/um-supersede \
     plugins/claude-code/universal-memory/bin/um-tunnel \
     plugins/claude-code/universal-memory/hooks/*.sh \
     plugins/claude-code/universal-memory/hooks/lib/*.sh
   ```

Per measured per-step durations from the `smoke.yml` workflow on PR #31's
final green run: smoke is ~45s with image cached, ~90s on first build;
unit tests ~30s combined; shellcheck is ~7s. Total realistic per-phase-
boundary cost: ~2 minutes once images are warm, ~5 minutes on the first
run. Cheaper than re-opening a closed phase to chase a cascade bug.

#### Enforcement

A pre-push git hook at `scripts/githooks/pre-push` runs all four gates
automatically when pushing to a branch matching `v*`. **The filename
must be exactly `pre-push`** — that is the only name git invokes for
this hook. Install once per clone:

```bash
git config --local core.hooksPath scripts/githooks
```

Verify:

```bash
git config --local --get core.hooksPath
# → scripts/githooks
```

The hook detects phase-boundary commits by:
1. **Recommended:** an explicit `Phase-boundary: <X>.<N>` git trailer
   on the integration commit (canonical signal).
2. **Fallback:** any `<X>.<N>` token in the subject's parens (matches
   v0.6's `feat(server): ... (B.13)` convention AND the alternative
   `feat(B.14):` style). Word-boundaries minimize false positives.

Either is sufficient to fire the gate. The trailer is unambiguous; the
pattern fallback may have false positives (gate runs unnecessarily —
no harm, just slow) or false negatives (gate doesn't fire on a phase
boundary that uses neither convention).

Bypass with `git push --no-verify` only for hot-fix paths where the
contributor takes explicit responsibility for the gate skip — the next
non-hot-fix push will catch any drift.

CI (`smoke.yml`) on push to `v*` branches re-runs the same gates as a
backstop. If you forget to install the local hook, CI catches you
eventually, but the local hook is the cheap-and-fast checkpoint that
keeps phases from stacking silent regressions.

#### For future plans

Each future `<date>-v0.X-plan.md` should include a preamble line in
its **Execution handoff** section:

> Review-gate: `docs/process/review-playbook.md` § Recurring lessons
> § v0.6 — phase-boundary smoke gate. Install the pre-push hook
> before opening the work-branch.

(Design docs don't currently carry an Execution-handoff section, so
the preamble convention applies to plan docs only. If a future design
doc adopts a similar handoff section, mirror the line there too.)

This keeps the rule discoverable at the moment a contributor opens the
plan to start work, not just when they happen to browse the playbook.
