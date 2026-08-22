import { describe, it, expect } from 'vitest';
import {
  ENROLMENT_TOKEN_TTL_MS, evaluateEnrolment, generateTotpSecret, otpauthUri,
  type EnrolmentCandidate,
} from '../src/auth/totp-enrolment.js';
import { verifyTotp, totp, base32Decode } from '../src/auth/totp.js';

/**
 * Two-factor enrolment. The tests are mostly about who is REFUSED, because that
 * is where the security lives — a working happy path with a broken refusal is an
 * account-takeover route.
 */

const admin: EnrolmentCandidate = {
  userId: '11111111-2222-3333-4444-555555555555',
  email: 'sunita@razorveda.com',
  role: 'ADMIN',
  isLocked: false,
  hasSecret: false,
};

describe('who may start enrolment', () => {
  it('an unenrolled admin with the right password', () => {
    expect(evaluateEnrolment(admin, true)).toMatchObject({ ok: true, userId: admin.userId });
  });

  it('REFUSES a wrong password — otherwise an email alone takes the account', () => {
    // Without this, anyone who knew an admin's address could bind their own
    // authenticator and own the account outright.
    expect(evaluateEnrolment(admin, false)).toMatchObject({ reason: 'INVALID_CREDENTIALS' });
  });

  it('REFUSES an unknown account with the same message as a wrong password', () => {
    expect(evaluateEnrolment(null, false)).toEqual(evaluateEnrolment(admin, false));
  });

  it('REFUSES an account that already has an authenticator', () => {
    // Self-service re-binding means a stolen password is enough to take the
    // account PERMANENTLY. Losing a phone is an admin-assisted reset.
    const r = evaluateEnrolment({ ...admin, hasSecret: true }, true);
    expect(r).toMatchObject({ reason: 'ALREADY_ENROLLED' });
    if (!r.ok) expect(r.message).toMatch(/admin must reset/i);
  });

  it('REFUSES a locked account', () => {
    expect(evaluateEnrolment({ ...admin, isLocked: true }, true)).toMatchObject({
      reason: 'ACCOUNT_LOCKED',
    });
  });

  it('tells an employee they do not need it', () => {
    const r = evaluateEnrolment({ ...admin, role: 'EMPLOYEE' }, true);
    expect(r).toMatchObject({ reason: 'NOT_REQUIRED' });
    if (!r.ok) expect(r.message).toMatch(/sign in with your password/i);
  });

  it('checks credentials BEFORE anything more specific', () => {
    // Same reasoning as the login order (D-51): a more specific refusal reveals
    // whether an account exists and whether it is already enrolled.
    const enrolledAndLocked = { ...admin, hasSecret: true, isLocked: true };
    expect(evaluateEnrolment(enrolledAndLocked, false)).toMatchObject({
      reason: 'INVALID_CREDENTIALS',
    });
  });
});

describe('the generated secret', () => {
  it('is 160 bits of base32, as RFC 4226 recommends', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('is different every time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(50);
  });

  it('actually works with the verifier that will check it', () => {
    // The pair that matters: a secret this function produces must validate
    // against the same code path a real login uses.
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, '000000', now)).toBe(false);
  });
});

describe('the otpauth URI an authenticator scans', () => {
  const uri = otpauthUri('sunita@razorveda.com', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

  it('carries the secret, issuer and parameters our verifier assumes', () => {
    // SHA1 / 6 digits / 30s are not defaults to leave implicit: an app configured
    // differently produces codes that will never match.
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('labels the entry so several work accounts stay distinguishable', () => {
    expect(decodeURIComponent(uri)).toContain('Razorveda CRM:sunita@razorveda.com');
  });
});

describe('the enrolment window', () => {
  it('is 10 minutes — long enough to scan, short enough not to linger', () => {
    expect(ENROLMENT_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
  });
});
