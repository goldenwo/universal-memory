#!/usr/bin/env python3
"""codex_hook_approval.py - does Codex still have universal-memory's hooks approved?

Codex runs a plugin's hooks only while the user's approval matches. From Codex
0.164.0 the approval covers every file in the installed plugin, so each
universal-memory update un-approves all four hooks, and `codex exec` then
captures nothing without saying so. Codex keeps the state on disk; this reads
it and says which case applies.

Usage:
    python codex_hook_approval.py --codex-home <dir>

Output: exactly one line, "<state><TAB><message>", and exit 0. The states:
    approved        every hook will run
    needs-approval  the plugin changed since the approval; Codex 0.164+ runs none
    never-approved  at least one hook has no approval; no Codex version runs it
    disabled        the user switched a hook off in Codex (their choice)
    unknown         could not tell; the message says why
    not-installed   the plugin is not in this Codex home

Rules this file must keep:
  * Read-only. It opens files for reading and nothing else, runs no command,
    and never writes an approval: approving the hooks is the user's act.
  * Any doubt is "unknown", never "not approved".
  * Callers must not trust the exit code or the shape of the output: they treat
    anything but one well-formed line as "unknown"
    (installer/lib/codex-hook-approval.sh).

What is copied from Codex, read at rust-v0.167.0 (identical at rust-v0.164.0):
  codex-rs/hooks/src/engine/plugin_fingerprint.rs  the hash of the plugin's files
  codex-rs/hooks/src/engine/plugin_trust.rs        matches_hash, legacy_trust_path
  codex-rs/hooks/src/engine/discovery.rs           the per-hook order of checks
  codex-rs/config/src/hook_config.rs               the fields in config.toml
If Codex changes any of these, a warning here can outlive a fresh approval.

Not checked: whether `trusted_hash` still equals the hook's declaration hash.
hooks.json is pinned by hooks/hooks-json.test.sh (J1-J3); a release that changes
it, or a Codex release that changes how a declaration is hashed, can make Codex
ask again while this still says "approved".
"""

import hashlib
import os
import re
import stat
import struct
import sys
from typing import Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    # LF as well as UTF-8: the callers split this line in bash, where a carriage
    # return from a Windows Python would become part of the message.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", newline="\n")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PLUGIN_NAME = "universal-memory"
MARKETPLACE_NAME = "universal-memory"
PLUGIN_ID = f"{PLUGIN_NAME}@{MARKETPLACE_NAME}"
HOOKS_FILE = "hooks/hooks.json"
# One group with one handler per event (pinned by J1), hence the ":0:0".
HOOK_EVENTS = ("session_start", "user_prompt_submit", "stop", "session_end")

BUNDLE_LABEL = b"codex-plugin-bundle-v1"
SKIPPED_NAMES = ("__pycache__", ".venv")
SKIPPED_SUFFIXES = (".pyc", ".egg-info")
READ_CHUNK_BYTES = 64 * 1024

APPROVED = "approved"
NEEDS_APPROVAL = "needs-approval"
NEVER_APPROVED = "never-approved"
DISABLED = "disabled"
UNKNOWN = "unknown"
NOT_INSTALLED = "not-installed"

HookState = Dict[str, object]


class CannotTell(Exception):
    """The state cannot be read with certainty; the text is the reason shown."""


def length_prefixed(data: bytes) -> bytes:
    """`data` behind its length as eight little-endian bytes, as Codex hashes it."""
    return struct.pack("<Q", len(data)) + data


def is_left_out_of_hash(entry_name: str) -> bool:
    return entry_name in SKIPPED_NAMES or entry_name.endswith(SKIPPED_SUFFIXES)


# Windows reparse tags for a symbolic link and for a junction. Codex (Rust)
# treats both as links; Python before 3.12 reports a junction as a directory.
WINDOWS_LINK_REPARSE_TAGS = (0xA000000C, 0xA0000003)


def is_link_or_special(entry: os.stat_result) -> bool:
    """True for anything Codex refuses to hash: not a plain file or directory."""
    if not (stat.S_ISDIR(entry.st_mode) or stat.S_ISREG(entry.st_mode)):
        return True
    return getattr(entry, "st_reparse_tag", 0) in WINDOWS_LINK_REPARSE_TAGS


