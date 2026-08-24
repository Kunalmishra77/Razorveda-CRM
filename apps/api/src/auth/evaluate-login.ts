import type { UserRole } from '@razorveda/shared';

/**
 * The login decision, as a pure function.
 *
 * Kept free of I/O so every branch is testable without a database, a clock, or a
 * running server — and so the ORDER of the checks is visible in one place. That
 * order is a security property, not a style choice.
 */

export type LoginFailureReason =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'OUTSIDE_SHIFT_HOURS'
  | 'TOTP_REQUIRED';

export interface LoginCandidate {
  readonly userId: string;
  readonly role: UserRole;
  readonly isLocked: boolean;
  readonly lockedReason: string | null;
  /** Null for accounts that have not enrolled. ADMIN and OWNER must have one. */
  readonly totpSecret: string | null;
  /** Absent for ADMIN and OWNER, who are not shift-bound. */
  readonly shift: { readonly start: string; readonly end: string } | null;
}

export interface LoginAttempt {
  /** Result of verifying the submitted password against the stored Argon2id hash. */
  readonly passwordValid: boolean;
  readonly totpValid: boolean;
  readonly totpProvided: boolean;
  /** Local time at the office, "HH:MM". Asia/Kolkata — see TZ in .env. */
  readonly localTime: string;
}

export type LoginDecision =
  | { readonly ok: true; readonly userId: string; readonly role: UserRole }
  | { readonly ok: false; readonly reason: LoginFailureReason; readonly message: string };

/** ADMIN and OWNER carry mandatory 2FA (docs/05, Identity). */
/**
 * Admins and the owner need a second factor. Reps do not — they dial from their
 * own handsets all day and a 6-digit code every morning would be friction with no
 * matching risk: a rep already only sees her own leads.
 *
 * WHY THIS IS SWITCHABLE, AND WHY IT IS ON BY DEFAULT.
 *
 * An admin can read every customer's phone number in the business, change the
 * prices that decide what people are paid, and unlock accounts. If an admin
 * password leaks, the second factor is the only thing left. So the default is ON,
 * and it stays on unless somebody deliberately turns it off.
 *
 * `TOTP_DISABLED=1` turns it off. That exists because demanding an authenticator
 * app before anyone can look at the product makes a local walkthrough painful,
 * and the honest fix is a switch rather than pretending the requirement was never
 * there. Set it in development; leaving it set in production means an admin
 * account is one leaked password away from everything above.
 *
 * The API says which state it is in on every boot, so this is never a surprise.
 */
export const requiresTotp = (role: UserRole): boolean => {
  if (process.env['TOTP_DISABLED'] === '1') return false;
  return role === 'ADMIN' || role === 'OWNER';
};

/**
 * ADMIN and OWNER are not shift-bound; reps are.
 *
 * `SHIFT_HOURS_DISABLED=1` lifts it, and the same reasoning applies as for TOTP
 * (D-305): the control is real and stays ON by default, but demanding that a
 * demo, a bug reproduction or an evening's development happen between 10:00 and
 * 20:00 IST is a tax with no security value on a laptop. It is a documented
 * switch rather than a rule quietly softened, and the API announces which state
 * it is in on every boot — a control that can be turned off silently is one
 * nobody notices is off.
 *
 * In production this stays unset. The shift window is what stops a rep pulling
 * customer phone numbers at 3am.
 */
export const isShiftBound = (role: UserRole): boolean => {
  if (process.env['SHIFT_HOURS_DISABLED'] === '1') return false;
  return role === 'EMPLOYEE';
};

/**
 * "HH:MM" comparison, inclusive of both ends.
 *
 * Handles a shift that crosses midnight (end < start), which the seeded 10:00-20:00
 * does not — but a night shift would, and discovering that by locking a team out
 * is an expensive way to find a bug.
 */
export function isWithinShift(now: string, start: string, end: string): boolean {
  const valid = (t: string) => /^\d{2}:\d{2}(:\d{2})?$/.test(t);
  if (!valid(now) || !valid(start) || !valid(end)) return false;

  const hhmm = (t: string) => t.slice(0, 5);
  const [n, s, e] = [hhmm(now), hhmm(start), hhmm(end)];

  return s <= e ? n >= s && n <= e : n >= s || n <= e;
}

/**
 * Check order, and why:
 *
 * 1. Password first. Every later reason is more specific than "no", so revealing
 *    one before the password is verified would turn the login form into an
 *    account-enumeration oracle: an attacker could learn which addresses exist,
 *    which are locked, and who works which shift, without a valid credential.
 * 2. Locked next, and it beats everything else. docs/05 test 8: a locked account
 *    cannot authenticate until an admin unlocks it — not by waiting for their
 *    shift, and not by producing a correct TOTP.
 * 3. Shift window before TOTP: no point asking a rep for a code at 3am.
 * 4. TOTP last, for ADMIN and OWNER.
 */
export function evaluateLogin(user: LoginCandidate, attempt: LoginAttempt): LoginDecision {
  if (!attempt.passwordValid) {
    return {
      ok: false,
      reason: 'INVALID_CREDENTIALS',
      // Deliberately identical for a wrong password and an unknown address.
      message: 'That email and password do not match. Check both and try again.',
    };
  }

  if (user.isLocked) {
    return {
      ok: false,
      reason: 'ACCOUNT_LOCKED',
      // Says what happened and what to do next (docs/07 section 5). The seeded
      // OWNER account lands here until O-07 nominates a person (D-41).
      message: user.lockedReason
        ? `This account is locked: ${user.lockedReason} An admin can unlock it.`
        : 'This account is locked. Ask an admin to unlock it.',
    };
  }

  if (isShiftBound(user.role) && user.shift) {
    if (!isWithinShift(attempt.localTime, user.shift.start, user.shift.end)) {
      return {
        ok: false,
        reason: 'OUTSIDE_SHIFT_HOURS',
        message:
          `Sign-in is only available during your shift, ` +
          `${user.shift.start.slice(0, 5)} to ${user.shift.end.slice(0, 5)}. ` +
          `Ask an admin if you need access outside these hours.`,
      };
    }
  }

  if (requiresTotp(user.role)) {
    // An admin with no enrolled secret must not fall through to a successful
    // login. Mandatory means mandatory, even when setup is incomplete.
    if (!user.totpSecret || !attempt.totpProvided || !attempt.totpValid) {
      return {
        ok: false,
        reason: 'TOTP_REQUIRED',
        message: !user.totpSecret
          ? 'Two-factor authentication is required for this role but is not set up yet. Ask an admin to enrol this account.'
          : 'Enter the 6-digit code from your authenticator app.',
      };
    }
  }

  return { ok: true, userId: user.userId, role: user.role };
}
