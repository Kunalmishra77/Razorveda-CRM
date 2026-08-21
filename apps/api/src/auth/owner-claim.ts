import { timingSafeEqual } from 'node:crypto';

/**
 * Claiming the OWNER account (O-07, resolved as a mechanism — D-88).
 *
 * The account is seeded LOCKED with `locked_reason` naming O-07, because nobody
 * had nominated a person (D-41). This is how it gets claimed.
 *
 * THE SECURITY PROBLEM, stated plainly. The obvious implementation — let an admin
 * unlock it in the panel — destroys the thing OWNER exists for. docs/05:
 *
 *   "Three admins with identical, mutually unrevocable access and nobody above
 *    them is a gap."
 *
 * OWNER is the answer to that gap. If any admin can promote themselves to OWNER,
 * there is no one above the admins again, and the gap is back — except now it
 * looks closed. That is worse than leaving it open honestly.
 *
 * So claiming requires a secret the application never issues: `OWNER_CLAIM_TOKEN`,
 * provisioned out of band by whoever deploys, handed to the business owner
 * directly. An admin with full database access could of course do anything — but
 * an admin with only the admin panel cannot make themselves owner, which is the
 * boundary that matters day to day.
 *
 * It is ONE TIME. Once claimed, the token stops working forever.
 */

export interface OwnerAccountState {
  readonly userId: string;
  readonly email: string;
  readonly isLocked: boolean;
  readonly lockedReason: string | null;
  /** Set the moment the account is claimed. Presence means "already claimed". */
  readonly claimedAt: string | null;
}

export interface ClaimAttempt {
  readonly email: string;
  readonly password: string;
  readonly token: string;
}

export type ClaimOutcome =
  | { readonly ok: true; readonly userId: string; readonly email: string }
  | { readonly ok: false; readonly reason: ClaimFailure; readonly message: string };

export type ClaimFailure =
  | 'ALREADY_CLAIMED'
  | 'NO_TOKEN_CONFIGURED'
  | 'BAD_TOKEN'
  | 'WEAK_PASSWORD'
  | 'INVALID_EMAIL';

/** Minimum for an account that can change targets and incentive rules. */
export const MIN_OWNER_PASSWORD_LENGTH = 12;

function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // Length differs, so timingSafeEqual would throw — but returning early on
  // length still leaks length. Compare against a padded buffer instead.
  if (a.length !== b.length) {
    const pad = Buffer.alloc(b.length);
    timingSafeEqual(pad, b.length === 0 ? pad : Buffer.alloc(b.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Decide whether a claim succeeds. Pure — the caller performs the writes.
 *
 * Check order matters, as it does on login: "already claimed" is reported before
 * the token is examined, so a wrong token cannot be used to probe whether the
 * account is still available.
 */
export function evaluateOwnerClaim(
  account: OwnerAccountState,
  attempt: ClaimAttempt,
  configuredToken: string | undefined,
): ClaimOutcome {
  if (account.claimedAt !== null) {
    return {
      ok: false,
      reason: 'ALREADY_CLAIMED',
      message:
        'The owner account has already been claimed. If you need to change who holds it, ' +
        'that is a deliberate handover, not a self-service action — see docs/05.',
    };
  }

  if (!configuredToken || configuredToken.trim() === '') {
    // Refusing here is the point. An unset token must not mean "no check".
    return {
      ok: false,
      reason: 'NO_TOKEN_CONFIGURED',
      message:
        'No OWNER_CLAIM_TOKEN is configured on this deployment, so the owner account cannot ' +
        'be claimed. Whoever deployed the system must set it and hand it over directly.',
    };
  }

  if (!tokensMatch(attempt.token, configuredToken)) {
    return {
      ok: false,
      reason: 'BAD_TOKEN',
      message: 'That claim token is not correct. Ask whoever deployed the system for it.',
    };
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(attempt.email)) {
    return { ok: false, reason: 'INVALID_EMAIL', message: 'Enter a valid email address.' };
  }

  if (attempt.password.length < MIN_OWNER_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'WEAK_PASSWORD',
      message:
        `Use at least ${MIN_OWNER_PASSWORD_LENGTH} characters. This account can change targets ` +
        `and incentive rules for everyone.`,
    };
  }

  return { ok: true, userId: account.userId, email: attempt.email };
}

/**
 * What claiming writes. TOTP is NOT enrolled here.
 *
 * OWNER requires 2FA (docs/05), and `evaluateLogin` refuses an OWNER with no
 * enrolled secret rather than waving them through (D-52). So the claim sets the
 * credentials and unlocks the account, and the very next thing the new owner must
 * do is enrol an authenticator — enforced by the login path, not by a reminder.
 */
export interface OwnerClaimWrite {
  readonly email: string;
  readonly passwordHash: string;
  readonly isLocked: false;
  readonly lockedReason: null;
  readonly claimedAt: string;
  readonly auditAction: 'OWNER_ACCOUNT_CLAIMED';
}

export function ownerClaimWrite(
  email: string,
  passwordHash: string,
  nowIso: string,
): OwnerClaimWrite {
  return {
    email,
    passwordHash,
    isLocked: false,
    lockedReason: null,
    claimedAt: nowIso,
    auditAction: 'OWNER_ACCOUNT_CLAIMED',
  };
}
