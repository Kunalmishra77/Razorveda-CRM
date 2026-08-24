/**
 * ONE DEFINITION OF A REP'S NUMBERS, USED BY BOTH SCREENS THAT SHOW THEM.
 *
 * A rep opens /dashboard and sees her calls, connects, orders and delivered
 * value. An admin opens /team/<her> and must see the SAME figures — if the two
 * disagree by one call, the conversation that follows is about the software
 * rather than about the work, and neither number is trustworthy afterwards.
 *
 * The obvious way to build the admin view is to copy the rep's SQL and swap
 * `current_employee_id()` for a parameter. That is exactly how the two drift:
 * someone fixes a half-open range on one screen in March and the other keeps the
 * old one. CLAUDE.md rule 10 is explicit — every metric has exactly one
 * definition — so the SQL lives here once and each caller supplies only the
 * expression that identifies WHOSE numbers these are.
 *
 * `who` is a SQL FRAGMENT, not a value, and the only two callers pass a literal:
 *   - the rep's own screen passes `current_employee_id()`
 *   - the admin screen passes `$1::uuid`
 * Nothing derived from a request may ever reach it. The signature takes a union
 * of exactly those two strings so the type checker refuses anything else, which
 * is a cheaper guarantee than a comment asking people to be careful.
 *
 * Half-open ranges throughout — `occurred_at::date = CURRENT_DATE` cannot use an
 * index and turned a page like this into a scan of every activity row the rep has
 * ever written (D-233).
 */

export type EmployeeExpr = 'current_employee_id()' | '$1::uuid';

/** Today, and everything still open. */
export const todaySql = (who: EmployeeExpr): string => `
  SELECT
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who}
        AND assigned_at >= CURRENT_DATE AND assigned_at < CURRENT_DATE + 1) AS assigned_today,
    (SELECT count(DISTINCT lead_id)::text FROM activity
      WHERE employee_id = ${who}
        AND occurred_at >= CURRENT_DATE AND occurred_at < CURRENT_DATE + 1) AS worked_today,
    (SELECT count(*)::text FROM activity
      WHERE employee_id = ${who} AND connected
        AND occurred_at >= CURRENT_DATE AND occurred_at < CURRENT_DATE + 1) AS connected_today,
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who} AND closed_at IS NULL
        AND NOT is_converted AND contact_attempts = 0) AS pending,
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who} AND closed_at IS NULL
        AND next_followup_at >= CURRENT_DATE
        AND next_followup_at < CURRENT_DATE + 1) AS followups_due,
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who} AND closed_at IS NULL
        AND next_followup_at < CURRENT_DATE) AS overdue,
    (SELECT count(*)::text FROM customer
      WHERE owner_employee_id = ${who}
        AND next_due_date IS NOT NULL AND next_due_date <= CURRENT_DATE) AS repeat_due,
    -- 48 hours untouched. At 72 the lead returns to the pool automatically, so
    -- this is the warning that can still be acted on.
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who} AND closed_at IS NULL
        AND NOT is_converted AND contact_attempts = 0
        AND assigned_at <= now() - interval '48 hours') AS at_risk,
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who} AND closed_at IS NULL
        AND NOT is_converted) AS open_total,
    -- The actual queue: open, and not parked for a later date. A lead deliberately
    -- pushed to next Tuesday is not work owed today (D-310).
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who} AND closed_at IS NULL
        AND NOT is_converted
        AND (next_followup_at IS NULL OR next_followup_at < CURRENT_DATE + 1)) AS to_call`;

