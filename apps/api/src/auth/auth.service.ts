import { createHash, randomBytes } from 'node:crypto';
import { verify as verifyPassword } from '@node-rs/argon2';
import type { Pool } from 'pg';
import type { UserRole } from '@razorveda/shared';
import { withSystemContext } from '../db/rls-context.js';
import { evaluateLogin, type LoginCandidate, type LoginDecision } from './evaluate-login.js';
import {
  signAccessToken, signEnrolmentToken, verifyEnrolmentToken, REFRESH_TOKEN_BYTES,
} from './jwt.js';
import {
  ENROLMENT_TOKEN_TTL_MS, evaluateEnrolment, generateTotpSecret, otpauthUri,
  type EnrolmentCandidate,
} from './totp-enrolment.js';
import {
  evaluateRefresh, evaluateSession, revokeMessage,
  sessionsToRevokeOnLogin, type RevokeReason, type StoredSession,
} from './session-policy.js';
import { verifyTotp } from './totp.js';

/**
 * Authentication.
 *
 * Runs in `withSystemContext`, not `withRlsContext` — logging in is the act of
 * establishing who you are, so there is no user context to run under yet. This is
 * the one place that is legitimately un-scoped, and it is deliberately small.
 */

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
  readonly totp?: string | undefined;
  readonly ipAddress?: string | null;
  /** Local wall-clock "HH:MM" at the office, for the shift window. */
  readonly localTime: string;
}

