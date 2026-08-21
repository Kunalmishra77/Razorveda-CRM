/**
 * Session lifetime rules (docs/05, Identity), as pure functions.
 *
 *   JWT access token   15 minutes
 *   Refresh token      7 days, ROTATING — each use issues a new one and burns the old
 *   Idle logout        10 minutes without activity
 *   Single session     one active session per employee; a new login ends the old one
 *
 * Kept free of I/O so every branch is testable without a clock or a store. The
 * caller supplies `nowMs`; nothing in here reads the system time, which is also
 * what makes the expiry edges assertable rather than flaky.
 */

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface StoredSession {
  readonly sessionId: string;
  readonly userId: string;
  /** Hash of the refresh token. The raw token is never stored (see below). */
  readonly refreshTokenHash: string;
  readonly issuedAtMs: number;
  readonly lastSeenAtMs: number;
  /** Set when the session ended. Sessions are revoked, never deleted. */
  readonly revokedAtMs: number | null;
  readonly revokedReason: RevokeReason | null;
  readonly deviceFingerprint: string | null;
}

export type RevokeReason =
  | 'LOGOUT'
  | 'SUPERSEDED_BY_NEW_LOGIN'
  | 'IDLE_TIMEOUT'
  | 'REFRESH_EXPIRED'
  | 'REFRESH_REUSE_DETECTED'
  | 'ACCOUNT_LOCKED'
  | 'OFFBOARDED';

export type SessionVerdict =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: RevokeReason; readonly message: string };

const REVOKED_MESSAGE: Record<RevokeReason, string> = {
  LOGOUT: 'You signed out. Sign in again to continue.',
  SUPERSEDED_BY_NEW_LOGIN:
    'You signed in on another device. Only one session is allowed at a time — sign in again here to continue.',
  IDLE_TIMEOUT: 'You were signed out after 10 minutes of inactivity. Sign in again to continue.',
  REFRESH_EXPIRED: 'Your session expired. Sign in again to continue.',
  REFRESH_REUSE_DETECTED:
    'This session was ended for security reasons. Sign in again, and tell an admin if you did not expect this.',
  ACCOUNT_LOCKED: 'This account is locked. Ask an admin to unlock it.',
  OFFBOARDED: 'This account no longer has access.',
};

export const revokeMessage = (reason: RevokeReason): string => REVOKED_MESSAGE[reason];

/**
 * Is this session still usable?
 *
 * Order matters for the message the user sees, not for security — all four
 * branches deny. Explicit revocation is reported first because it is the most
 * specific and the most actionable ("you signed in elsewhere" beats "expired").
 */
export function evaluateSession(session: StoredSession, nowMs: number): SessionVerdict {
  if (session.revokedAtMs !== null) {
    const reason = session.revokedReason ?? 'LOGOUT';
    return { valid: false, reason, message: revokeMessage(reason) };
  }

  if (nowMs - session.issuedAtMs >= REFRESH_TOKEN_TTL_MS) {
    return { valid: false, reason: 'REFRESH_EXPIRED', message: revokeMessage('REFRESH_EXPIRED') };
  }

  if (nowMs - session.lastSeenAtMs >= IDLE_TIMEOUT_MS) {
    return { valid: false, reason: 'IDLE_TIMEOUT', message: revokeMessage('IDLE_TIMEOUT') };
  }

  return { valid: true };
}

export type RotationOutcome =
  | { readonly action: 'ROTATE' }
  | { readonly action: 'DENY'; readonly reason: RevokeReason; readonly message: string }
  /**
   * The presented token was already used. Someone is replaying a stolen refresh
   * token, or a client raced itself. Either way the honest response is to kill the
   * whole session rather than guess which holder is legitimate.
   */
  | { readonly action: 'REVOKE_ALL'; readonly reason: 'REFRESH_REUSE_DETECTED'; readonly message: string };

/**
 * Refresh rotation with reuse detection.
 *
 * Rotation alone does not help if a stolen token can be replayed: the thief and
 * the user would simply take turns rotating. Detecting that a *superseded* token
 * was presented is what turns rotation into a tripwire — so a stolen token gets
 * one use before the session dies and the real user is forced to sign in again.
 */
export function evaluateRefresh(
  session: StoredSession,
  presentedTokenHash: string,
  nowMs: number,
): RotationOutcome {
  const verdict = evaluateSession(session, nowMs);
  if (!verdict.valid) {
    return { action: 'DENY', reason: verdict.reason, message: verdict.message };
  }

  if (presentedTokenHash !== session.refreshTokenHash) {
    return {
      action: 'REVOKE_ALL',
      reason: 'REFRESH_REUSE_DETECTED',
      message: revokeMessage('REFRESH_REUSE_DETECTED'),
    };
  }

  return { action: 'ROTATE' };
}

/**
 * Single active session per employee (docs/05).
 *
 * Returns the sessions a new login must revoke. Admins are exempt: three admins
 * share upload and review duties across machines, and locking them to one device
 * would be fought rather than followed. Reps are the exfiltration surface this
 * control exists for.
 */
export function sessionsToRevokeOnLogin(
  role: 'OWNER' | 'ADMIN' | 'EMPLOYEE',
  activeSessions: readonly StoredSession[],
): readonly string[] {
  if (role !== 'EMPLOYEE') return [];
  return activeSessions.filter((s) => s.revokedAtMs === null).map((s) => s.sessionId);
}

/** Access-token expiry, for the JWT `exp` claim. */
export const accessTokenExpiryMs = (nowMs: number): number => nowMs + ACCESS_TOKEN_TTL_MS;
