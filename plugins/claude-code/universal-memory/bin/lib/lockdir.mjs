// Dev-tree shim — see bridge-contract.mjs sibling for rationale.
// Required because the vendored bridge-contract.mjs imports './lockdir.mjs'.
export * from '../../../../../server/lib/lockdir.mjs';