export type LoginOutcome =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken: string;
      readonly user: { readonly userId: string; readonly role: UserRole; readonly fullName: string };
    }
  | { readonly ok: false; readonly reason: string; readonly message: string };

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export class AuthService {
  constructor(private readonly pool: Pool) {}

  async login(request: LoginRequest, nowMs = Date.now()): Promise<LoginOutcome> {
    return withSystemContext(this.pool, 'authenticate a user', async (client) => {
      const { rows } = await client.query<{
        user_id: string;
        password_hash: string;
        role: UserRole;
        is_locked: boolean;
        locked_reason: string | null;
        totp_secret: string | null;
        full_name: string | null;
        shift_start: string | null;
        shift_end: string | null;
      }>(
        // SECURITY DEFINER function, not a direct SELECT. app_user is admin-only
        // and a user signing in has no role yet, so a plain query returns nothing
        // and every password looks wrong. This is the one controlled doorway.
        `SELECT * FROM auth_lookup($1)`,
        [request.email],
      );

      const user = rows[0];

      // An unknown address must cost the same work as a wrong password, or the
      // response time alone tells an attacker which accounts exist.
      const passwordValid = user
        ? await verifyPassword(user.password_hash, request.password).catch(() => false)
        : await verifyPassword(DUMMY_HASH, request.password).catch(() => false);

      const candidate: LoginCandidate = {
        userId: user?.user_id ?? '00000000-0000-0000-0000-000000000000',
        role: user?.role ?? 'EMPLOYEE',
        isLocked: user?.is_locked ?? false,
        lockedReason: user?.locked_reason ?? null,
        totpSecret: user?.totp_secret ?? null,
        shift:
          user?.shift_start && user.shift_end
            ? { start: user.shift_start, end: user.shift_end }
            : null,
      };

      const totpValid =
        candidate.totpSecret && request.totp
          ? verifyTotp(candidate.totpSecret, request.totp, nowMs)
          : false;

      const decision: LoginDecision = evaluateLogin(user ? candidate : { ...candidate, isLocked: false }, {
        passwordValid: Boolean(user) && passwordValid,
        totpValid,
        totpProvided: Boolean(request.totp),
        localTime: request.localTime,
      });

      if (!decision.ok) {
        await this.audit(client, user?.user_id ?? null, 'LOGIN_FAILED', {
          reason: decision.reason,
          email: request.email,
        });
        return { ok: false, reason: decision.reason, message: decision.message };
      }

      // Single active session per rep (D-55). Admins are exempt.
      const { rows: open } = await client.query<StoredSession & { session_id: string }>(
        `SELECT session_id AS "sessionId", user_id AS "userId",
                refresh_token_hash AS "refreshTokenHash",
                extract(epoch from issued_at)*1000 AS "issuedAtMs",
                extract(epoch from last_seen_at)*1000 AS "lastSeenAtMs",
                NULL::bigint AS "revokedAtMs", NULL::text AS "revokedReason",
                device_fingerprint AS "deviceFingerprint"
           FROM app_session WHERE user_id = $1 AND revoked_at IS NULL`,
        [decision.userId],
      );

      const toRevoke = sessionsToRevokeOnLogin(decision.role, open);
      if (toRevoke.length > 0) {
        await this.revoke(client, toRevoke, 'SUPERSEDED_BY_NEW_LOGIN');
      }

      const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      const { rows: created } = await client.query<{ session_id: string }>(
        `INSERT INTO app_session (user_id, refresh_token_hash, ip_address)
         VALUES ($1,$2,$3::inet) RETURNING session_id`,
        [decision.userId, hashToken(refreshToken), request.ipAddress ?? null],
      );
      const sessionId = created[0]?.session_id;
      if (!sessionId) throw new Error('Failed to create a session.');

      // Same reason as above: app_user is admin-only and login has no role yet.
      await client.query(`SELECT auth_touch_last_login($1)`, [decision.userId]);
      await this.audit(client, decision.userId, 'LOGIN_SUCCEEDED', { sessionId });

      return {
        ok: true,
        accessToken: await signAccessToken(
          { sub: decision.userId, role: decision.role, sid: sessionId },
          nowMs,
        ),
        refreshToken,
        user: {
          userId: decision.userId,
          role: decision.role,
          fullName: user?.full_name ?? request.email,
        },
      };
    });
  }

  /**
   * Is this session still allowed to act? Called on every authenticated request.
   *
   * This is what a JWT alone cannot do: revocation is immediate because the answer
   * comes from a row, not from a signature.
   */
  async validateSession(
    sessionId: string,
    nowMs = Date.now(),
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return withSystemContext(this.pool, 'validate a session', async (client) => {
      const { rows } = await client.query<{
        session_id: string;
        user_id: string;
        refresh_token_hash: string;
        issued_ms: string;
        last_seen_ms: string;
        revoked_ms: string | null;
        revoked_reason: RevokeReason | null;
      }>(
        `SELECT session_id, user_id, refresh_token_hash,
                (extract(epoch from issued_at)*1000)::bigint::text  AS issued_ms,
                (extract(epoch from last_seen_at)*1000)::bigint::text AS last_seen_ms,
                (extract(epoch from revoked_at)*1000)::bigint::text   AS revoked_ms,
                revoked_reason
           FROM app_session WHERE session_id = $1`,
        [sessionId],
      );

      const row = rows[0];
      if (!row) return { ok: false, message: 'Your session has ended. Sign in again.' };

      const verdict = evaluateSession(
        {
          sessionId: row.session_id,
          userId: row.user_id,
          refreshTokenHash: row.refresh_token_hash,
          issuedAtMs: Number(row.issued_ms),
          lastSeenAtMs: Number(row.last_seen_ms),
          revokedAtMs: row.revoked_ms === null ? null : Number(row.revoked_ms),
          revokedReason: row.revoked_reason,
          deviceFingerprint: null,
        },
        nowMs,
      );

      if (!verdict.valid) {
        // Record WHY, so "why was I signed out" has an answer.
        if (row.revoked_ms === null) {
          await this.revoke(client, [sessionId], verdict.reason);
        }
        return { ok: false, message: verdict.message };
      }

      // Sliding idle window.
      await client.query(`UPDATE app_session SET last_seen_at = now() WHERE session_id = $1`, [
        sessionId,
      ]);
      return { ok: true };
    });
  }

  /** Rotating refresh with reuse detection (D-54). */
  async refresh(
    refreshToken: string,
    nowMs = Date.now(),
  ): Promise<
    | { readonly ok: true; readonly accessToken: string; readonly refreshToken: string }
    | { readonly ok: false; readonly message: string }
  > {
    return withSystemContext(this.pool, 'rotate a refresh token', async (client) => {
      const presented = hashToken(refreshToken);

      // Look the session up by USER, not by the presented hash — a replayed old
      // token must be recognised, and a lookup by hash would simply miss it.
      const { rows } = await client.query<{
        session_id: string; user_id: string; role: UserRole; refresh_token_hash: string;
        issued_ms: string; last_seen_ms: string; revoked_ms: string | null;
        revoked_reason: RevokeReason | null;
      }>(
        `SELECT s.session_id, s.user_id, u.role, s.refresh_token_hash,
                (extract(epoch from s.issued_at)*1000)::bigint::text    AS issued_ms,
                (extract(epoch from s.last_seen_at)*1000)::bigint::text AS last_seen_ms,
                (extract(epoch from s.revoked_at)*1000)::bigint::text   AS revoked_ms,
                s.revoked_reason
           FROM app_session s JOIN app_user u ON u.user_id = s.user_id
          WHERE s.refresh_token_hash = $1`,
        [presented],
      );

      const row = rows[0];
      if (!row) {
        return { ok: false, message: revokeMessage('REFRESH_EXPIRED') };
      }

      const stored: StoredSession = {
        sessionId: row.session_id,
        userId: row.user_id,
        refreshTokenHash: row.refresh_token_hash,
        issuedAtMs: Number(row.issued_ms),
        lastSeenAtMs: Number(row.last_seen_ms),
        revokedAtMs: row.revoked_ms === null ? null : Number(row.revoked_ms),
        revokedReason: row.revoked_reason,
        deviceFingerprint: null,
      };

      const outcome = evaluateRefresh(stored, presented, nowMs);
      if (outcome.action !== 'ROTATE') {
        if (outcome.action === 'REVOKE_ALL') {
          await this.revokeAllForUser(client, row.user_id, 'REFRESH_REUSE_DETECTED');
        }
        return { ok: false, message: outcome.message };
      }

      const next = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
      await client.query(
        `UPDATE app_session SET refresh_token_hash = $2, last_seen_at = now()
          WHERE session_id = $1`,
        [row.session_id, hashToken(next)],
      );

      return {
        ok: true,
        accessToken: await signAccessToken(
          { sub: row.user_id, role: row.role, sid: row.session_id },
          nowMs,
        ),
        refreshToken: next,
      };
    });
  }

  /**
   * Step 1 of enrolment: prove the password, get a secret to scan.
   *
   * The password check is not optional politeness — without it, anyone who knew
   * an admin's email could bind their own authenticator to the account and own
   * it outright.
   */
  async startTotpEnrolment(
    email: string,
    password: string,
    nowMs = Date.now(),
  ): Promise<
    | { readonly ok: true; readonly enrolmentToken: string; readonly secret: string; readonly otpauthUri: string }
    | { readonly ok: false; readonly reason: string; readonly message: string }
  > {
    return withSystemContext(this.pool, 'start two-factor enrolment', async (client) => {
      const { rows } = await client.query<{
        user_id: string; password_hash: string; role: UserRole;
        is_locked: boolean; totp_secret: string | null;
      }>(`SELECT * FROM auth_lookup($1)`, [email]);

      const user = rows[0];
      const passwordValid = user
        ? await verifyPassword(user.password_hash, password).catch(() => false)
        : await verifyPassword(DUMMY_HASH, password).catch(() => false);

      const candidate: EnrolmentCandidate | null = user
        ? {
            userId: user.user_id,
            email,
            role: user.role,
            isLocked: user.is_locked,
            hasSecret: user.totp_secret !== null,
          }
        : null;

      const decision = evaluateEnrolment(candidate, passwordValid);
      if (!decision.ok) {
        await this.audit(client, user?.user_id ?? null, 'TOTP_ENROLMENT_REFUSED', {
          reason: decision.reason,
          email,
        });
        return { ok: false, reason: decision.reason, message: decision.message };
      }

      const secret = generateTotpSecret();
      await this.audit(client, decision.userId, 'TOTP_ENROLMENT_STARTED', { email });

      return {
        ok: true,
        // Signed, so the secret cannot be swapped between the two steps.
        enrolmentToken: await signEnrolmentToken(
          { sub: decision.userId, secret },
          nowMs,
          ENROLMENT_TOKEN_TTL_MS,
        ),
        secret,
        otpauthUri: otpauthUri(decision.email, secret),
      };
    });
  }

  /** Step 2: prove the authenticator works before anything is saved. */
  async confirmTotpEnrolment(
    enrolmentToken: string,
    code: string,
    nowMs = Date.now(),
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const verified = await verifyEnrolmentToken(enrolmentToken);
    if (!verified.ok) {
      return { ok: false, message: 'That setup has expired. Start again from the beginning.' };
    }
    if (!verifyTotp(verified.claims.secret, code, nowMs)) {
      return { ok: false, message: 'That code is not right. Check your authenticator and try again.' };
    }

    return withSystemContext(this.pool, 'confirm two-factor enrolment', async (client) => {
      // SECURITY DEFINER, not a direct UPDATE. app_user is admin-only, and an
      // admin enrolling for the first time has no session — so the UPDATE matched
      // zero rows SILENTLY and this branch reported "already enrolled" for what
      // was really a permissions failure. The `totp_secret IS NULL` guard lives
      // inside the function, so the one-time rule is the database's and two
      // concurrent enrolments cannot both win.
      const { rows: [result] } = await client.query<{ enrolled: boolean }>(
        `SELECT auth_enrol_totp($1, $2) AS enrolled`,
        [verified.claims.sub, verified.claims.secret],
      );
      if (!result?.enrolled) {
        return {
          ok: false,
          message: 'This account already has an authenticator. Ask an admin to reset two-factor.',
        };
      }
      await this.audit(client, verified.claims.sub, 'TOTP_ENROLLED', {});
      return { ok: true };
    });
  }

  async logout(sessionId: string): Promise<void> {
    await withSystemContext(this.pool, 'end a session', async (client) => {
      await this.revoke(client, [sessionId], 'LOGOUT');
    });
  }

  private async revoke(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    sessionIds: readonly string[],
    reason: RevokeReason,
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    await client.query(
      `UPDATE app_session SET revoked_at = now(), revoked_reason = $2
        WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [sessionIds, reason],
    );
  }

  private async revokeAllForUser(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    userId: string,
    reason: RevokeReason,
  ): Promise<void> {
    await client.query(
      `UPDATE app_session SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    userId: string | null,
    action: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, after_json)
       VALUES ($1,$2,'app_user',$3::jsonb)`,
      [userId, action, JSON.stringify(detail)],
    );
  }
}

/**
 * A real Argon2id hash of a value nobody knows, used to spend the same time on an
 * unknown address as on a known one. Without it, a fast rejection reveals which
 * addresses exist.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$Yx1kZ3lFQZ8sOZ0Xk7lVQ4pXfQxHqYwZ1lQeQqYQ8Qo';
