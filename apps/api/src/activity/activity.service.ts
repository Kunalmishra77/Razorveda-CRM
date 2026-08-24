import type { Pool } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { PII_COPY_VELOCITY_WINDOW_SEC } from '@razorveda/shared';
import { evaluateVelocity, lockAlertBody } from '../security/velocity.js';

export interface PiiAccessResult {
  /** False when RLS did not show the caller that lead — nothing was recorded. */
  readonly logged: boolean;
  readonly locked: boolean;
  readonly recentCopies?: number;
  readonly sessionsRevoked?: number;
  readonly adminsAlerted?: number;
  readonly reason?: string;
}
import {
  applyActivityToLead, storedRemark, validateActivity,
  type ActivityInput, type DispositionRule, type LeadState,
} from './log-activity.js';

/** Thrown for a rule violation the UI should show against a field. */
export class ActivityValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ActivityValidationError';
  }
}

/**
 * Logging a contact attempt (tasks/phase-1 item 4).
 *
 * Exit criterion 4: the API rejects an activity with no disposition, and the UI
 * blocks save. Both, not either — a closed vocabulary enforced only in the browser
 * is a free-text field with a nicer widget, and F4's 49 spellings are what that
 * looks like after four months.
 */
export class ActivityService {
  constructor(private readonly pool: Pool) {}

  async log(session: RlsSession, input: ActivityInput): Promise<{ activityId: string }> {
    return withRlsContext(this.pool, session, async (client) => {
      // Load the disposition rule from the closed master, never trust the client's
      // idea of whether a follow-up is required.
      let disposition: DispositionRule | null = null;
      if (input.dispositionId) {
        const { rows } = await client.query<{
          disposition_id: string;
          code: string;
          requires_followup_date: boolean;
          counts_as_connect: boolean;
          is_terminal: boolean;
        }>(
          `SELECT disposition_id, code, requires_followup_date, counts_as_connect, is_terminal
             FROM disposition WHERE disposition_id = $1`,
          [input.dispositionId],
        );
        const row = rows[0];
        if (row) {
          disposition = {
            dispositionId: row.disposition_id,
            code: row.code,
            requiresFollowupDate: row.requires_followup_date,
            countsAsConnect: row.counts_as_connect,
            isTerminal: row.is_terminal,
          };
        }
      }

      const check = validateActivity(input, disposition);
      if (!check.ok) throw new ActivityValidationError(check.field, check.message);

      // RLS decides whether this lead is visible at all. A rep who forges another
      // rep's lead id gets zero rows here, not a permissions message — which is
      // also why the API returns 404 rather than 403 (docs/05 test 1).
      const { rows: leadRows } = await client.query<{
        lead_id: string;
        customer_id: string;
        contact_attempts: number;
        ever_connected: boolean;
        first_contact_at: string | null;
        first_connected_at: string | null;
        last_contact_at: string | null;
        next_followup_at: string | null;
        current_disposition_id: string | null;
        closed_at: string | null;
      }>(
        `SELECT lead_id, customer_id, contact_attempts, ever_connected, first_contact_at,
                first_connected_at, last_contact_at, next_followup_at,
                current_disposition_id, closed_at
           FROM lead WHERE lead_id = $1`,
        [input.leadId],
      );
      const lead = leadRows[0];
      if (!lead) throw new ActivityValidationError('leadId', 'That lead was not found.');

      const employeeId = await this.currentEmployeeId(client);
      const occurredAt = new Date().toISOString();

      // APPEND ONLY. remark_raw goes in exactly as typed (D-66).
      const { rows: inserted } = await client.query<{ activity_id: string }>(
        `INSERT INTO activity (lead_id, customer_id, employee_id, type, connected,
                               disposition_id, remark_raw, occurred_at)
         VALUES ($1,$2,$3,$4::activity_type,$5,$6,$7,$8)
      RETURNING activity_id`,
        [
          input.leadId, lead.customer_id, employeeId, input.type,
          input.connected, input.dispositionId, storedRemark(input.remarkRaw), occurredAt,
        ],
      );

      const current: LeadState = {
        contactAttempts: lead.contact_attempts,
        everConnected: lead.ever_connected,
        firstContactAt: lead.first_contact_at,
        firstConnectedAt: lead.first_connected_at,
        lastContactAt: lead.last_contact_at,
        nextFollowupAt: lead.next_followup_at,
        currentDispositionId: lead.current_disposition_id,
        closedAt: lead.closed_at,
      };
      const next = applyActivityToLead(current, input, disposition, occurredAt);

      // `lead` is mutable state derived from the append-only activity log, so it
      // can be rebuilt from history if it ever disagrees.
      await client.query(
        // `temperature` is coalesced, not overwritten: a rep who logs a
        // not-connected attempt without touching the Hot/Warm/Cold control must
        // not silently downgrade a lead she marked Hot yesterday.
        `UPDATE lead SET contact_attempts = $2, ever_connected = $3, first_contact_at = $4,
                         first_connected_at = $5, last_contact_at = $6, next_followup_at = $7,
                         current_disposition_id = $8, closed_at = $9,
                         temperature = coalesce($10::lead_temperature, temperature),
                         updated_at = now()
          WHERE lead_id = $1`,
        [
          input.leadId, next.contactAttempts, next.everConnected, next.firstContactAt,
          next.firstConnectedAt, next.lastContactAt, next.nextFollowupAt,
          next.currentDispositionId, next.closedAt, input.temperature ?? null,
        ],
      );

      return { activityId: (inserted[0] as { activity_id: string }).activity_id };
    });
  }

