import { describe, it, expect } from 'vitest';
import {
  MIN_OWNER_PASSWORD_LENGTH,
  evaluateOwnerClaim,
  ownerClaimWrite,
  type ClaimAttempt,
  type OwnerAccountState,
} from '../src/auth/owner-claim.js';
import { canEditRosterField, statusChangeEffects } from '../src/employees/roster-rules.js';

const TOKEN = 'a-long-out-of-band-claim-token';

const unclaimed: OwnerAccountState = {
  userId: '11111111-2222-3333-4444-555555555555',
  email: 'owner@razorveda.local',
  isLocked: true,
  lockedReason: 'OWNER account not yet nominated (O-07).',
  claimedAt: null,
};

const goodAttempt: ClaimAttempt = {
  email: 'director@razorveda.com',
  password: 'a-properly-long-passphrase',
  token: TOKEN,
};

describe('claiming the OWNER account (O-07, D-88)', () => {
  it('succeeds with the out-of-band token', () => {
    expect(evaluateOwnerClaim(unclaimed, goodAttempt, TOKEN)).toEqual({
      ok: true,
      userId: unclaimed.userId,
      email: 'director@razorveda.com',
    });
  });

  it('REFUSES without the token — an admin cannot promote themselves', () => {
    // The whole point. docs/05: "three admins with identical, mutually
    // unrevocable access and nobody above them is a gap." If any admin can become
    // OWNER, the gap is back — except now it looks closed, which is worse.
    expect(evaluateOwnerClaim(unclaimed, { ...goodAttempt, token: 'guessed' }, TOKEN))
      .toMatchObject({ ok: false, reason: 'BAD_TOKEN' });
  });

  it('REFUSES when no token is configured, rather than treating that as no check', () => {
    // The dangerous default: an unset secret meaning "skip the check". That is how
    // a security control becomes decorative in production.
    for (const missing of [undefined, '', '   ']) {
      expect(evaluateOwnerClaim(unclaimed, goodAttempt, missing)).toMatchObject({
        ok: false,
        reason: 'NO_TOKEN_CONFIGURED',
      });
    }
  });

  it('is one-time — a claimed account cannot be claimed again', () => {
    const claimed: OwnerAccountState = { ...unclaimed, claimedAt: '2026-08-21T10:00:00.000Z' };
    expect(evaluateOwnerClaim(claimed, goodAttempt, TOKEN)).toMatchObject({
      ok: false,
      reason: 'ALREADY_CLAIMED',
    });
  });

  it('reports ALREADY_CLAIMED before checking the token', () => {
    // Otherwise a wrong token could be used to probe whether the account is still
    // available — the same enumeration-oracle shape as the login order (D-51).
    const claimed: OwnerAccountState = { ...unclaimed, claimedAt: '2026-08-21T10:00:00.000Z' };
    expect(evaluateOwnerClaim(claimed, { ...goodAttempt, token: 'wrong' }, TOKEN)).toMatchObject({
      reason: 'ALREADY_CLAIMED',
    });
  });

  it('requires a real email and a long passphrase', () => {
    expect(evaluateOwnerClaim(unclaimed, { ...goodAttempt, email: 'not-an-email' }, TOKEN))
      .toMatchObject({ reason: 'INVALID_EMAIL' });

    const short = 'x'.repeat(MIN_OWNER_PASSWORD_LENGTH - 1);
    const r = evaluateOwnerClaim(unclaimed, { ...goodAttempt, password: short }, TOKEN);
    expect(r).toMatchObject({ reason: 'WEAK_PASSWORD' });
    if (!r.ok) expect(r.message).toContain('targets');
  });

  it('does not enrol TOTP — the login path forces that next', () => {
    // OWNER requires 2FA, and evaluateLogin refuses an OWNER with no enrolled
    // secret rather than waving them through (D-52). Enrolment is therefore
    // enforced by the login path, not by a reminder somebody can ignore.
    const write = ownerClaimWrite('director@razorveda.com', 'hash', '2026-08-21T10:00:00.000Z');
    expect(write).toMatchObject({ isLocked: false, lockedReason: null });
    expect(Object.keys(write)).not.toContain('totpSecret');
    expect(write.auditAction).toBe('OWNER_ACCOUNT_CLAIMED');
  });
});

describe('roster management (O-01, D-87)', () => {
  it('lets an admin manage the roster', () => {
    for (const f of ['full_name', 'status', 'wip_cap', 'shift_start'] as const) {
      expect(canEditRosterField('ADMIN', f).allowed, f).toBe(true);
    }
  });

  it('does NOT let an admin set targets', () => {
    // docs/05 gives OWNER exactly three extra powers, and targets is one. An admin
    // who could set targets could set their own incentive.
    const r = canEditRosterField('ADMIN', 'monthly_target');
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain('own incentive');
  });

  it('does NOT let an admin change roles', () => {
    expect(canEditRosterField('ADMIN', 'role').allowed).toBe(false);
  });

  it('lets the owner do both', () => {
    expect(canEditRosterField('OWNER', 'monthly_target').allowed).toBe(true);
    expect(canEditRosterField('OWNER', 'role').allowed).toBe(true);
  });

  it('lets an employee change nothing', () => {
    expect(canEditRosterField('EMPLOYEE', 'full_name').allowed).toBe(false);
  });
});

describe('status changes do the right thing to the pipeline', () => {
  it('EXITED returns leads to the pool and revokes access', () => {
    // docs/05 offboarding, in one action. Leaving a departed rep's leads assigned
    // is how 174 leads sat untouched for a full validity window.
    expect(statusChangeEffects('EXITED')).toEqual({
      returnLeadsToPool: true,
      revokeSessions: true,
      assignable: false,
      handoverNoteRequired: true,
    });
  });

  it('ON_LEAVE keeps the pipeline intact', () => {
    // A rep back next week should find her pipeline where she left it. The
    // assignment console already warns she is on leave, which is the right place
    // for that judgement.
    expect(statusChangeEffects('ON_LEAVE')).toMatchObject({
      returnLeadsToPool: false,
      assignable: false,
    });
  });

  it('SUSPENDED stops access now but does not scatter the pipeline', () => {
    expect(statusChangeEffects('SUSPENDED')).toMatchObject({
      revokeSessions: true,
      returnLeadsToPool: false,
      assignable: false,
    });
  });

  it('only EXITED demands a handover note', () => {
    for (const s of ['ACTIVE', 'ON_LEAVE', 'SUSPENDED'] as const) {
      expect(statusChangeEffects(s).handoverNoteRequired, s).toBe(false);
    }
  });
});
