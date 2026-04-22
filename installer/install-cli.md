# `install-cli.sh` — standalone UM CLI installer

Installs the `um` CLI tool without requiring the UM server Docker image. Use this if you want the CLI to interact with a remote UM server (e.g., a shared Pi/VPS instance) or to script UM interactions from your shell.

> **Note:** For full local-server installation (server + CLI), use `server/install.sh` instead. `install-cli.sh` is CLI-only — it does not install the server.

## Install

### Primary method (git clone)

```bash
git clone https://github.com/goldenwo/universal-memory.git
cd universal-memory
bash installer/install-cli.sh
```

Pass `--yes` (or `-y`) to skip confirmation prompts.

### Why git clone (not curl|bash)

`install-cli.sh` needs the full repo layout — it copies library files from
`plugins/claude-code/universal-memory/hooks/lib/` and subcommand scripts from
`plugins/claude-code/universal-memory/bin/`.  A single-file
`curl ... | bash` install would have no source files to copy, and
`${BASH_SOURCE[0]}` is empty when bash reads from stdin, breaking the
`SCRIPT_DIR` / `REPO_ROOT` derivation.

A future release may ship a self-bootstrapping bundle (clone-to-tempdir
pattern); for v0.4-alpha, clone the repo first.

## Prerequisites

The installer itself only checks for `python3` and `PyYAML` at install time; other tools are required at runtime by specific subcommands.

- **bash 4+** — the installer and dispatcher use associative arrays and modern bash features.
- **python3** — checked by the installer at preflight; required by write subcommands (`um-capture`, `um-forget`, `um-supersede`) for YAML frontmatter manipulation.
- **python3-yaml** (PyYAML) — checked by the installer at preflight. Install via:
  - Ubuntu/Debian: `apt install python3-yaml`
  - macOS: `pip3 install pyyaml`
  - Cross-platform: `pip3 install pyyaml`
- **jq** — required at runtime by server-backed subcommands (`um search`, `um state`, `um recent`, `um list`) for JSON parsing. Install via `apt install jq`, `brew install jq`, or your distro's package manager. Not checked by the installer — missing `jq` surfaces as a runtime error.
- **curl** — used by server-wrapping subcommands.
- **git** — optional; used by project-resolution fallback to derive `UM_PROJECT` from `git rev-parse --show-toplevel`.

## Supported platforms

| Platform | Status | CI coverage |
|---|---|---|
| Ubuntu 22.04 / 24.04 | Supported | `.github/workflows/smoke.yml` installer-test matrix |
| macOS 13+ (Ventura and later) | Supported | `.github/workflows/smoke.yml` installer-test matrix |
| Git Bash / MSYS2 (Windows) | Best-effort | Not in CI; tested on authoring machine |
| Native Windows (PowerShell / cmd) | Not supported | — |

The installer and CLI avoid GNU-only extensions (no `sed -i` without backup arg, no `date -d`, no `readlink -f` without fallback). Subcommand scripts that need `python3` document it explicitly.

## Install layout

After a successful install:

```
$HOME/.local/bin/
  um                      # dispatcher (copy, not symlink)
$HOME/.local/.claude-plugin/
  plugin.json             # version metadata (used by `um --version`)
$HOME/.local/share/um/
  cli/
    um                    # dispatcher (canonical source copy)
    um-capture            # write tool (binary)
    um-capture.sh         # write wrapper (delegates to um-capture binary)
    um-search.sh          # search subcommand
    um-state.sh           # state.md reader
    um-recent.sh          # recent memories
    um-list.sh            # list all memories
    um-tail.sh            # batch tail of raw captures
    um-forget             # forget subcommand (delegates to binary)
    um-supersede          # supersede subcommand (delegates to binary)
    um-preview            # preview subcommand (delegates to binary)
  lib/
    vault.sh              # vault path helpers
    frontmatter.sh        # YAML frontmatter parsing
    resolve-project.sh    # project name resolution
    config.sh             # KEY=value config loader
    summarize.sh          # summarizer invocation
    update-state.sh       # state.md regeneration
```

The dispatcher at `$HOME/.local/bin/um` is a direct copy (not a symlink). This is intentional: when invoked through a symlink, `BASH_SOURCE[0]` resolves to the symlink path, causing `PLUGIN_DIR` to be computed incorrectly. Copying `um` directly into `$HOME/.local/bin` keeps `PLUGIN_DIR = $HOME/.local`, which is where `plugin.json` is installed.

## Expected output after install

```
$ which um
/home/<user>/.local/bin/um

$ um --version
0.4.0-alpha
```

Note: `um --version` outputs the bare version string from `plugin.json` (no `um ` prefix).

