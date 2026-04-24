# `install.sh` — universal-memory bootstrap installer

Clones or updates the repo and delegates to per-component installers based on flags.

## Usage

```bash
# Install everything detected on this machine
bash installer/install.sh --all

# Install only the server
bash installer/install.sh --server

# Install only the CLI
bash installer/install.sh --cli

# Install Claude Code plugin only
bash installer/install.sh --plugin-cc

# Install multiple components
bash installer/install.sh --server --plugin-cc --cli

# Non-interactive (CI/scripts)
bash installer/install.sh --all --yes

# Preview what would happen
bash installer/install.sh --all --dry-run
```

No flags + non-TTY stdin = `--all` (v0.4 back-compat).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `UM_INSTALL_DIR` | `~/universal-memory` | Where to clone/update the repo |
| `UM_REPO_URL` | GitHub main | Repo URL to clone from |
| `UM_DRY_RUN` | `0` | Set to `1` to print-only mode |

---

## Extending: Adding a new component flag

`install.sh` is a thin dispatcher. Adding a new component (e.g. `--plugin-foo`) takes 7 steps, using `--plugin-cc` as the reference example.

1. **Create a standalone installer script** at `installer/install-plugin-foo.sh`. Copy the structure of `installer/install-plugin-cc.sh`: shebang, `set -euo pipefail`, `REPO_ROOT` derivation, `info/ok/warn/fail` helpers, preflight check, install logic, exit 0 on success.

2. **Register the flag** in `install.sh`'s flag parser block (look for `# ---- v0.5 flag parser`). Add:
   ```bash
   --plugin-foo)    INSTALL_PLUGIN_FOO=1 ;;
   ```
   And declare the variable at the top of the parser block:
   ```bash
   INSTALL_PLUGIN_FOO=0
   ```

3. **Wire it into `--all`** if appropriate. Inside the `if [[ $INSTALL_ALL -eq 1 ]]; then` block, add a detection condition:
   ```bash
   [[ -d "$HOME/.foo" ]] && INSTALL_PLUGIN_FOO=1
   ```
   Omit if the component should not auto-enable — require the user to pass `--plugin-foo` explicitly.

4. **Add the dispatcher case** after the existing `if [[ $INSTALL_PLUGIN_CODEX -eq 1 ]]; then` block:
   ```bash
   if [[ $INSTALL_PLUGIN_FOO -eq 1 ]]; then
     _delegate "installer/install-plugin-foo.sh" "${PASSTHROUGH_ARGS[@]}"
   fi
   ```

5. **Write tests** in `installer/install.test.sh`. Add at minimum:
   - `--plugin-foo` alone → `delegate: installer/install-plugin-foo.sh` in dry-run output.
   - `--all` with the detection dir present → `install-plugin-foo.sh` also delegated.
   - Any soft-skip condition (missing dir, etc.) → exits 0 with a descriptive message.

6. **Run the test suite** and confirm new assertions pass:
   ```bash
   bash installer/install.test.sh 2>&1 | tail -5
   ```

7. **Document it** — add a row to the Usage table above and update the flag list in the Usage block.
