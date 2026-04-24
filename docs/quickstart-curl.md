# Quickstart — one-line install

Install universal-memory in one command:

```bash
curl -fsSL https://raw.githubusercontent.com/goldenwo/universal-memory/main/installer/install.sh | bash -s -- --yes
```

This is equivalent to:

```bash
git clone https://github.com/goldenwo/universal-memory.git ~/universal-memory
cd ~/universal-memory
bash installer/install.sh --yes
```

## What it does

1. Checks prereqs (`git`, `docker`, `python3`, `bash`)
2. Clones the repo to `$HOME/universal-memory` (or `$UM_INSTALL_DIR` if set)
3. If already cloned, pulls latest
4. Delegates to `installer/install.sh` with any flags you passed

Takes ~3 minutes (mostly the first Docker image pull).

## Flags

Any flag after `--` passes through to `installer/install.sh`:

- `--yes` — non-interactive, accept defaults (see `installer/install.sh --help`)
- `--verify` — run diagnostic checks on an existing install

## Custom install directory

```bash
curl -fsSL https://raw.githubusercontent.com/goldenwo/universal-memory/main/installer/install.sh | UM_INSTALL_DIR=/opt/um bash -s -- --yes
```

## After install

- Restart Claude Code to load the plugin
- Run `install.sh --verify` later to confirm everything is green (9 checks)
- See [docs/quickstart.md](quickstart.md) for the full guided walkthrough
