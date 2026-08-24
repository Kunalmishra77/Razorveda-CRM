import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { EMPLOYEE_MAX_PAGE_SIZE } from '@razorveda/shared';
import { withRlsContext } from '../db/rls-context.js';
import type { AuthedRequest } from '../auth/session.guard.js';

/**
 * A REP'S OWN NUMBERS AND HER OWN LEADS.
 *
 * The client asked for a dashboard that shows more than today: previous
 * assignments, previous completed work, lifetime totals, and daily / weekly /
 * monthly performance. That is a lot of separate questions, and answering each
 * from its own endpoint would mean the dashboard fires eight requests and renders
 * in pieces — which is how the admin Today page ended up looking calm while it
 * was still loading.
 *
 * So it is one endpoint returning one shape, built from a handful of aggregates.
 *
 * EVERYTHING IS SCOPED BY ROW-LEVEL SECURITY, not by a `WHERE assigned_to = me`
 * written here. `current_employee_id()` appears where the query genuinely needs
 * to distinguish "leads assigned to me" from "customers I can see"; the isolation
 * itself is the database's job, so a mistake in this file returns nothing rather
 * than someone else's rows.
 */
@Controller('me')
export class MeController {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /** Everything the dashboard shows, in one round trip. */
  @Get('dashboard')
  async dashboard(@Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const one = async <T extends Record<string, unknown>>(
        sql: string, params: unknown[] = [],
      ): Promise<T> => (await client.query<T>(sql, params)).rows[0] as T;

      /**
       * Today, and the work still open.
       *
       * "Assigned today" counts leads whose assignment happened today — which is
       * what an admin distributing data through the day actually produces. It is
       * not the same as "leads I hold", and conflating the two is how a rep sees
       * 400 when fourteen arrived this morning.
       */
      const today = await one<{
        assigned_today: string; worked_today: string; connected_today: string;
        pending: string; followups_due: string; overdue: string; repeat_due: string;
        at_risk: string; open_total: string; to_call: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id()
               AND assigned_at >= CURRENT_DATE AND assigned_at < CURRENT_DATE + 1) AS assigned_today,
           (SELECT count(DISTINCT lead_id)::text FROM activity
             WHERE employee_id = current_employee_id()
               AND occurred_at >= CURRENT_DATE AND occurred_at < CURRENT_DATE + 1) AS worked_today,
           (SELECT count(*)::text FROM activity
             WHERE employee_id = current_employee_id() AND connected
               AND occurred_at >= CURRENT_DATE AND occurred_at < CURRENT_DATE + 1) AS connected_today,
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id() AND closed_at IS NULL
               AND NOT is_converted AND contact_attempts = 0) AS pending,
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id() AND closed_at IS NULL
               AND next_followup_at >= CURRENT_DATE
               AND next_followup_at < CURRENT_DATE + 1) AS followups_due,
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id() AND closed_at IS NULL
               AND next_followup_at < CURRENT_DATE) AS overdue,
           (SELECT count(*)::text FROM customer
             WHERE owner_employee_id = current_employee_id()
               AND next_due_date IS NOT NULL AND next_due_date <= CURRENT_DATE) AS repeat_due,
           -- 48 hours untouched. At 72 the lead returns to the pool automatically,
           -- so this is the warning she can still act on.
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id() AND closed_at IS NULL
               AND NOT is_converted AND contact_attempts = 0
               AND assigned_at <= now() - interval '48 hours') AS at_risk,
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id() AND closed_at IS NULL
               AND NOT is_converted) AS open_total,
           -- Her actual queue. Open, and not parked for a later date: either she
           -- never set a follow-up, or the one she set has arrived. A lead she
           -- deliberately pushed to next Tuesday is not work she owes today, and
           -- counting it as such is how a rep learns to ignore the number.
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id() AND closed_at IS NULL
               AND NOT is_converted
               AND (next_followup_at IS NULL OR next_followup_at < CURRENT_DATE + 1)) AS to_call`,
      );

      /**
       * Lifetime, and the history the client specifically asked for: previously
       * assigned, previously worked, total ever.
       */
      const lifetime = await one<{
        total_assigned: string; total_worked: string; total_calls: string;
        total_connected: string; total_orders: string; delivered: string;
        rto: string; delivered_value: string; closed: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM lead WHERE assigned_to = current_employee_id()) AS total_assigned,
           (SELECT count(DISTINCT lead_id)::text FROM activity
             WHERE employee_id = current_employee_id()) AS total_worked,
           (SELECT count(*)::text FROM activity WHERE employee_id = current_employee_id()) AS total_calls,
           (SELECT count(*)::text FROM activity
             WHERE employee_id = current_employee_id() AND connected) AS total_connected,
           (SELECT count(*)::text FROM "order"
             WHERE booked_by_employee_id = current_employee_id()) AS total_orders,
           (SELECT count(*)::text FROM "order"
             WHERE booked_by_employee_id = current_employee_id()
               AND current_status = 'DELIVERED') AS delivered,
           (SELECT count(*)::text FROM "order"
             WHERE booked_by_employee_id = current_employee_id()
               AND current_status IN ('RTO','RETURNED')) AS rto,
           (SELECT coalesce(sum(final_value),0)::text FROM "order"
             WHERE booked_by_employee_id = current_employee_id()
               AND current_status = 'DELIVERED') AS delivered_value,
           (SELECT count(*)::text FROM lead
             WHERE assigned_to = current_employee_id() AND closed_at IS NOT NULL) AS closed`,
      );

      /**
       * Day / week / month in one pass.
       *
       * Half-open ranges throughout — `occurred_at::date = CURRENT_DATE` cannot use
       * an index and turned a page like this into a scan of every activity row the
       * rep has ever written (D-233).
       */
      const periods = await client.query<{
        period: string; calls: string; connected: string; leads_worked: string;
        orders: string; delivered: string; delivered_value: string;
      }>(
        `WITH bounds AS (
           SELECT 'today' AS period, CURRENT_DATE AS f, CURRENT_DATE + 1 AS t
           UNION ALL SELECT 'week',  date_trunc('week', CURRENT_DATE)::date,  CURRENT_DATE + 1
           UNION ALL SELECT 'month', date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE + 1
           UNION ALL SELECT 'all',   '2000-01-01'::date,                      CURRENT_DATE + 1
         )
         SELECT b.period,
           (SELECT count(*)::text FROM activity a
             WHERE a.employee_id = current_employee_id()
               AND a.occurred_at >= b.f AND a.occurred_at < b.t) AS calls,
           (SELECT count(*)::text FROM activity a
             WHERE a.employee_id = current_employee_id() AND a.connected
               AND a.occurred_at >= b.f AND a.occurred_at < b.t) AS connected,
           (SELECT count(DISTINCT a.lead_id)::text FROM activity a
             WHERE a.employee_id = current_employee_id()
               AND a.occurred_at >= b.f AND a.occurred_at < b.t) AS leads_worked,
           (SELECT count(*)::text FROM "order" o
             WHERE o.booked_by_employee_id = current_employee_id()
               AND o.order_date >= b.f AND o.order_date < b.t) AS orders,
           (SELECT count(*)::text FROM "order" o
             WHERE o.booked_by_employee_id = current_employee_id()
               AND o.current_status = 'DELIVERED'
               AND o.order_date >= b.f AND o.order_date < b.t) AS delivered,
           (SELECT coalesce(sum(o.final_value),0)::text FROM "order" o
             WHERE o.booked_by_employee_id = current_employee_id()
               AND o.current_status = 'DELIVERED'
               AND o.order_date >= b.f AND o.order_date < b.t) AS delivered_value
         FROM bounds b`,
      );

      /** Where her calls actually went — the outcome mix, her own MIS row. */
      const outcomes = await client.query<{ label: string; category: string; n: string }>(
        `SELECT d.label, d.category::text AS category, count(*)::text AS n
           FROM activity a JOIN disposition d ON d.disposition_id = a.disposition_id
          WHERE a.employee_id = current_employee_id()
          GROUP BY d.label, d.category
          ORDER BY count(*) DESC
          LIMIT 12`,
      );

      /** Where her leads came from — the sources an admin has been giving her. */
      const sources = await client.query<{ source: string; n: string; open: string }>(
        `SELECT s.display_name AS source, count(*)::text AS n,
                count(*) FILTER (WHERE l.closed_at IS NULL AND NOT l.is_converted)::text AS open
           FROM lead l JOIN lead_source s ON s.source_id = l.source_id
          WHERE l.assigned_to = current_employee_id()
          GROUP BY s.display_name ORDER BY count(*) DESC`,
      );

      /** The last fourteen days, for a trend she can see rather than infer. */
      const daily = await client.query<{ day: string; calls: string; orders: string }>(
        `SELECT to_char(d.day,'DD Mon') AS day,
                (SELECT count(*)::text FROM activity a
                  WHERE a.employee_id = current_employee_id()
                    AND a.occurred_at >= d.day AND a.occurred_at < d.day + 1) AS calls,
                (SELECT count(*)::text FROM "order" o
                  WHERE o.booked_by_employee_id = current_employee_id()
                    AND o.order_date = d.day) AS orders
           -- Cast the series, not the comparisons. generate_series with an interval
           -- step yields timestamptz, and there is no timestamptz + integer
           -- operator. Producing a date here keeps day .. day + 1 a half-open date
           -- range and leaves occurred_at uncast, so its index still applies.
           FROM (SELECT generate_series(CURRENT_DATE - 13, CURRENT_DATE,
                                        interval '1 day')::date AS day) d
          ORDER BY d.day`,
      );

      const recent = await client.query({
        text: `SELECT a.occurred_at, a.type::text AS type, a.connected, a.remark_raw,
                      d.label AS disposition, c.full_name, l.lead_id
                 FROM activity a
                 JOIN lead l ON l.lead_id = a.lead_id
                 JOIN customer c ON c.customer_id = a.customer_id
                 LEFT JOIN disposition d ON d.disposition_id = a.disposition_id
                WHERE a.employee_id = current_employee_id()
                ORDER BY a.occurred_at DESC
                LIMIT 12`,
      });

      const target = await one<{ monthly_target: string; full_name: string }>(
        `SELECT coalesce(monthly_target,0)::text AS monthly_target, full_name
           FROM employee WHERE employee_id = current_employee_id()`,
      );

      return {
        ok: true,
        me: { name: target?.full_name ?? '', monthlyTarget: target?.monthly_target ?? '0' },
        today,
        lifetime,
        periods: Object.fromEntries(periods.rows.map((r) => [r.period, r])),
        outcomes: outcomes.rows,
        sources: sources.rows,
        daily: daily.rows,
        recent: recent.rows,
      };
    });
  }

  /**
   * Her work broken down by day, week or month.
   *
   * The client asked for "daily / weekly / monthly performance and overall work
   * history", which is one question asked at three zoom levels — so it is one
   * query with the grain substituted, not three endpoints that could drift apart
   * and disagree about what a call is.
   *
   * The grain is whitelisted, never interpolated from the query string. It lands
   * inside date_trunc, and a value that reached that from the URL would be an
   * injection point on a page a rep opens forty times a day.
   *
   * The row set is driven off a generated calendar, so a week she made no calls
   * appears as a zero rather than vanishing — a gap in a performance table reads
   * as "no data recorded", which is a different and worse claim.
   */
  @Get('performance')
  async performance(@Req() request: AuthedRequest, @Query('grain') grain?: string) {
    const g = grain === 'week' || grain === 'month' ? grain : 'day';
    const spans = { day: 30, week: 12, month: 12 } as const;
    const back = spans[g];

    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows } = await client.query(
        `WITH cal AS (
           SELECT generate_series(
                    date_trunc($1, CURRENT_DATE::timestamp) - ($2::int - 1) * ('1 ' || $1)::interval,
                    date_trunc($1, CURRENT_DATE::timestamp),
                    ('1 ' || $1)::interval)::date AS bucket
         )
         SELECT c.bucket::text AS bucket,
                (SELECT count(*)::text FROM activity a
                  WHERE a.employee_id = current_employee_id()
                    AND a.occurred_at >= c.bucket
                    AND a.occurred_at < (c.bucket + ('1 ' || $1)::interval)) AS calls,
                (SELECT count(*)::text FROM activity a
                  WHERE a.employee_id = current_employee_id() AND a.connected
                    AND a.occurred_at >= c.bucket
                    AND a.occurred_at < (c.bucket + ('1 ' || $1)::interval)) AS connected,
                (SELECT count(DISTINCT a.lead_id)::text FROM activity a
                  WHERE a.employee_id = current_employee_id()
                    AND a.occurred_at >= c.bucket
                    AND a.occurred_at < (c.bucket + ('1 ' || $1)::interval)) AS leads_worked,
                (SELECT count(*)::text FROM lead l
                  WHERE l.assigned_to = current_employee_id()
                    AND l.assigned_at >= c.bucket
                    AND l.assigned_at < (c.bucket + ('1 ' || $1)::interval)) AS assigned,
                (SELECT count(*)::text FROM "order" o
                  WHERE o.booked_by_employee_id = current_employee_id()
                    AND o.order_date >= c.bucket
                    AND o.order_date < (c.bucket + ('1 ' || $1)::interval)) AS orders,
                -- Realised, not booked (CLAUDE.md rule 3). Delivered orders,
                -- counted in the period they were DELIVERED, which is why this
                -- column can exceed the booked column in the same row.
                (SELECT count(*)::text FROM "order" o
                  WHERE o.booked_by_employee_id = current_employee_id()
                    AND o.current_status = 'DELIVERED'
                    AND o.order_date >= c.bucket
                    AND o.order_date < (c.bucket + ('1 ' || $1)::interval)) AS delivered,
                (SELECT coalesce(sum(o.final_value),0)::text FROM "order" o
                  WHERE o.booked_by_employee_id = current_employee_id()
                    AND o.current_status = 'DELIVERED'
                    AND o.order_date >= c.bucket
                    AND o.order_date < (c.bucket + ('1 ' || $1)::interval)) AS delivered_value
           FROM cal c
          ORDER BY c.bucket DESC`,
        [g, back],
      );

      return { ok: true, grain: g, rows };
    });
  }

  /**
   * Her assigned leads, filtered.
   *
   * CAPPED, and the count is separate. A rep in this client's data can hold
   * hundreds of leads; returning all of them with names and full phone numbers so
   * a table can show a total is the defect this project has now fixed three times
   * (D-231, D-291, D-302).
   */
  @Get('leads')
  async leads(
    @Req() request: AuthedRequest,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
    @Query('temperature') temperature?: string,
  ) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const params: unknown[] = [];
      const where = ['l.assigned_to = current_employee_id()'];

      // `status` is a working band, not a disposition — a rep thinks "who have I
      // not called" rather than "whose current_disposition_id is null".
      if (status === 'new') where.push('l.contact_attempts = 0 AND l.closed_at IS NULL');
      else if (status === 'working') where.push('l.contact_attempts > 0 AND l.closed_at IS NULL AND NOT l.is_converted');
      else if (status === 'followup') where.push('l.next_followup_at IS NOT NULL AND l.closed_at IS NULL');
      else if (status === 'overdue') where.push('l.next_followup_at < CURRENT_DATE AND l.closed_at IS NULL');
      else if (status === 'converted') where.push('l.is_converted');
      else if (status === 'closed') where.push('l.closed_at IS NOT NULL');
      else where.push('true');

      if (source) { params.push(source); where.push(`s.code = $${params.length}`); }
      if (temperature) { params.push(temperature); where.push(`l.temperature = $${params.length}::lead_temperature`); }
      if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        where.push(`(c.full_name ILIKE $${params.length} OR c.primary_phone LIKE $${params.length})`);
      }
      const clause = where.join(' AND ');

      const { rows: [total] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM lead l
           JOIN customer c ON c.customer_id = l.customer_id
           JOIN lead_source s ON s.source_id = l.source_id
          WHERE ${clause}`,
        params,
      );

      const { rows } = await client.query(
        `SELECT l.lead_id, l.contact_attempts, l.ever_connected, l.next_followup_at,
                l.temperature::text AS temperature, l.is_converted, l.closed_at,
                l.product_interest, l.assigned_at, l.predicted_value::text,
                c.full_name, c.primary_phone, c.city, c.lifetime_orders,
                s.display_name AS source, s.code AS source_code,
                d.label AS disposition, d.category::text AS disposition_category,
                (SELECT a.remark_raw FROM activity a
                  WHERE a.lead_id = l.lead_id AND a.remark_raw IS NOT NULL
                  ORDER BY a.occurred_at DESC LIMIT 1) AS last_remark,
                (SELECT a.occurred_at FROM activity a
                  WHERE a.lead_id = l.lead_id ORDER BY a.occurred_at DESC LIMIT 1) AS last_contact_at
           FROM lead l
           JOIN customer c ON c.customer_id = l.customer_id
           JOIN lead_source s ON s.source_id = l.source_id
           LEFT JOIN disposition d ON d.disposition_id = l.current_disposition_id
          WHERE ${clause}
          ORDER BY
            CASE WHEN l.next_followup_at < CURRENT_DATE THEN 1
                 WHEN l.next_followup_at::date = CURRENT_DATE THEN 2
                 WHEN l.contact_attempts = 0 THEN 3 ELSE 4 END,
            coalesce(l.next_followup_at, l.assigned_at) DESC
          LIMIT ${EMPLOYEE_MAX_PAGE_SIZE}`,
        params,
      );

      return { ok: true, total: Number(total?.n ?? '0'), shown: rows.length, leads: rows };
    });
  }
}
