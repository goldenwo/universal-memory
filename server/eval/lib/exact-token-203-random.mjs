// server/eval/lib/exact-token-203-random.mjs — #203: the seeded randomness the
// harness uses (candidate order, scramble, derangement, bootstrap). Every stream
// is derived from a seed or salt in the accept rule plus a fixed label, so one
// stream's draws never shift another's, and a re-run reproduces every draw.

import { createHash } from 'node:crypto';

/** mulberry32: a small, fast 32-bit PRNG with a uniform [0, 1) output. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG stream for (seed, label): the first 32 bits of sha256(`${seed}:${label}`). */
export function prng(seedHex, label) {
  return mulberry32(createHash('sha256').update(`${seedHex}:${label}`).digest().readUInt32BE(0));
}

/** Fisher–Yates over a copy, driven by prng(seedHex, label). */
export function seededShuffle(items, seedHex, label) {
  const a = [...items];
  const r = prng(seedHex, label);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
