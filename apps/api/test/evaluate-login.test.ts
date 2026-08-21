import { describe, it, expect } from 'vitest';
import {
  evaluateLogin,
  isWithinShift,
  requiresTotp,
  type LoginAttempt,
  type LoginCandidate,
} from '../src/auth/evaluate-login.js';

const rep: LoginCandidate = {
  userId: '11111111-2222-3333-4444-555555555555',
  role: 'EMPLOYEE',
  isLocked: false,
  lockedReason: null,
  totpSecret: null,
  shift: { start: '10:00', end: '20:00' },
};

const admin: LoginCandidate = {
  ...rep,
  role: 'ADMIN',
  totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  shift: null,
};

const good: LoginAttempt = {
  passwordValid: true,
  totpValid: true,
  totpProvided: true,
  localTime: '14:30',
};

describe('isWithinShift', () => {
  it('includes both ends of the window', () => {
    expect(isWithinShift('10:00', '10:00', '20:00')).toBe(true);
    expect(isWithinShift('20:00', '10:00', '20:00')).toBe(true);
  });

  it('excludes outside', () => {
    expect(isWithinShift('09:59', '10:00', '20:00')).toBe(false);
    expect(isWithinShift('20:01', '10:00', '20:00')).toBe(false);
    expect(isWithinShift('03:00', '10:00', '20:00')).toBe(false);
  });

  it('handles a shift that crosses midnight', () => {
    // Not the seeded 10:00-20:00, but a night shift would — and discovering that
    // by locking a team out is an expensive way to find a bug.
    expect(isWithinShift('23:30', '22:00', '06:00')).toBe(true);
    expect(isWithinShift('02:00', '22:00', '06:00')).toBe(true);
    expect(isWithinShift('12:00', '22:00', '06:00')).toBe(false);
  });

  it('tolerates seconds, which Postgres time columns include', () => {
    expect(isWithinShift('14:30', '10:00:00', '20:00:00')).toBe(true);
  });

  it('fails closed on malformed input', () => {
    expect(isWithinShift('2pm', '10:00', '20:00')).toBe(false);
    expect(isWithinShift('14:30', '', '20:00')).toBe(false);
  });
});

describe('evaluateLogin — check order is a security property', () => {
  it('reports invalid credentials before anything more specific', () => {
    // A locked account with a WRONG password must not reveal that it is locked;
    // otherwise the login form becomes an account-enumeration oracle.
    const lockedAdmin = { ...admin, isLocked: true, lockedReason: 'velocity lock' };
    const d = evaluateLogin(lockedAdmin, { ...good, passwordValid: false });
    expect(d.ok).toBe(false);
    expect(d).toMatchObject({ reason: 'INVALID_CREDENTIALS' });
    expect(JSON.stringify(d)).not.toContain('velocity');
  });

  it('gives the same message for a wrong password as for an unknown address', () => {
    const a = evaluateLogin(rep, { ...good, passwordValid: false });
    const b = evaluateLogin(admin, { ...good, passwordValid: false });
    expect(a).toEqual(b);
  });

  it('locked beats shift hours and TOTP', () => {
    // docs/05 test 8: a locked account cannot authenticate until an admin unlocks
    // it — not by waiting for their shift, and not with a correct code.
    const locked = { ...admin, isLocked: true, lockedReason: 'Copy velocity exceeded.' };
    const d = evaluateLogin(locked, { ...good, totpValid: false, localTime: '03:00' });
    expect(d).toMatchObject({ reason: 'ACCOUNT_LOCKED' });
  });

  it('tells a locked user what happened and what to do next', () => {
    const owner: LoginCandidate = {
      ...admin,
      role: 'OWNER',
      isLocked: true,
      lockedReason: 'OWNER account not yet nominated (O-07).',
    };
    const d = evaluateLogin(owner, good);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.message).toContain('O-07');
      expect(d.message).toContain('unlock');
      expect(d.message).not.toMatch(/something went wrong/i);
    }
  });
});

describe('evaluateLogin — shift window', () => {
  it('lets a rep in during their shift', () => {
    expect(evaluateLogin(rep, good)).toMatchObject({ ok: true, role: 'EMPLOYEE' });
  });

  it('keeps a rep out at 3am, and names the window', () => {
    const d = evaluateLogin(rep, { ...good, localTime: '03:00' });
    expect(d).toMatchObject({ reason: 'OUTSIDE_SHIFT_HOURS' });
    if (!d.ok) expect(d.message).toContain('10:00 to 20:00');
  });

  it('does not shift-bind admins or owners', () => {
    expect(evaluateLogin(admin, { ...good, localTime: '03:00' })).toMatchObject({ ok: true });
    expect(evaluateLogin({ ...admin, role: 'OWNER' }, { ...good, localTime: '03:00' })).toMatchObject(
      { ok: true },
    );
  });
});

describe('evaluateLogin — two-factor', () => {
  it('requires TOTP for ADMIN and OWNER, not for EMPLOYEE', () => {
    expect(requiresTotp('ADMIN')).toBe(true);
    expect(requiresTotp('OWNER')).toBe(true);
    expect(requiresTotp('EMPLOYEE')).toBe(false);
  });

  it('refuses an admin who did not supply a code', () => {
    expect(evaluateLogin(admin, { ...good, totpProvided: false })).toMatchObject({
      reason: 'TOTP_REQUIRED',
    });
  });

  it('refuses an admin whose code is wrong', () => {
    expect(evaluateLogin(admin, { ...good, totpValid: false })).toMatchObject({
      reason: 'TOTP_REQUIRED',
    });
  });

  it('refuses an admin with no enrolled secret rather than letting them through', () => {
    // The dangerous branch: mandatory 2FA that silently becomes optional because
    // setup was never finished. Mandatory means mandatory.
    const unenrolled = { ...admin, totpSecret: null };
    const d = evaluateLogin(unenrolled, good);
    expect(d).toMatchObject({ reason: 'TOTP_REQUIRED' });
    if (!d.ok) expect(d.message).toContain('not set up yet');
  });

  it('ignores a stray TOTP from a rep, who is not enrolled', () => {
    expect(evaluateLogin(rep, { ...good, totpProvided: false, totpValid: false })).toMatchObject({
      ok: true,
    });
  });
});
