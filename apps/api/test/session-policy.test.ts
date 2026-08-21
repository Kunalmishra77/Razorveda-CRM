import { describe, it, expect } from 'vitest';
import {
  ACCESS_TOKEN_TTL_MS,
  IDLE_TIMEOUT_MS,
  REFRESH_TOKEN_TTL_MS,
  accessTokenExpiryMs,
  evaluateRefresh,
  evaluateSession,
  sessionsToRevokeOnLogin,
  type StoredSession,
} from '../src/auth/session-policy.js';

const T0 = 1_755_000_000_000;

const session = (over: Partial<StoredSession> = {}): StoredSession => ({
  sessionId: 'sess-1',
  userId: '11111111-2222-3333-4444-555555555555',
  refreshTokenHash: 'hash-current',
  issuedAtMs: T0,
  lastSeenAtMs: T0,
  revokedAtMs: null,
  revokedReason: null,
  deviceFingerprint: null,
  ...over,
});

describe('lifetimes match docs/05', () => {
  it('access 15 min, refresh 7 days, idle 10 min', () => {
    expect(ACCESS_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    expect(REFRESH_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(IDLE_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(accessTokenExpiryMs(T0)).toBe(T0 + ACCESS_TOKEN_TTL_MS);
  });
});

describe('evaluateSession', () => {
  it('accepts a fresh session', () => {
    expect(evaluateSession(session(), T0 + 60_000)).toEqual({ valid: true });
  });

  it('expires exactly AT the idle boundary, not one tick after', () => {
    // Off-by-one here means a 10-minute policy that is really 10 minutes plus
    // however long the next request takes to arrive.
    expect(evaluateSession(session(), T0 + IDLE_TIMEOUT_MS - 1).valid).toBe(true);
    expect(evaluateSession(session(), T0 + IDLE_TIMEOUT_MS)).toMatchObject({
      valid: false,
      reason: 'IDLE_TIMEOUT',
    });
  });

  it('slides the idle window on activity', () => {
    const active = session({ lastSeenAtMs: T0 + 9 * 60_000 });
    expect(evaluateSession(active, T0 + 15 * 60_000).valid).toBe(true);
  });

  it('expires at the absolute refresh lifetime even if constantly active', () => {
    // A rep who never goes idle still gets logged out after 7 days.
    const busy = session({ lastSeenAtMs: T0 + REFRESH_TOKEN_TTL_MS });
    expect(evaluateSession(busy, T0 + REFRESH_TOKEN_TTL_MS)).toMatchObject({
      reason: 'REFRESH_EXPIRED',
    });
  });

  it('reports an explicit revocation ahead of a timeout', () => {
    const kicked = session({
      revokedAtMs: T0 + 1000,
      revokedReason: 'SUPERSEDED_BY_NEW_LOGIN',
      lastSeenAtMs: T0 - REFRESH_TOKEN_TTL_MS,
    });
    const v = evaluateSession(kicked, T0 + 2000);
    expect(v).toMatchObject({ reason: 'SUPERSEDED_BY_NEW_LOGIN' });
    // Says what happened and what to do next (docs/07 section 5).
    if (!v.valid) expect(v.message).toContain('another device');
  });

  it('never says "something went wrong"', () => {
    const reasons = ['LOGOUT', 'IDLE_TIMEOUT', 'REFRESH_EXPIRED', 'ACCOUNT_LOCKED'] as const;
    for (const r of reasons) {
      const v = evaluateSession(session({ revokedAtMs: T0, revokedReason: r }), T0 + 1);
      if (!v.valid) {
        expect(v.message).not.toMatch(/something went wrong/i);
        expect(v.message.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('evaluateRefresh — rotation with reuse detection', () => {
  it('rotates when the current token is presented', () => {
    expect(evaluateRefresh(session(), 'hash-current', T0 + 1000)).toEqual({ action: 'ROTATE' });
  });

  it('KILLS THE SESSION when a superseded token is replayed', () => {
    // Rotation alone is not a control: a thief and the real user would simply take
    // turns rotating. Detecting a stale token is the tripwire that makes rotation
    // worth having — a stolen token buys one use, then the session dies.
    const out = evaluateRefresh(session(), 'hash-previous', T0 + 1000);
    expect(out).toMatchObject({ action: 'REVOKE_ALL', reason: 'REFRESH_REUSE_DETECTED' });
  });

  it('tells the user to raise it with an admin if unexpected', () => {
    const out = evaluateRefresh(session(), 'hash-previous', T0 + 1000);
    if (out.action === 'REVOKE_ALL') expect(out.message).toContain('admin');
  });

  it('denies rather than rotating an already-expired session', () => {
    const stale = session({ lastSeenAtMs: T0 - IDLE_TIMEOUT_MS });
    expect(evaluateRefresh(stale, 'hash-current', T0)).toMatchObject({
      action: 'DENY',
      reason: 'IDLE_TIMEOUT',
    });
  });

  it('checks expiry BEFORE reuse, so a lapsed token is not treated as an attack', () => {
    // An expired session presenting an old hash is an ordinary lapsed login, not
    // a replay. Reporting it as a security event would train people to ignore
    // security events.
    const stale = session({ lastSeenAtMs: T0 - IDLE_TIMEOUT_MS });
    expect(evaluateRefresh(stale, 'hash-previous', T0)).toMatchObject({ action: 'DENY' });
  });
});

describe('sessionsToRevokeOnLogin — single session per rep', () => {
  it('revokes a rep existing sessions', () => {
    const open = [session({ sessionId: 'a' }), session({ sessionId: 'b' })];
    expect(sessionsToRevokeOnLogin('EMPLOYEE', open)).toEqual(['a', 'b']);
  });

  it('ignores already-revoked sessions', () => {
    const mixed = [
      session({ sessionId: 'a' }),
      session({ sessionId: 'b', revokedAtMs: T0, revokedReason: 'LOGOUT' }),
    ];
    expect(sessionsToRevokeOnLogin('EMPLOYEE', mixed)).toEqual(['a']);
  });

  it('exempts ADMIN and OWNER', () => {
    // Three admins share upload and review duties across machines. A one-device
    // rule there would be fought rather than followed, and reps are the
    // exfiltration surface the control exists for.
    const open = [session({ sessionId: 'a' })];
    expect(sessionsToRevokeOnLogin('ADMIN', open)).toEqual([]);
    expect(sessionsToRevokeOnLogin('OWNER', open)).toEqual([]);
  });
});