/** Lifetime: previously assigned, previously worked, total ever. */
export const lifetimeSql = (who: EmployeeExpr): string => `
  SELECT
    (SELECT count(*)::text FROM lead WHERE assigned_to = ${who}) AS total_assigned,
    (SELECT count(DISTINCT lead_id)::text FROM activity
      WHERE employee_id = ${who}) AS total_worked,
    (SELECT count(*)::text FROM activity WHERE employee_id = ${who}) AS total_calls,
    (SELECT count(*)::text FROM activity
      WHERE employee_id = ${who} AND connected) AS total_connected,
    (SELECT count(*)::text FROM "order"
      WHERE booked_by_employee_id = ${who}) AS total_orders,
    (SELECT count(*)::text FROM "order"
      WHERE booked_by_employee_id = ${who}
        AND current_status = 'DELIVERED') AS delivered,
    (SELECT count(*)::text FROM "order"
      WHERE booked_by_employee_id = ${who}
        AND current_status IN ('RTO','RETURNED')) AS rto,
    (SELECT coalesce(sum(final_value),0)::text FROM "order"
      WHERE booked_by_employee_id = ${who}
        AND current_status = 'DELIVERED') AS delivered_value,
    (SELECT count(*)::text FROM lead
      WHERE assigned_to = ${who} AND closed_at IS NOT NULL) AS closed`;

/** Today / week / month / all time, in one pass. */
export const periodsSql = (who: EmployeeExpr): string => `
  WITH bounds AS (
    SELECT 'today' AS period, CURRENT_DATE AS f, CURRENT_DATE + 1 AS t
    UNION ALL SELECT 'week',  date_trunc('week', CURRENT_DATE)::date,  CURRENT_DATE + 1
    UNION ALL SELECT 'month', date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE + 1
    UNION ALL SELECT 'all',   '2000-01-01'::date,                      CURRENT_DATE + 1
  )
  SELECT b.period,
    -- The DENOMINATOR of Conversion %, and the reason it is here.
    --
    -- Both screens showed a row called "turned into orders" computed as booked
    -- orders over connected calls. That is not a metric in the dictionary — it
    -- was arithmetic invented at the render layer, which rule 10 exists to
    -- forbid — and it read 675% for a rep whose orders arrived by import with no
    -- calls attached. A rate above 100% is the only reason anyone looked, exactly
    -- as with the EES fan-out (D-186).
    --
    -- docs/03 says Conversion % is DELIVERED orders over LEADS ASSIGNED, in both
    -- places it defines it (§2 and §5). Same population, both ends.
    (SELECT count(*)::text FROM lead l
      WHERE l.assigned_to = ${who}
        AND l.assigned_at >= b.f AND l.assigned_at < b.t) AS assigned,
    (SELECT count(*)::text FROM activity a
      WHERE a.employee_id = ${who}
        AND a.occurred_at >= b.f AND a.occurred_at < b.t) AS calls,
    (SELECT count(*)::text FROM activity a
      WHERE a.employee_id = ${who} AND a.connected
        AND a.occurred_at >= b.f AND a.occurred_at < b.t) AS connected,
    (SELECT count(DISTINCT a.lead_id)::text FROM activity a
      WHERE a.employee_id = ${who}
        AND a.occurred_at >= b.f AND a.occurred_at < b.t) AS leads_worked,
    (SELECT count(*)::text FROM "order" o
      WHERE o.booked_by_employee_id = ${who}
        AND o.order_date >= b.f AND o.order_date < b.t) AS orders,
    (SELECT count(*)::text FROM "order" o
      WHERE o.booked_by_employee_id = ${who}
        AND o.current_status = 'DELIVERED'
        AND o.order_date >= b.f AND o.order_date < b.t) AS delivered,
    -- Realised, not booked (CLAUDE.md rule 3).
    (SELECT coalesce(sum(o.final_value),0)::text FROM "order" o
      WHERE o.booked_by_employee_id = ${who}
        AND o.current_status = 'DELIVERED'
        AND o.order_date >= b.f AND o.order_date < b.t) AS delivered_value
  FROM bounds b`;

export interface TodayRow {
  [k: string]: string;
  assigned_today: string; worked_today: string; connected_today: string;
  pending: string; followups_due: string; overdue: string; repeat_due: string;
  at_risk: string; open_total: string; to_call: string;
}

export interface LifetimeRow {
  [k: string]: string;
  total_assigned: string; total_worked: string; total_calls: string;
  total_connected: string; total_orders: string; delivered: string;
  rto: string; delivered_value: string; closed: string;
}

export interface PeriodRow {
  [k: string]: string;
  period: string; assigned: string; calls: string; connected: string; leads_worked: string;
  orders: string; delivered: string; delivered_value: string;
}
