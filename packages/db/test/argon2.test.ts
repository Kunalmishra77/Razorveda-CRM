import { describe, it, expect } from 'vitest';
import { hash, verify } from '@node-rs/argon2';
import { ARGON2ID_PARAMS, ARGON2ID_PARAM_STRING, ARGON2ID_PREFIX } from '@razorveda/shared';

/**
 * The point of this file is NOT to test argon2. It is to make a library swap that
 * quietly weakens the cost factor into a failing build.
 *
 * @node-rs/argon2 ships a prebuilt binary; if it ever fails to load on a target
 * machine the replacement is node-argon2 or @noble/hashes with THESE parameters.
 * Whatever the implementation, the encoded hash must still say m=19456,t=2,p=1.
 */
describe('password hashing parameters are pinned', () => {
  it('produces an argon2id hash carrying the pinned cost factors', async () => {
    const h = await hash('correct horse battery staple', ARGON2ID_PARAMS);
    expect(h.startsWith(ARGON2ID_PREFIX), `not argon2id: ${h.slice(0, 20)}`).toBe(true);
    expect(h, `cost factors drifted from ${ARGON2ID_PARAM_STRING}`).toContain(ARGON2ID_PARAM_STRING);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const h = await hash('correct horse battery staple', ARGON2ID_PARAMS);
    expect(await verify(h, 'correct horse battery staple')).toBe(true);
    expect(await verify(h, 'Correct horse battery staple')).toBe(false);
  });

  it('salts — the same password never produces the same hash twice', async () => {
    const [a, b] = await Promise.all([
      hash('same', ARGON2ID_PARAMS),
      hash('same', ARGON2ID_PARAMS),
    ]);
    expect(a).not.toBe(b);
  });

  it('holds the OWASP Argon2id minimums', () => {
    expect(ARGON2ID_PARAMS.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(ARGON2ID_PARAMS.timeCost).toBeGreaterThanOrEqual(2);
    expect(ARGON2ID_PARAMS.algorithm).toBe(2); // Argon2id, not 2d or 2i
  });
});
