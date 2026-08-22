import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * Offboarding (Phase 5 deliverable 6).
 *
 * "Revoke, bulk-return leads with handover note, preserve 30-day access history."
 *
 * THE EMPLOYEE ROW IS NEVER DELETED, AND THAT IS THE WHOLE DESIGN.
 *
 * Every order she booked references her. Every ledger entry credits her. Every
 * activity row and every assignment names her. Deleting the employee would either
 * fail on the foreign keys or, worse, cascade — and take a year of attribution
 * with it. A March report has to be reproducible in December whether or not the
 * rep who made those sales still works here.
 *
 * So offboarding removes ACCESS and reassigns WORK. It never removes history.
 *
 * "Preserve 30-day access history" is therefore satisfied by construction rather
 * than by a retention job: `pii_access_log` and `audit_log` are append-only, so
 * her record survives indefinitely. The requirement is a floor, not a ceiling,
 * and nothing here deletes anything.
 */

export interface OffboardResult {
  readonly employee: string;
  readonly sessionsRevoked: number;
  readonly leadsReturned: number;
  readonly openOrders: number;
  readonly customersReleased: number;
  readonly warnings: readonly string[];
}

@Injectable()
export class OffboardingService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  async offboard(
    session: RlsSession,
    employeeId: string,
    handoverNote: string,
  ): Promise<OffboardResult> {
    const note = handoverNote.trim();
    if (note.length < 10) {
      throw new BadRequestException(
        'Write a handover note. It goes on every lead this rep is holding, and the person ' +
          'who picks them up will read it before their first call.',
      );
    }

    return withRlsContext(this.pool, session, async (client) => {
      const { rows: [employee] } = await client.query<{
        full_name: string; status: string; user_id: string | null;
      }>(
        `SELECT full_name, status::text, user_id FROM employee WHERE employee_id = $1`,
        [employeeId],
      );
      if (!employee) throw new BadRequestException('That employee was not found.');
      if (employee.status === 'EXITED') {
        throw new BadRequestException(`${employee.full_name} has already been offboarded.`);
      }

      const warnings: string[] = [];

      // ── 1. cut off access ──────────────────────────────────────────────────
      let sessionsRevoked = 0;
      if (employee.user_id) {
        const revoked = await client.query(`DELETE FROM app_session WHERE user_id = $1`, [
          employee.user_id,
        ]);
        sessionsRevoked = revoked.rowCount ?? 0;

        // Locked as well as session-revoked. Revoking alone leaves her able to
        // sign in again with a password she still knows.
        await client.query(
          `UPDATE app_user SET is_locked = true, locked_reason = $2 WHERE user_id = $1`,
          [employee.user_id, `Offboarded on ${new Date().toISOString().slice(0, 10)}.`],
        );
      } else {
        warnings.push(
          `${employee.full_name} has no login account, so there was no access to revoke. ` +
            `Her leads and history were still handled.`,
        );
      }

      // ── 2. return her live leads to the pool ───────────────────────────────
      //
      // To the POOL, not to another named rep. D-02 removed auto-assignment at
      // the client's request: who picks these up is an admin's decision, made
      // with the handover note in front of them.
      const { rows: returned } = await client.query<{ lead_id: string }>(
        `UPDATE lead
            SET assigned_to = NULL, assigned_at = NULL, updated_at = now()
          WHERE assigned_to = $1 AND NOT is_converted AND closed_at IS NULL
      RETURNING lead_id`,
        [employeeId],
      );

      for (const lead of returned) {
        await client.query(
          `INSERT INTO lead_assignment (lead_id, from_employee_id, to_employee_id,
                                        assigned_by, method, reason)
           VALUES ($1, $2, NULL, $3, 'RECALL', $4)`,
          [lead.lead_id, employeeId, session.userId, `Offboarding handover: ${note}`],
        );
      }

      // ── 3. release the customers she owned ─────────────────────────────────
      //
      // `owner_employee_id` drives the repeat-purchase queue. Left pointing at an
      // exited rep, every reorder due from her customers would land on a list
      // nobody reads — the highest-ROI automation in the build, quietly switched
      // off for a slice of the customer base.
      const released = await client.query(
        `UPDATE customer SET owner_employee_id = NULL, updated_at = now()
          WHERE owner_employee_id = $1`,
        [employeeId],
      );

      // ── 4. what is still open in her name ──────────────────────────────────
      //
      // Reported, never reassigned. Credit belongs to whoever made the sale
      // (rule 3), and moving a pending order onto someone else's ledger would be
      // paying the wrong person. An admin needs to know these exist and chase
      // them; the attribution stays where it is.
      const { rows: [orders] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "order"
          WHERE booked_by_employee_id = $1
            AND current_status NOT IN ('DELIVERED','RTO','RETURNED','CANCELLED')`,
        [employeeId],
      );
      const openOrders = Number(orders?.n ?? '0');
      if (openOrders > 0) {
        warnings.push(
          `${openOrders} order(s) booked by ${employee.full_name} are still in transit. They ` +
            `stay credited to her — credit is earned on delivery and the sale was hers — but ` +
            `nobody is now watching them. Assign someone to chase the courier updates.`,
        );
      }

      // ── 5. mark her exited ─────────────────────────────────────────────────
      await client.query(
        `UPDATE employee SET status = 'EXITED', updated_at = now() WHERE employee_id = $1`,
        [employeeId],
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
         VALUES ($1,$2::user_role,'EMPLOYEE_OFFBOARDED','employee',$3,$4::jsonb)`,
        [
          session.userId, session.role, employeeId,
          JSON.stringify({
            handoverNote: note,
            sessionsRevoked,
            leadsReturned: returned.length,
            customersReleased: released.rowCount ?? 0,
            openOrders,
          }),
        ],
      );

      return {
        employee: employee.full_name,
        sessionsRevoked,
        leadsReturned: returned.length,
        openOrders,
        customersReleased: released.rowCount ?? 0,
        warnings,
      };
    });
  }

  /**
   * What offboarding WOULD do, without doing it.
   *
   * An admin should see the scale before pressing the button — thirty leads going
   * back to a pool nobody is watching on a Friday afternoon is a different
   * decision from three.
   */
  async preview(session: RlsSession, employeeId: string) {
    return withRlsContext(this.pool, session, async (client) => {
      const { rows: [counts] } = await client.query(
        `SELECT e.full_name, e.status::text,
                (SELECT count(*)::int FROM lead
                  WHERE assigned_to = e.employee_id AND NOT is_converted AND closed_at IS NULL)
                  AS live_leads,
                (SELECT count(*)::int FROM customer WHERE owner_employee_id = e.employee_id)
                  AS owned_customers,
                (SELECT count(*)::int FROM "order"
                  WHERE booked_by_employee_id = e.employee_id
                    AND current_status NOT IN ('DELIVERED','RTO','RETURNED','CANCELLED'))
                  AS open_orders,
                (SELECT count(*)::int FROM app_session s
                  WHERE s.user_id = e.user_id AND s.expires_at > now()) AS active_sessions
           FROM employee e WHERE e.employee_id = $1`,
        [employeeId],
      );
      if (!counts) throw new BadRequestException('That employee was not found.');
      return counts;
    });
  }
}