def plugin_content_hash(plugin_root: str) -> str:
    """The hash Codex stores as `trusted_content_hash` for this plugin folder.

    Entries are visited from the root down. A directory's entries are sorted by
    their own name, as bytes, and a directory's contents come straight after
    it, before its next sibling. That is not a sort of whole paths: `a`, `a/b`,
    `a-b` is Codex's order.
    """
    digest = hashlib.sha256(BUNDLE_LABEL)
    # (path on disk, path relative to the root); popped from the end.
    pending: List[Tuple[str, str]] = [(plugin_root, "")]
    while pending:
        path, relative_path = pending.pop()
        if is_left_out_of_hash(os.path.basename(relative_path)):
            continue
        digest.update(length_prefixed(os.fsencode(relative_path)))
        entry = os.lstat(path)
        if is_link_or_special(entry):
            raise CannotTell("the installed plugin holds a link or special file, which Codex refuses")
        if stat.S_ISDIR(entry.st_mode):
            digest.update(b"directory")
            entry_names = sorted(os.listdir(path), key=os.fsencode)
            for entry_name in reversed(entry_names):
                child_relative = os.path.join(relative_path, entry_name) if relative_path else entry_name
                pending.append((os.path.join(path, entry_name), child_relative))
        else:
            digest.update(b"file")
            expected_length = entry.st_size
            digest.update(struct.pack("<Q", expected_length))
            bytes_read = 0
            with open(path, "rb") as plugin_file:
                while True:
                    chunk = plugin_file.read(READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    bytes_read += len(chunk)
                    digest.update(chunk)
            if bytes_read != expected_length:
                raise CannotTell("a plugin file changed while it was being read")
    return "sha256:" + digest.hexdigest()


def baseline_file_name(config_path: str) -> str:
    """The file under .hook-trust/ that holds this plugin's pre-0.164 baseline."""
    digest = hashlib.sha256()
    for part in (os.fsencode(config_path), PLUGIN_ID.encode("utf-8")):
        digest.update(length_prefixed(part))
    return digest.hexdigest()


def read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8", newline="") as text_file:
        return text_file.read()


def find_baseline(codex_home: str, content_hash: str) -> Optional[str]:
    """The stored baseline hash, or None when Codex has not written one yet.

    The file's name is derived from the config file's path as Codex holds it:
    the real path (links and letter case resolved) when CODEX_HOME is set, the
    plain path otherwise. Both are tried. If neither name exists but other
    baselines do, a mismatch of the name cannot be ruled out, so only a file
    holding this very hash settles it.
    """
    trust_dir = os.path.join(codex_home, ".hook-trust")
    config_path_forms = (
        os.path.join(codex_home, "config.toml"),
        os.path.join(os.path.realpath(codex_home), "config.toml"),
    )
    for config_path in config_path_forms:
        baseline_path = os.path.join(trust_dir, baseline_file_name(config_path))
        if os.path.isfile(baseline_path):
            return read_text(baseline_path)
    if not os.path.isdir(trust_dir):
        return None
    other_baselines = [
        os.path.join(trust_dir, name)
        for name in os.listdir(trust_dir)
        if os.path.isfile(os.path.join(trust_dir, name))
    ]
    if not other_baselines:
        return None
    if any(read_text(path) == content_hash for path in other_baselines):
        return content_hash
    raise CannotTell("none of Codex's stored baselines can be matched to universal-memory")


def hook_key(event: str) -> str:
    return f"{PLUGIN_ID}:{HOOKS_FILE}:{event}:0:0"


TABLE_LINE = re.compile(r"""^\[hooks\.state\.(?P<quote>["'])(?P<key>.*)(?P=quote)\]$""")
FIELD_LINE = re.compile(r"^(?P<name>trusted_hash|trusted_content_hash|enabled)\s*=\s*(?P<value>.*)$")
FIELD_VALUE = re.compile(r"""^(?:"(?P<basic>[^"\\]*)"|'(?P<literal>[^']*)'|(?P<flag>true|false))\s*(?:#.*)?$""")


def read_hook_states(config_text: str) -> Dict[str, HookState]:
    """Each hook's `[hooks.state."<key>"]` table, keyed by event.

    A narrow reader, not a TOML parser (tomllib needs Python 3.11): it reads the
    one shape Codex writes. A hook whose key is in the file in any other shape
    is a reason to stop, not to guess.
    """
    event_by_key = {hook_key(event): event for event in HOOK_EVENTS}
    states: Dict[str, HookState] = {}
    current: Optional[HookState] = None
    for raw_line in config_text.splitlines():
        line = raw_line.strip()
        if line.startswith("["):
            current = None
            table = TABLE_LINE.match(line)
            event = event_by_key.get(table.group("key")) if table else None
            if event is not None:
                if event in states:
                    raise CannotTell("config.toml lists a hook twice")
                current = states[event] = {}
            continue
        if current is None:
            continue
        field = FIELD_LINE.match(line)
        if not field:
            continue
        value = FIELD_VALUE.match(field.group("value"))
        if not value:
            raise CannotTell("a hook's entry in config.toml has a value this check does not read")
        is_flag = value.group("flag") is not None
        if is_flag != (field.group("name") == "enabled"):
            raise CannotTell("a hook's entry in config.toml has a value of the wrong kind")
        if is_flag:
            current["enabled"] = value.group("flag") == "true"
        else:
            text = value.group("basic")
            current[field.group("name")] = text if text is not None else value.group("literal")
    for key, event in event_by_key.items():
        if event not in states and key in config_text:
            raise CannotTell("config.toml holds a hook's approval in a form this check does not read")
    return states


def find_plugin_root(codex_home: str) -> Optional[str]:
    """The installed plugin folder, or None when the plugin is not installed."""
    versions_dir = os.path.join(codex_home, "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME)
    if not os.path.isdir(versions_dir):
        return None
    version_dirs = [
        os.path.join(versions_dir, name)
        for name in os.listdir(versions_dir)
        if os.path.isdir(os.path.join(versions_dir, name))
    ]
    if not version_dirs:
        return None
    if len(version_dirs) > 1:
        # Codex picks one by its own version ordering; an update normally
        # deletes the others, so this is a leftover, not a state to model.
        raise CannotTell("more than one installed version of the plugin")
    return version_dirs[0]


class PluginFacts:
    """What the hooks are compared against; each part is read once, when first needed."""

    def __init__(self, codex_home: str, plugin_root: str) -> None:
        self._codex_home = codex_home
        self._plugin_root = plugin_root
        self._content_hash: Optional[str] = None
        self._baseline: Optional[str] = None
        self._is_baseline_read = False

    def content_hash(self) -> str:
        if self._content_hash is None:
            self._content_hash = plugin_content_hash(self._plugin_root)
        return self._content_hash

    def baseline(self) -> Optional[str]:
        if not self._is_baseline_read:
            self._baseline = find_baseline(self._codex_home, self.content_hash())
            self._is_baseline_read = True
        return self._baseline


def classify_hook(state: HookState, facts: PluginFacts) -> str:
    """One hook's state, in the order Codex itself checks (discovery.rs, matches_hash)."""
    if state.get("enabled") is False:
        return DISABLED
    if "trusted_hash" not in state:
        return NEVER_APPROVED
    stored_content_hash = state.get("trusted_content_hash")
    if stored_content_hash is not None:
        # With a content hash stored, Codex does not consult the baseline.
        return APPROVED if stored_content_hash == facts.content_hash() else NEEDS_APPROVAL
    baseline = facts.baseline()
    if baseline is None:
        # An approval from before 0.164 with no baseline yet: Codex adopts the
        # current files as the baseline the first time it looks.
        return APPROVED
    return APPROVED if baseline == facts.content_hash() else NEEDS_APPROVAL


def describe(codex_home: str) -> Tuple[str, str]:
    """(state, message) for the Codex home at `codex_home`."""
    plugin_root = find_plugin_root(codex_home)
    if plugin_root is None:
        return NOT_INSTALLED, "The universal-memory plugin is not installed in Codex."
    config_path = os.path.join(codex_home, "config.toml")
    if not os.path.isfile(config_path):
        raise CannotTell("Codex's config.toml is missing")
    hook_states = read_hook_states(read_text(config_path))
    facts = PluginFacts(codex_home, plugin_root)

    events_by_state: Dict[str, List[str]] = {}
    unknown_reason = ""
    for event in HOOK_EVENTS:
        try:
            hook_state = classify_hook(hook_states.get(event, {}), facts)
        except CannotTell as doubt:
            hook_state, unknown_reason = UNKNOWN, str(doubt)
        except Exception as error:  # noqa: BLE001 - one hook's doubt must not hide another's certainty
            hook_state, unknown_reason = UNKNOWN, f"{type(error).__name__} while reading Codex's files"
        events_by_state.setdefault(hook_state, []).append(event)

    total = len(HOOK_EVENTS)
    never_approved = events_by_state.get(NEVER_APPROVED, [])
    if never_approved:
        return NEVER_APPROVED, (
            f"Codex has not approved universal-memory's hooks ({len(never_approved)} of {total} not approved): "
            'start codex once and choose "Trust all and continue". '
            "Until then nothing is captured, codex exec runs included."
        )
    if NEEDS_APPROVAL in events_by_state:
        return NEEDS_APPROVAL, (
            "universal-memory changed since Codex approved its hooks: Codex 0.164 and later runs none of them "
            "until you start codex (or open the Codex app's hook review) and trust them again. "
            "Codex before 0.164 still runs them."
        )
    if UNKNOWN in events_by_state:
        raise CannotTell(unknown_reason)
    disabled = events_by_state.get(DISABLED, [])
    if disabled:
        return DISABLED, (
            f"{len(disabled)} of {total} universal-memory hooks are switched off in Codex's hook settings: "
            f"{', '.join(disabled)}."
        )
    return APPROVED, "Codex has universal-memory's hooks approved."


def unknown(reason: str) -> Tuple[str, str]:
    return UNKNOWN, f"Could not tell whether Codex has universal-memory's hooks approved ({reason})."


def codex_home_argument(arguments: List[str]) -> str:
    if len(arguments) != 2 or arguments[0] != "--codex-home" or not arguments[1]:
        raise CannotTell("the check was not given a Codex home")
    return os.path.normpath(os.path.abspath(arguments[1]))


def main(arguments: List[str]) -> int:
    try:
        state, message = describe(codex_home_argument(arguments))
    except CannotTell as doubt:
        state, message = unknown(str(doubt))
    except Exception as error:  # noqa: BLE001 - any failure is "unknown", by contract
        state, message = unknown(f"{type(error).__name__} while reading Codex's files")
    print(f"{state}\t{message}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
