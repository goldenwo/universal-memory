# Contributing to universal-memory

Thanks for considering a contribution. universal-memory follows a disciplined development pattern — this document captures what to expect so a first PR lands as smoothly as a tenth one.

## Quick links

- Bug reports and feature requests → [GitHub Issues](https://github.com/goldenwo/universal-memory/issues)
- Code changes → Pull Requests against `main`
- Security issues → see [SECURITY.md](SECURITY.md)
- Architecture context → [docs/architecture.md](docs/architecture.md)
- Quickstart → [docs/quickstart.md](docs/quickstart.md)

## Setup

Local development assumes Docker (for the memory server stack) and Node 20+. Follow [docs/quickstart.md](docs/quickstart.md) for the standard install. For server-side work:

```bash
cd server
docker compose up -d
npm install
npm test
```

For installer / plugin shell work, also install [shellcheck](https://www.shellcheck.net/).

## Issue flow

- **Search existing issues first** — open and closed. Many discussions land in closed issues that are still the best reference.
- **Bug reports** include: reproduction steps, expected behavior, actual behavior, environment (OS, Node version, Docker version), and relevant logs (`docker compose logs memory-server`, hook output).
- **Feature requests** describe the use case before the implementation. The implementation shape often changes once the use case is concrete.
- For larger architectural proposals, open an issue with rationale rather than a speculative PR. Architecture decisions are tracked in maintainer-internal ADRs (see [Architecture decisions](#architecture-decisions) below).

## Pull request flow

1. **Branch naming:** `<type>/<short-description>` — for example `fix/recall-empty-snippet`, `feat/openai-stream-cancellation`, `docs/quickstart-clarity`.
2. **Conventional commits** in commit messages: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`. Optional scope: `feat(cli):`, `fix(installer):`, `docs(roadmap):`.
3. **Test plan** in the PR body — see [Test plan format](#test-plan-format) below.
4. **CI must be green** before review. The smoke + installer-test workflows run on every PR.
5. **One concept per PR** — easier to review, easier to revert. Roll mechanical cleanups into the PR that motivated them; otherwise open a separate PR.
6. **Squash-merge with `--delete-branch`** is the merge convention. The squash commit subject becomes the canonical commit message on `main`.

```bash
gh pr merge <N> --squash --delete-branch
```

## Test plan format

A bulleted checklist in the PR body covering:

- **What was tested** (unit / integration / smoke / manual)
- **How** (commands run, manual reproduction steps)
- **Platforms** if relevant (Linux / macOS / Windows git-bash)
- **What was NOT tested** and why (deferred to follow-up, requires live env, etc.)

Example:

```markdown
## Test plan
- [x] `npm test` (server) — 273 pass
- [x] `bash installer/install-cli.test.sh` — T1-T18 pass on ubuntu-latest
- [x] Manual smoke: fresh `docker compose up -d` + curl `/api/recall` — works
- [ ] Live-stack with bearer auth — not retested (no contract change here)
```

## Code review

- **Standard PRs (≤200 LOC, ≤2 files, no API changes):** one round of Sonnet-level code review. Targeted feedback; the reviewer is not expected to surface architectural concerns from a single round.
- **Plans, specs, architectural changes, multi-week refactors:** paired Opus review per [docs/process/review-playbook.md](docs/process/review-playbook.md) — multi-round, lens-diverse, with a documented convergence signal (two consecutive rounds returning zero material findings).

The four high-yield specialized lenses always run for design-depth reviews:

1. Cross-system / cross-section consistency
2. Adversarial / threat-model
3. UX / migration
4. Future-proofing / maintainability

The playbook documents past examples, the rename-sweep protocol, and the fictional-reference check. Read it before opening a major PR.

## Development principles

### Test integrity

When CI fails, **fix the underlying issue — do not weaken the test** to make it pass. If the underlying fix is out of scope for the PR, flag it to the maintainer rather than relax the assertion. Tests that no longer exercise real behavior are worse than failing tests.

### Scalable + extensible by default

Code defaults to scalable, generic-enough-for-future-extensibility designs:

- Data-driven over hardcoded
- Dependency injection at module boundaries
- Versioned contracts at public surfaces

This is an in-scope quality bar, not a license for scope expansion.

### Scope discipline

When aggregating findings across a review or a refactor:

- **Mechanical findings** (typos, missing imports, formatting, simple sign errors): resolve inline.
- **Design-heavy findings** (changing a public contract, picking between two architectures, dropping a feature): surface to the maintainer first. Limit unauthorized directional calls to ≤2 per PR.
- **Report progress in scope** (files touched, lines changed, tests added/changed) — not in estimated wall-clock time. Time estimates from inside an in-progress task are unreliable.

## Architecture decisions

ADRs are tracked locally under `docs/decisions/` (gitignored — maintainer-internal working records). For external contributors:

- For major architectural proposals, open a GitHub Issue with rationale.
- If accepted, the maintainer may capture the decision as an ADR.
- Cite an ADR by number in PR descriptions when relevant ("per ADR-0001's source/synthesis/index frame").

## Phase-boundary discipline (sustained contributors)

For multi-week feature branches (`v0.X` work-branches), install the pre-push hook to enforce the smoke + unit + shellcheck gate at phase boundaries:

```bash
git config --local core.hooksPath scripts/githooks
```

The hook detects phase-boundary commits via either:

- An explicit `Phase-boundary: <X>.<N>` git trailer (canonical), or
- A `(<X>.<N>)` token in the commit subject (fallback)

See [docs/process/review-playbook.md § Recurring lessons](docs/process/review-playbook.md) for the full rationale and the v0.6 case study that produced this rule.

`git push --no-verify` is reserved for hot-fix paths where the contributor takes explicit responsibility for the gate skip. The next non-hot-fix push will catch any drift.

## Style

- **Bash:** existing patterns. `shellcheck --severity=warning` must pass; installer code holds to `--severity=style`. Use `set -euo pipefail` and the `_tx_capture` / `_dump_on_fail` helpers from `installer/lib/` for command capture in tests.
- **Node:** existing patterns. `node:test` for unit tests; mocked SDKs (no live API calls in unit suites). ESM modules (`type: "module"` in `package.json`).
- **Markdown:** ATX-style headings (`#`, not underlines). 80-col soft wrap preferred but not enforced. Reference-style links acceptable.

## What lands fastest

- Small, focused PRs with clear test plans
- A linked issue describing the motivating use case
- CI green from first push
- Discussion in the PR thread for design questions, not in the diff

## What slows things down

- Multi-purpose PRs ("while I'm here, also…")
- Test plans of `[x] tested it`
- Force-pushes during review (use new commits; squash at merge)
- Disabled tests as a fix
- Personal paths or environment fingerprints in code (use `git rev-parse --show-toplevel` or relative resolution)

---

For anything not covered here, open an issue or ask in the PR thread. The maintainer prefers questions early to corrections late.
