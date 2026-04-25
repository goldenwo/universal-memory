# Review playbook

How we run multi-round Opus reviews on plans, specs, and major changes.
Distilled from the v0.5 13-round cycle (R1–R12, plus R13 sanity-check) and
re-confirmed by v0.6's R1/R2 spec + R1/R2 plan + R1/R2 Phase B+C cycles —
all converged on the same shape.

The goal is not "more rounds" — it's **lens diversity**. Most material
findings cluster in a few specific lenses; running them deliberately catches
more than five sequential general reviews would.

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