```
$ um --help
Usage: um <subcommand> [args]

Subcommands:
  search, state, recent, list, capture, tail, forget, supersede

See docs/um-cli.md for full contract.
```

`um --help` exits 0. Running `um` without arguments prints a more detailed subcommand list to stderr and exits 2.

## Environment variables

The installer writes a canonical managed-block to `~/.bashrc` and/or `~/.zshrc`. The block uses single-quoted values reflecting the calling environment at install time:

```bash
# --- universal-memory (auto-added by install.sh) ---
export UM_OPENAI_API_KEY=''
export UM_SUMMARIZER='openai'
export UM_SERVER_URL='http://localhost:6335'
export UM_LIB_DIR='/home/<user>/.local/share/um/lib'
export UM_CLI_DIR='/home/<user>/.local/share/um/cli'
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
# --- end universal-memory ---
```

The installer writes to whichever rc files already exist, or match the current default shell (`$SHELL`). If neither `~/.bashrc` nor `~/.zshrc` exists and neither matches the default shell, the installer prints a warning and shows the block to add manually.

### Env-sourced contract

The managed-block is env-sourced, not persisted. Running either installer (`install.sh` or `install-cli.sh`) overwrites the block with the caller's current environment values. To keep a value across re-runs, export it before invoking:

```bash
source ~/.bashrc         # load existing env
bash installer/install-cli.sh  # preserves current UM_OPENAI_API_KEY etc.
```

Alternatively, set values in your shell before running the installer and they will be written into the block on this invocation.

### Key variables

- **`UM_SERVER_URL`** — URL of the UM server (local Docker or remote). CLI subcommands consume this. Default: `http://localhost:6335`.
- **`UM_OPENAI_API_KEY`** — OpenAI API key used by the summarizer and mem0 embeddings. Empty by default for CLI-only installs. Not required if your server is remote and already has its own key.
- **`UM_SUMMARIZER`** — `openai` (default) or `claude-agent-sdk`. Controls which provider the session-end hook uses to generate summaries.
- **`UM_LIB_DIR`** — library path. Default: `$HOME/.local/share/um/lib`. Override to load libraries from a custom location (advanced; used by developers).
- **`UM_CLI_DIR`** — CLI subcommand script path. Default: `$HOME/.local/share/um/cli`.

## Troubleshooting

### "command not found: um" after install

Open a new shell or run `source ~/.bashrc` / `source ~/.zshrc` to pick up the managed-block. If still failing:

```bash
ls -l ~/.local/bin/um              # should exist
echo $PATH | tr ':' '\n' | grep .local/bin   # should include .local/bin
```

If `.local/bin` is not on `PATH`, the managed-block did not run. Check that the block exists in your rc file:

```bash
grep -c 'universal-memory' ~/.bashrc ~/.zshrc
```

### "um: UM_LIB_DIR health check FAILED"

The dispatcher (`bin/um`) verifies at startup that `vault.sh`, `resolve-project.sh`, and `config.sh` are readable under `$UM_LIB_DIR`. If any are missing:

```bash
echo $UM_LIB_DIR
ls -la "$UM_LIB_DIR"
```

Fix by re-running the installer:

```bash
bash installer/install-cli.sh --yes
```

### "um search" / "um state" / "um recent" / "um list" fail with `jq: command not found`

Install jq for your platform (`apt install jq` / `brew install jq`). These server-backed subcommands require `jq` at runtime to parse JSON responses.

### "um forget" / "um supersede" fail with `ModuleNotFoundError: No module named 'yaml'`

Install PyYAML: `apt install python3-yaml` (Ubuntu/Debian) or `pip3 install pyyaml` (cross-platform).

### "python3 yaml module is required" during install

The installer runs a preflight check (`python3 -c 'import yaml'`). Install PyYAML before running the installer:

```bash
pip3 install pyyaml
bash installer/install-cli.sh
```

### Coexistence with `server/install.sh`

If you have already run `server/install.sh` (which installs the full server + CLI) and then run `install-cli.sh`, the managed-block is overwritten with the CLI installer's env values (env-sourced contract). To preserve server-specific env values, `source ~/.bashrc` first:

```bash
source ~/.bashrc
bash installer/install-cli.sh
```

## Uninstall

Remove the managed-block from your rc files and delete the installed files:

```bash
# Edit ~/.bashrc and ~/.zshrc to remove the lines between
# '# --- universal-memory' and '# --- end universal-memory' (inclusive).

rm -rf ~/.local/share/um
rm -f ~/.local/bin/um
rm -rf ~/.local/.claude-plugin   # only if no other tools use this directory
```

Open a new shell to pick up the PATH change.

## See also

- `docs/um-cli.md` — CLI subcommand reference, config format, JSON output contracts
- `server/install.sh` — full server + CLI installer
- `ROADMAP.md` — release history
