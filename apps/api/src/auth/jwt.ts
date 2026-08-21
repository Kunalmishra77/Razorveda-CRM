import { SignJWT, jwtVerify } from 'jose';
import type { UserRole } from '@razorveda/shared';
import { ACCESS_TOKEN_TTL_MS } from './session-policy.js';

/**
 * Access tokens (docs/05: JWT 15 min + rotating refresh).
 *
 * Uses `jose` rather than a hand-rolled implementation. TOTP was worth building
 * from the RFC because it is HMAC plus a truncation rule with published test
 * vectors — JWT is not that. Its failure modes are alg-confusion, `alg: none`
 * acceptance and unverified `kid` handling, and none of those show up in a happy
 * path test. A library that has been attacked is worth more here than one I can
 * read in an afternoon. (Tier 2)
 */

const ALG = 'HS256';

export interface AccessTokenClaims {
  /** app_user.user_id. NOT employee_id — conflating them was defect N1. */
  readonly sub: string;
  readonly role: UserRole;
  /** Ties the token to a server-side session so it can be revoked (D-54, D-55). */
  readonly sid: string;
}

function secretKey(): Uint8Array {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret.length < 32) {
    // Refusing to boot is loud. A weak or missing secret that silently defaults
    // would make every token forgeable, and nothing would look wrong.
    throw new Error(
      'JWT_SECRET is missing or shorter than 32 characters. Generate a long random ' +
        'string — see .env.example. The API will not start without one.',
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  nowMs: number,
): Promise<string> {
  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor((nowMs + ACCESS_TOKEN_TTL_MS) / 1000))
    .setIssuer('razorveda-crm')
    .setAudience('razorveda-crm')
    .sign(secretKey());
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: AccessTokenClaims }
  | { readonly ok: false; readonly reason: string };

export async function verifyAccessToken(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      // Pinned explicitly. Without this a token could name its own algorithm,
      // which is the classic JWT break.
      algorithms: [ALG],
      issuer: 'razorveda-crm',
      audience: 'razorveda-crm',
    });

    const sub = payload.sub;
    const role = payload['role'];
    const sid = payload['sid'];

    if (typeof sub !== 'string' || typeof sid !== 'string') {
      return { ok: false, reason: 'token is missing sub or sid' };
    }
    if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'EMPLOYEE') {
      return { ok: false, reason: 'token carries an unknown role' };
    }
    return { ok: true, claims: { sub, role, sid } };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Refresh tokens are opaque random strings; only their hash is stored (D-54). */
export const REFRESH_TOKEN_BYTES = 32;
