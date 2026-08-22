import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * The admin security console (Phase 5 deliverable 5) and offboarding (6).
 *
 * THE GAP THIS OPENED WITH: there was no way to unlock an account.
 *
 * Eight separate places in the codebase tell a user "an admin can unlock it" —
 * the login refusal, the TOTP enrolment refusal, the velocity-lock message the
 * rep sees, the alert the admin receives. None of them was true. The velocity
 * lock shipped able to put a rep out of the system permanently, with raw SQL as
 * the only way back. A control with no release is not a control, it is a trap.
 *
 * Everything here reads `audit_log` and `pii_access_log`, which are admin-read by
 * policy, so the console runs inside RLS rather than around it.
 */

export interface UnlockResult {
  readonly ok: boolean;
  readonly employee: string;
  readonly wasLockedBecause: string | null;
}

@Injectable()
export class SecurityConsoleService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /** Who is locked out right now, and why. The console's first screen. */
  async lockedAccounts(session: RlsSession) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT u.user_id, u.email, u.role, u.locked_reason,
                e.full_name, e.emp_code,
                (SELECT max(a.occurred_at) FROM audit_log a
                  WHERE a.entity_id = e.employee_id
                    AND a.action = 'ACCOUNT_LOCKED_VELOCITY') AS locked_at
           FROM app_user u
           LEFT JOIN employee e ON e.user_id = u.user_id
          WHERE u.is_locked
          ORDER BY u.email`,
      );
      return rows;
    });
  }

  /**
   * Unlock an account.
   *
   * The reason is mandatory and goes on the audit trail. A lock that can be
   * lifted without saying why turns the velocity control into a formality —
   * whoever investigates the next incident needs to know what was concluded
   * about the last one.
   *
   * Sessions are NOT restored. She signs in again, which is a fresh session with
   * a fresh device binding, and the sign-in itself is logged.
   */
  async unlock(session: RlsSession, userId: string, reason: string): Promise<UnlockResult> {
    const trimmed = reason.trim();
    if (trimmed.length < 10) {
      throw new BadRequestException(
        'Give a reason for the unlock, in a sentence. It goes on the audit trail, and ' +
          'whoever looks at the next incident will need to know what you concluded about this one.',
      );
    }

    return this.read(session, async (client) => {
      const { rows: [before] } = await client.query<{
        email: string; locked_reason: string | null; is_locked: boolean; full_name: string | null;
      }>(
        `SELECT u.email, u.locked_reason, u.is_locked, e.full_name
           FROM app_user u LEFT JOIN employee e ON e.user_id = u.user_id
          WHERE u.user_id = $1`,
        [userId],
      );
      if (!before) throw new BadRequestException('That account was not found.');
      if (!before.is_locked) {
        return { ok: false, employee: before.full_name ?? before.email, wasLockedBecause: null };
      }

      await client.query(
        `UPDATE app_user SET is_locked = false, locked_reason = NULL WHERE user_id = $1`,
        [userId],
      );

      // before_json carries the ORIGINAL lock reason. Clearing the column without
      // recording it first would lose why the account was ever locked.
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id,
                                before_json, after_json)
         VALUES ($1,$2::user_role,'ACCOUNT_UNLOCKED','app_user',$3,$4::jsonb,$5::jsonb)`,
        [
          session.userId, session.role, userId,
          JSON.stringify({ locked_reason: before.locked_reason }),
          JSON.stringify({ unlocked_reason: trimmed }),
        ],
      );

      return {
        ok: true,
        employee: before.full_name ?? before.email,
        wasLockedBecause: before.locked_reason,
      };
    });
  }

  /**
   * Phone numbers viewed and copied. The attribution half of docs/05.
   *
   * Reps see full numbers by design (rule 8), so prevention is unavailable and
   * this log is what remains. Grouped by rep and day, with the copy count
   * separated from the view count — a rep who VIEWS two hundred leads a day is
   * working; a rep who COPIES two hundred is doing something else.
   */
  async accessLog(session: RlsSession, from: string, to: string) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT e.full_name AS rep, p.occurred_at::date AS day,
                count(*) FILTER (WHERE p.action = 'VIEW')::int AS views,
                count(*) FILTER (WHERE p.action = 'COPY')::int AS copies,
                count(DISTINCT p.customer_id)::int              AS distinct_customers,
                count(DISTINCT p.ip_address)::int               AS distinct_addresses
           FROM pii_access_log p
           LEFT JOIN employee e ON e.employee_id = p.employee_id
          WHERE p.occurred_at::date BETWEEN $1::date AND $2::date
          GROUP BY e.full_name, p.occurred_at::date
          ORDER BY count(*) FILTER (WHERE p.action = 'COPY') DESC, e.full_name`,
        [from, to],
      );
      return rows;
    });
  }

  /** Every velocity lock that has fired, and whether it was ever reviewed. */
  async velocityAlerts(session: RlsSession) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT DISTINCT ON (n.slot_key)
                n.slot_key, n.subject, n.body, n.created_at,
                count(*) OVER (PARTITION BY n.slot_key)::int AS admins_notified,
                EXISTS (
                  SELECT 1 FROM audit_log a
                   WHERE a.action = 'ACCOUNT_UNLOCKED'
                     AND a.occurred_at > n.created_at
                ) AS resolved
           FROM notification_outbox n
          WHERE n.kind = 'velocity_lock_alert'
          ORDER BY n.slot_key, n.created_at DESC`,
      );
      return rows;
    });
  }

  /**
   * Who is signed in right now, and from where.
   *
   * docs/05 requires a single active session per EMPLOYEE. Two rows for one rep
   * means that rule is broken, so the console shows the count rather than making
   * an admin count them.
   */
  async activeSessions(session: RlsSession) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT u.email, u.role, e.full_name,
                count(*)::int          AS sessions,
                max(s.last_seen_at)    AS last_seen,
                min(s.issued_at)       AS oldest,
                count(DISTINCT s.ip_address)::int AS addresses
           FROM app_session s
           JOIN app_user u ON u.user_id = s.user_id
           LEFT JOIN employee e ON e.user_id = u.user_id
          -- A live session is one that has not been revoked. There is no
          -- expires_at column; the first version invented one and the endpoint
          -- returned nothing at all while reporting success.
          WHERE s.revoked_at IS NULL
          GROUP BY u.email, u.role, e.full_name
          ORDER BY count(*) DESC, u.email`,
      );
      return rows;
    });
  }

  /** The audit trail, filtered to the actions worth a security conversation. */
  async auditTrail(session: RlsSession, from: string, to: string, action?: string) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT a.occurred_at, a.action, a.actor_role, a.entity_type,
                coalesce(e.full_name, u.email) AS actor,
                a.before_json, a.after_json
           FROM audit_log a
           LEFT JOIN app_user u ON u.user_id = a.actor_id
           LEFT JOIN employee e ON e.user_id = a.actor_id
          WHERE a.occurred_at::date BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR a.action = $3)
          ORDER BY a.occurred_at DESC
          LIMIT 500`,
        [from, to, action ?? null],
      );
      return rows;
    });
  }

  private async read<T>(session: RlsSession, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withRlsContext(this.pool, session, fn);
  }
}
