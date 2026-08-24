import { Controller, Get, Inject, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { withRlsContext } from '../db/rls-context.js';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import {
  todaySql, lifetimeSql, periodsSql,
  type TodayRow, type LifetimeRow, type PeriodRow,
} from '../worklist/rep-metrics.sql.js';

/**
 * THE TEAM — seven people, and the admin could not open any of them.
 *
 * Everything about a rep existed somewhere: the roster in Master Data, a row in
 * the Employee Daily Performance report, her leads inside the assignment pool.
 * What did not exist was the question an admin actually asks, which is about a
 * PERSON and not about a table — "how is Divya doing, and what is she sitting
 * on". Answering it meant reading a report, finding her row, then going to a
 * different screen to see her leads, and there was no way at all to see her the
 * way she sees herself.
 *
 * This screen pairs with the transfer tab. Before moving work you want to know
 * who is drowning and who is idle, and afterwards you want to see that it landed.
 *
 * THE NUMBERS ARE THE REP'S OWN. Not recomputed here — `rep-metrics.sql.ts` is
 * the single definition and her dashboard reads the same builders (rule 10). An
 * admin and a rep looking at the same week must not be able to disagree about it.
 *
 * ADMIN ONLY, twice over: `AdminGuard` on the controller, and RLS underneath —
 * a rep's session reaching these queries would return her own rows, not the
 * team's, because `lead_isolation` does not care which endpoint asked.
 */
@Controller('team')
@UseGuards(AdminGuard)
export class TeamController {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /**
   * The roster, with the four numbers that decide who gets the next batch.
   *
   * Deliberately NOT the full metric set: this is a list to scan, and a table
   * with fourteen columns is one nobody reads. Open work, what has gone quiet,
   * today's calls, and the month against target — everything else is one click
   * away on the person.
   */
  @Get()
  async roster(@Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows } = await client.query(
        `SELECT e.employee_id, e.emp_code, e.full_name, e.status::text AS status,
                coalesce(e.monthly_target,0)::text AS monthly_target,
                e.wip_cap,
                (SELECT count(*)::text FROM lead l
                  WHERE l.assigned_to = e.employee_id
                    AND l.closed_at IS NULL AND NOT l.is_converted) AS open_leads,
                -- Never called at all. This is the number that says a rep is
                -- holding work she has not started, which is what an admin
                -- redistributes on.
                (SELECT count(*)::text FROM lead l
                  WHERE l.assigned_to = e.employee_id
                    AND l.closed_at IS NULL AND NOT l.is_converted
                    AND l.contact_attempts = 0) AS never_called,
                (SELECT count(*)::text FROM lead l
                  WHERE l.assigned_to = e.employee_id
                    AND l.closed_at IS NULL AND NOT l.is_converted
                    AND l.contact_attempts = 0
                    AND l.assigned_at <= now() - interval '48 hours') AS at_risk,
                (SELECT count(*)::text FROM lead l
                  WHERE l.assigned_to = e.employee_id AND l.closed_at IS NULL
                    AND l.next_followup_at < CURRENT_DATE) AS overdue,
                (SELECT count(*)::text FROM activity a
                  WHERE a.employee_id = e.employee_id
                    AND a.occurred_at >= CURRENT_DATE
                    AND a.occurred_at < CURRENT_DATE + 1) AS calls_today,
                (SELECT count(*)::text FROM activity a
                  WHERE a.employee_id = e.employee_id AND a.connected
                    AND a.occurred_at >= CURRENT_DATE
                    AND a.occurred_at < CURRENT_DATE + 1) AS connected_today,
                (SELECT coalesce(sum(o.final_value),0)::text FROM "order" o
                  WHERE o.booked_by_employee_id = e.employee_id
                    AND o.current_status = 'DELIVERED'
                    AND o.order_date >= date_trunc('month', CURRENT_DATE)::date
                    AND o.order_date < CURRENT_DATE + 1) AS delivered_month,
                -- When she last did anything at all. A rep who has not logged a
                -- call in four days is a conversation, not a metric, and nothing
                -- in the product said so.
                (SELECT max(a.occurred_at) FROM activity a
                  WHERE a.employee_id = e.employee_id) AS last_activity_at
           FROM employee e
           JOIN app_user u ON u.user_id = e.user_id
          WHERE u.role = 'EMPLOYEE' AND e.status <> 'EXITED'
          ORDER BY e.emp_code`,
      );

      return { ok: true, team: rows };
    });
  }

  /**
   * One rep, as she sees herself, plus the two things only an admin needs: what
   * she is holding right now and what she has recently done.
   */
  @Get(':employeeId')
  async member(@Param('employeeId') employeeId: string, @Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows: [who] } = await client.query<{
        employee_id: string; emp_code: string; full_name: string; status: string;
        monthly_target: string; wip_cap: number; joined_on: string | null; email: string;
      }>(
        `SELECT e.employee_id, e.emp_code, e.full_name, e.status::text AS status,
                coalesce(e.monthly_target,0)::text AS monthly_target, e.wip_cap,
                e.joined_on::text, u.email
           FROM employee e JOIN app_user u ON u.user_id = e.user_id
          WHERE e.employee_id = $1 AND u.role = 'EMPLOYEE'`,
        [employeeId],
      );
      if (!who) throw new NotFoundException('No such rep.');

      const one = async <T extends Record<string, unknown>>(sql: string): Promise<T> =>
        (await client.query<T>(sql, [employeeId])).rows[0] as T;

      // '$1::uuid' is a literal in the union type, not a value from the request —
      // `employeeId` travels as a bind parameter, as it must.
      const today = await one<TodayRow>(todaySql('$1::uuid'));
      const lifetime = await one<LifetimeRow>(lifetimeSql('$1::uuid'));
      const periods = await client.query<PeriodRow>(periodsSql('$1::uuid'), [employeeId]);

      const outcomes = await client.query<{ label: string; category: string; n: string }>(
        `SELECT d.label, d.category::text AS category, count(*)::text AS n
           FROM activity a JOIN disposition d ON d.disposition_id = a.disposition_id
          WHERE a.employee_id = $1
          GROUP BY d.label, d.category ORDER BY count(*) DESC LIMIT 12`,
        [employeeId],
      );

      const sources = await client.query<{ source: string; n: string; open: string }>(
        `SELECT s.display_name AS source, count(*)::text AS n,
                count(*) FILTER (WHERE l.closed_at IS NULL AND NOT l.is_converted)::text AS open
           FROM lead l JOIN lead_source s ON s.source_id = l.source_id
          WHERE l.assigned_to = $1
          GROUP BY s.display_name ORDER BY count(*) DESC`,
        [employeeId],
      );

      const daily = await client.query<{ day: string; calls: string; orders: string }>(
        `SELECT to_char(d.day,'DD Mon') AS day,
                (SELECT count(*)::text FROM activity a
                  WHERE a.employee_id = $1
                    AND a.occurred_at >= d.day AND a.occurred_at < d.day + 1) AS calls,
                (SELECT count(*)::text FROM "order" o
                  WHERE o.booked_by_employee_id = $1
                    AND o.order_date = d.day) AS orders
           FROM (SELECT generate_series(CURRENT_DATE - 13, CURRENT_DATE,
                                        interval '1 day')::date AS day) d
          ORDER BY d.day`,
        [employeeId],
      );

      // Capped, and the total comes from its own COUNT above (`lifetime`), never
      // from this array's length. Same defect five times now (D-231, D-291, D-302).
      const recent = await client.query(
        `SELECT a.occurred_at, a.type::text AS type, a.connected, a.remark_raw,
                d.label AS disposition, c.full_name, l.lead_id
           FROM activity a
           JOIN lead l ON l.lead_id = a.lead_id
           JOIN customer c ON c.customer_id = a.customer_id
           LEFT JOIN disposition d ON d.disposition_id = a.disposition_id
          WHERE a.employee_id = $1
          ORDER BY a.occurred_at DESC LIMIT 20`,
        [employeeId],
      );

      // The assignment history for her — who gave her what, and what was taken
      // away and why. This is the table the transfer feature finally writes into,
      // and the answer to "why is this on Nikita's list?".
      const movements = await client.query(
        `SELECT la.assigned_at, la.method::text AS method, la.reason,
                ef.full_name AS from_rep, et.full_name AS to_rep,
                c.full_name AS customer
           FROM lead_assignment la
           JOIN lead l ON l.lead_id = la.lead_id
           JOIN customer c ON c.customer_id = l.customer_id
           LEFT JOIN employee ef ON ef.employee_id = la.from_employee_id
           LEFT JOIN employee et ON et.employee_id = la.to_employee_id
          WHERE (la.from_employee_id = $1 OR la.to_employee_id = $1)
            AND la.method IN ('TRANSFER','RECALL')
          ORDER BY la.assigned_at DESC LIMIT 20`,
        [employeeId],
      );

      return {
        ok: true,
        rep: who,
        today,
        lifetime,
        periods: Object.fromEntries(periods.rows.map((r) => [r.period, r])),
        outcomes: outcomes.rows,
        sources: sources.rows,
        daily: daily.rows,
        recent: recent.rows,
        movements: movements.rows,
      };
    });
  }
}