  /**
   * Records a phone-number view or copy (docs/05).
   *
   * Reps dial from their own handsets, so they must see the number. What remains
   * is detection and attribution, not prevention — and this is the row that makes
   * attribution possible. The velocity lock in Phase 5 reads it.
   */
  /**
   * Record a phone number being viewed or copied, and check the velocity rule.
   *
   * The check runs in the SAME call as the write, not on a schedule. A lock that
   * arrives tomorrow morning is not a lock — by then the numbers are gone.
   */
  async logPiiAccess(
    session: RlsSession,
    leadId: string | null,
    action: 'VIEW' | 'COPY',
    ipAddress: string | null,
    /**
     * For a Customer 360 view, which reveals a phone number with no lead in
     * front of it. Exactly one of `leadId` and `customerId` is expected.
     */
    customerId?: string,
  ): Promise<PiiAccessResult> {
    return withRlsContext(this.pool, session, async (client) => {
      const employeeId = await this.currentEmployeeId(client);
      const { rowCount } = leadId
        ? await client.query(
            `INSERT INTO pii_access_log (employee_id, lead_id, customer_id, action, ip_address)
             SELECT $1, l.lead_id, l.customer_id, $3, $4::inet FROM lead l WHERE l.lead_id = $2`,
            [employeeId, leadId, action, ipAddress],
          )
        : await client.query(
            // SELECT from customer rather than a bare VALUES, so RLS still decides.
            // A caller who cannot see the customer logs nothing, which keeps the
            // access log a record of what was SEEN rather than what was requested.
            `INSERT INTO pii_access_log (employee_id, lead_id, customer_id, action, ip_address)
             SELECT $1, NULL, c.customer_id, $3, $4::inet FROM customer c WHERE c.customer_id = $2`,
            [employeeId, customerId ?? null, action, ipAddress],
          );

      // No row means RLS did not show her that lead. Nothing was logged, so there
      // is nothing to evaluate — and saying so beats reporting a successful log.
      if (!rowCount || !employeeId) return { logged: false, locked: false };

      // A VIEW is a rep looking at the lead she is about to call. Only a COPY —
      // the number leaving the application — counts toward the lock.
      if (action !== 'COPY') return { logged: true, locked: false };

      // SECURITY DEFINER, and this is why the lock was inert. pii_access_log is
      // read-admin-only by design, so this SELECT run as the rep returned zero
      // rows and the check never fired. Nothing errored; the control was simply
      // installed and dead. Scoped to the caller inside the function, so it
      // cannot be used to read a colleague's copy history.
      const { rows: events } = await client.query<{ at: string; action: 'VIEW' | 'COPY' }>(
        `SELECT at, action FROM security_recent_pii_copies($1, $2::int)`,
        [employeeId, PII_COPY_VELOCITY_WINDOW_SEC],
      );

      const now = Date.now();
      const decision = evaluateVelocity(
        events.map((e) => ({ at: Number(e.at), action: e.action })),
        now,
      );
      if (!decision.breached) return { logged: true, locked: false, recentCopies: decision.count };

      const { rows: [name] } = await client.query<{ full_name: string }>(
        `SELECT full_name FROM employee WHERE employee_id = $1`,
        [employeeId],
      );

      // SECURITY DEFINER: the caller is the rep being locked. She is an EMPLOYEE,
      // so she cannot write app_user or notification_outbox — and must not be able
      // to. The function does the lock, the session revocation and the admin alert
      // together so they cannot half-happen.
      const { rows: [result] } = await client.query<{
        locked: boolean; sessions_revoked: number; admins_alerted: number;
      }>(
        `SELECT * FROM security_lock_account($1, $2, $3)`,
        [
          employeeId,
          decision.reason,
          lockAlertBody(name?.full_name ?? 'A rep', decision, new Date(now)),
        ],
      );

      return {
        logged: true,
        locked: result?.locked ?? false,
        recentCopies: decision.count,
        sessionsRevoked: result?.sessions_revoked ?? 0,
        adminsAlerted: result?.admins_alerted ?? 0,
        reason: decision.reason,
      };
    });
  }

  private async currentEmployeeId(client: {
    query: (sql: string) => Promise<{ rows: Array<{ employee_id: string | null }> }>;
  }): Promise<string | null> {
    const { rows } = await client.query('SELECT current_employee_id() AS employee_id');
    return rows[0]?.employee_id ?? null;
  }
}
