import { randomBytes } from 'node:crypto';

/**
 * Two-factor enrolment for ADMIN and OWNER (docs/05, Identity).
 *
 * `evaluateLogin` refuses an admin with no enrolled secret rather than waving
 * them through (D-52). That is right, and it means a fresh deployment has nobody
 * who can sign in — so this is the missing first-login path. Until now only
 * `seed:dev` planted a known secret, which is fine locally and useless in
 * production.
 *
 * THE SECURITY SHAPE, because it is the whole design:
 *
 *   1. Enrolment starts ONLY after a correct password. Without that, anyone who
 *      knew an admin's email could bind their own authenticator to the account.
 *   2. The proposed secret travels inside a SIGNED, short-lived token. It cannot
 *      be swapped for one the attacker controls between the two steps.
 *   3. Enrolment is refused if a secret already exists. Re-binding an
 *      authenticator is an admin-assisted reset, never self-service — otherwise
 *      a stolen password alone is enough to take over the account permanently.
 */

/** RFC 4648 base32, no padding — what every authenticator app expects. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 160 bits, the RFC 4226 recommendation. */
const SECRET_BYTES = 20;

/** Long enough to scan and type a code, short enough not to sit around. */
export const ENROLMENT_TOKEN_TTL_MS = 10 * 60 * 1000;

export function generateTotpSecret(): string {
  const bytes = randomBytes(SECRET_BYTES);
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The `otpauth://` URI an authenticator reads from a QR code.
 *
 * The label carries the account so a rep with several work accounts can tell
 * them apart in the app, and the issuer is what shows above the code.
 */
export function otpauthUri(email: string, secret: string, issuer = 'Razorveda CRM'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export type EnrolmentRefusal =
  | 'ALREADY_ENROLLED'
  | 'NOT_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED';

export interface EnrolmentCandidate {
  readonly userId: string;
  readonly email: string;
  readonly role: 'OWNER' | 'ADMIN' | 'EMPLOYEE';
  readonly isLocked: boolean;
  readonly hasSecret: boolean;
}

export type EnrolmentDecision =
  | { readonly ok: true; readonly userId: string; readonly email: string }
  | { readonly ok: false; readonly reason: EnrolmentRefusal; readonly message: string };

/**
 * May this account start enrolment?
 *
 * Same check order as login (D-51): credentials first, because every later reason
 * is more specific than "no" and would otherwise let someone probe which accounts
 * exist and which are already enrolled.
 */
export function evaluateEnrolment(
  candidate: EnrolmentCandidate | null,
  passwordValid: boolean,
): EnrolmentDecision {
  if (!candidate || !passwordValid) {
    return {
      ok: false,
      reason: 'INVALID_CREDENTIALS',
      message: 'That email and password do not match. Check both and try again.',
    };
  }
  if (candidate.isLocked) {
    return {
      ok: false,
      reason: 'ACCOUNT_LOCKED',
      message: 'This account is locked. Ask an admin to unlock it before setting up two-factor.',
    };
  }
  if (candidate.role === 'EMPLOYEE') {
    return {
      ok: false,
      reason: 'NOT_REQUIRED',
      message: 'Two-factor is only required for admins. Sign in with your password.',
    };
  }
  if (candidate.hasSecret) {
    // Self-service re-binding would mean a stolen password is enough to take the
    // account permanently. An admin reset clears the secret first.
    return {
      ok: false,
      reason: 'ALREADY_ENROLLED',
      message:
        'This account already has an authenticator. If you have lost it, an admin must reset ' +
        'two-factor for you — it cannot be re-linked from here.',
    };
  }
  return { ok: true, userId: candidate.userId, email: candidate.email };
}
