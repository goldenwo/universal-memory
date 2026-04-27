# Bridges registry

Every bridge CLI shipped in or after v0.6 MUST be registered here per spec §4.3.0.
A `source:` frontmatter value not listed here fails the drift-gate (schema-hygiene test).

| source    | direction  | status | since |
|-----------|------------|--------|-------|
| `native`  | self-write | active | v0.5  |
| `claude-mem` | upstream-only | active | v0.6  |

## Contributor notes

- Source names must match `[a-z0-9-]` (lowercase letters, digits, hyphens). Other forms are silently dropped by the registry parser; if you add a row that doesn't follow the convention, callers will see misleading "unknown source" errors at runtime. (I1)
- HTML comment blocks (`<!-- … -->`) do NOT suppress row parsing — the parser scans line-by-line. Delete or move rows you want to disable rather than commenting them out. (I2)
- Column padding is cosmetic; the parser only anchors on the leading `` |\s*` `` pattern. Don't cargo-cult exact spacing when adding rows. (M4)

## Contract references

See `docs/plans/2026-04-24-v0.6-design.md` §4.3.0 for the full 12-point
contract every bridge must implement.
