// Dev-tree shim — re-exports from server/lib/. install-plugin-cc.sh replaces
// this file with a vendor copy in copy-mode plugin installs. The stable path
// './lib/bridge-contract.mjs' lets translate.mjs import the same module spec
// in dev and prod.
export * from '../../../../../server/lib/bridge-contract.mjs';
