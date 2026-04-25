# Bridges registry

Every bridge CLI shipped in or after v0.6 MUST be registered here per spec §4.3.0.
A `source:` frontmatter value not listed here fails the drift-gate (schema-hygiene test).

| source    | direction  | status | since |
|-----------|------------|--------|-------|
| `native`  | self-write | active | v0.5  |
| `claude-mem` | upstream-only | active | v0.6  |

## Contract references

See `docs/plans/2026-04-24-v0.6-design.md` §4.3.0 for the full 12-point
contract every bridge must implement.
