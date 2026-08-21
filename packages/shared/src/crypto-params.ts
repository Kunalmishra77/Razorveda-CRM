/**
 * Password hashing parameters. Pinned here, in a package with no crypto
 * dependency of its own, so that swapping the implementation library cannot
 * quietly change the cost factor.
 *
 * @node-rs/argon2 loads a prebuilt binary and works on this machine. If it ever
 * fails to load, the replacement is `node-argon2` or the pure-JS argon2id in
 * `@noble/hashes`, using THESE parameters. Never bcrypt, and never a silent
 * fallback — a hash algorithm that changes without anyone noticing is how a
 * password database quietly becomes weaker than the day it was created.
 */

/** Argon2 variant. 0 = Argon2d, 1 = Argon2i, 2 = Argon2id. */
export const ARGON2_VARIANT_ID = 2;

/**
 * OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19456 KiB (19 MiB),
 * t=2, p=1. Measured at ~43 ms per hash on the dev machine.
 *
 * Raising these is a deliberate decision with a migration plan for existing
 * hashes, not a tuning tweak.
 */
export const ARGON2ID_PARAMS = {
  algorithm: ARGON2_VARIANT_ID,
  /** KiB of memory. */
  memoryCost: 19_456,
  /** Iterations. */
  timeCost: 2,
  /** Lanes. */
  parallelism: 1,
} as const;

/**
 * The prefix every stored hash must start with, and the encoded parameter string
 * it must contain. Asserted against a real hash in packages/db so a library swap
 * that silently downgrades the cost is a failing test, not a quiet regression.
 */
export const ARGON2ID_PREFIX = '$argon2id$';
export const ARGON2ID_PARAM_STRING = `m=${ARGON2ID_PARAMS.memoryCost},t=${ARGON2ID_PARAMS.timeCost},p=${ARGON2ID_PARAMS.parallelism}`;
