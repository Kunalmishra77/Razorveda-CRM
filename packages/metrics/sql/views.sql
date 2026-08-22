-- ===========================================================================
-- CERTIFIED VIEWS (Phase 4, docs/04 implementation rules)
--
-- "No report computes its own arithmetic. All read certified views."
-- Every number in every report comes from here, so that two reports asking the
-- same question cannot get different answers.
--
-- THE HARD REQUIREMENT IS EXIT CRITERION 2: run the August close pack in
-- December and get identical numbers.
--
-- That rules out `order.current_status`. It is a MUTABLE snapshot of where a
-- parcel is now. An order delivered on 12 August and returned on 3 October has
-- current_status = 'RTO', so a naive August report re-run in December would show
-- it as a return in August — a month in which it was, in fact, delivered. August
-- would silently change every time a later parcel moved.
--
-- So status is derived from `order_status_event`, which is append-only: the
-- status AS OF a date is the last event at or before that date. History cannot
-- be rewritten because the events cannot be rewritten.
--
-- The same reasoning applies to money: realised credit comes from
-- `attribution_ledger` rows stamped with their own period_key, never from a
-- recomputation against today's prices.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Status as of a date, from the append-only event log.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_order_status_daily AS
SELECT o.order_id,
       o.booked_by_employee_id,
       o.lead_id,
       o.customer_id,
       o.source_id,
       o.final_value,
       o.company_base_value,
       o.prepaid_amount,
       o.cod_amount,
       o.ship_state,
       d.day::date                     AS as_of,
       -- The last event at or before `day`. DISTINCT ON with a descending sort
       -- is Postgres's cheapest "latest row per group".
       (SELECT e.to_status
          FROM order_status_event e
         WHERE e.order_id = o.order_id
           AND e.event_at < (d.day + interval '1 day')
         ORDER BY e.event_at DESC, e.event_id DESC
         LIMIT 1)                      AS status_as_of
  FROM "order" o
  CROSS JOIN LATERAL (
    -- Only the days this order could have been in a reportable state: from its
    -- first event to its last. Materialising every order against every calendar
    -- day would be quadratic for no benefit.
    SELECT generate_series(
             (SELECT min(event_at)::date FROM order_status_event WHERE order_id = o.order_id),
             (SELECT max(event_at)::date FROM order_status_event WHERE order_id = o.order_id),
             interval '1 day'
           ) AS day
  ) d;

COMMENT ON VIEW v_order_status_daily IS
  'Order state on each day of its life, from the append-only event log. Never read order.current_status in a report: it is today''s snapshot and would rewrite history.';

-- ---------------------------------------------------------------------------
-- mv_daily_employee_kpi — the Employee Daily Performance report (docs/04).
--
-- Column list is taken verbatim from the spec. Self-reported metrics (dials,
-- connects, connectivity) are named `*_self_reported` so a UI cannot render them
-- without the label docs/04 requires.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_daily_employee_kpi;
CREATE MATERIALIZED VIEW mv_daily_employee_kpi AS
WITH days AS (
  SELECT calendar_date FROM working_calendar
), assigned AS (
  SELECT l.assigned_to AS employee_id, l.assigned_at::date AS day,
         count(*) AS leads_assigned
    FROM lead l
   WHERE l.assigned_to IS NOT NULL AND l.assigned_at IS NOT NULL
   GROUP BY 1, 2
), touched AS (
  SELECT a.employee_id, a.occurred_at::date AS day,
         count(DISTINCT a.lead_id)                                   AS leads_touched,
         count(*) FILTER (WHERE a.type = 'CALL')                     AS dials_self_reported,
         count(*) FILTER (WHERE a.type = 'CALL' AND a.connected)     AS connects_self_reported,
         count(DISTINCT a.lead_id) FILTER (WHERE a.connected)        AS cd,
         count(*) FILTER (WHERE a.disposition_id IS NOT NULL)        AS dispositioned
    FROM activity a
   WHERE a.employee_id IS NOT NULL
   GROUP BY 1, 2
), booked AS (
  SELECT o.booked_by_employee_id AS employee_id, o.order_date AS day,
         count(*)                          AS orders_booked,
         coalesce(sum(o.final_value), 0)   AS booked_value
    FROM "order" o
   WHERE o.booked_by_employee_id IS NOT NULL
   GROUP BY 1, 2
), moved AS (
  -- Deliveries and returns counted on the day the EVENT happened, from the
  -- append-only log. An order that delivers in August and returns in October
  -- contributes to August's delivered count and October's RTO count, for ever.
  SELECT o.booked_by_employee_id AS employee_id, e.event_at::date AS day,
         count(*) FILTER (WHERE e.to_status = 'DELIVERED')                    AS orders_delivered,
         coalesce(sum(o.final_value) FILTER (WHERE e.to_status = 'DELIVERED'), 0) AS realised_value,
         count(*) FILTER (WHERE e.to_status IN ('RTO','RETURNED'))            AS rto_count,
         coalesce(sum(o.final_value) FILTER (WHERE e.to_status IN ('RTO','RETURNED')), 0) AS rto_value,
         count(*) FILTER (WHERE e.to_status = 'DISPATCHED')                   AS orders_dispatched
    FROM order_status_event e
    JOIN "order" o ON o.order_id = e.order_id
   WHERE o.booked_by_employee_id IS NOT NULL
   GROUP BY 1, 2
), credit AS (
  -- Realised credit for the day, from the ledger. Clawbacks are negative, so the
  -- sum is already net.
  SELECT al.employee_id, al.created_at::date AS day,
         coalesce(sum(al.employee_credited_value) FILTER (WHERE al.is_realised), 0) AS credit_earned
    FROM attribution_ledger al
   GROUP BY 1, 2
)
SELECT e.employee_id,
       d.calendar_date                                    AS kpi_date,
       coalesce(a.leads_assigned, 0)                 AS leads_assigned,
       coalesce(t.leads_touched, 0)                  AS leads_touched,
       greatest(coalesce(a.leads_assigned, 0) - coalesce(t.leads_touched, 0), 0) AS leads_untouched,
       coalesce(t.dials_self_reported, 0)            AS dials_self_reported,
       coalesce(t.connects_self_reported, 0)         AS connects_self_reported,
       CASE WHEN coalesce(t.dials_self_reported, 0) > 0
            THEN (t.connects_self_reported::numeric / t.dials_self_reported)
            ELSE NULL END                            AS connectivity_pct_self_reported,
       coalesce(t.cd, 0)                             AS cd,
       greatest(coalesce(a.leads_assigned, 0) - coalesce(t.cd, 0), 0) AS nd,
       coalesce(b.orders_booked, 0)                  AS orders_booked,
       coalesce(b.booked_value, 0)                   AS booked_value,
       coalesce(m.orders_delivered, 0)               AS orders_delivered,
       coalesce(m.realised_value, 0)                 AS realised_value,
       coalesce(m.orders_dispatched, 0)              AS orders_dispatched,
       coalesce(m.rto_count, 0)                      AS rto_count,
       coalesce(m.rto_value, 0)                      AS rto_value,
       CASE WHEN coalesce(m.orders_delivered, 0) + coalesce(m.rto_count, 0) > 0
            THEN (m.rto_count::numeric / (m.orders_delivered + m.rto_count))
            ELSE NULL END                            AS rto_pct,
       CASE WHEN coalesce(m.orders_delivered, 0) > 0
            THEN (m.realised_value / m.orders_delivered)
            ELSE NULL END                            AS aov,
       coalesce(c.credit_earned, 0)                  AS credit_earned,
       coalesce(t.dispositioned, 0)                  AS dispositions_filled
  FROM employee e
  CROSS JOIN days d
  LEFT JOIN assigned a ON a.employee_id = e.employee_id AND a.day = d.calendar_date
  LEFT JOIN touched  t ON t.employee_id = e.employee_id AND t.day = d.calendar_date
  LEFT JOIN booked   b ON b.employee_id = e.employee_id AND b.day = d.calendar_date
  LEFT JOIN moved    m ON m.employee_id = e.employee_id AND m.day = d.calendar_date
  LEFT JOIN credit   c ON c.employee_id = e.employee_id AND c.day = d.calendar_date
 WHERE a.employee_id IS NOT NULL OR t.employee_id IS NOT NULL
    OR b.employee_id IS NOT NULL OR m.employee_id IS NOT NULL
    OR c.employee_id IS NOT NULL;

-- REFRESH ... CONCURRENTLY requires a unique index. Without one the refresh takes
-- an ACCESS EXCLUSIVE lock and every report blocks behind it for the duration.
CREATE UNIQUE INDEX ux_mv_daily_employee_kpi ON mv_daily_employee_kpi (employee_id, kpi_date);
CREATE INDEX ix_mv_daily_employee_kpi_date ON mv_daily_employee_kpi (kpi_date);

-- ---------------------------------------------------------------------------
-- mv_source_funnel_daily — leads by channel, and what became of them.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_source_funnel_daily;
CREATE MATERIALIZED VIEW mv_source_funnel_daily AS
WITH arrived AS (
  SELECT l.source_id, l.received_at::date AS day,
         count(*)                                            AS leads_arrived,
         count(*) FILTER (WHERE l.assigned_to IS NOT NULL)    AS leads_assigned,
         count(*) FILTER (WHERE l.assigned_to IS NULL)        AS leads_unassigned,
         count(*) FILTER (WHERE l.is_converted)               AS leads_converted
    FROM lead l
   GROUP BY 1, 2
), delivered AS (
  SELECT l.source_id, e.event_at::date AS day,
         count(*) FILTER (WHERE e.to_status = 'DELIVERED')                        AS orders_delivered,
         coalesce(sum(o.final_value) FILTER (WHERE e.to_status = 'DELIVERED'), 0) AS realised_value,
         count(*) FILTER (WHERE e.to_status IN ('RTO','RETURNED'))                AS rto_count
    FROM order_status_event e
    JOIN "order" o ON o.order_id = e.order_id
    JOIN lead l ON l.lead_id = o.lead_id
   GROUP BY 1, 2
)
SELECT s.source_id,
       s.code                              AS source_code,
       coalesce(a.day, d.day)              AS funnel_date,
       coalesce(a.leads_arrived, 0)        AS leads_arrived,
       coalesce(a.leads_assigned, 0)       AS leads_assigned,
       coalesce(a.leads_unassigned, 0)     AS leads_unassigned,
       coalesce(a.leads_converted, 0)      AS leads_converted,
       coalesce(d.orders_delivered, 0)     AS orders_delivered,
       coalesce(d.realised_value, 0)       AS realised_value,
       coalesce(d.rto_count, 0)            AS rto_count,
       CASE WHEN coalesce(a.leads_arrived, 0) > 0
            THEN (coalesce(d.orders_delivered, 0)::numeric / a.leads_arrived)
            ELSE NULL END                  AS conversion_pct,
       CASE WHEN coalesce(a.leads_arrived, 0) > 0
            THEN (coalesce(d.realised_value, 0) / a.leads_arrived)
            ELSE NULL END                  AS value_per_lead
  FROM lead_source s
  LEFT JOIN arrived   a ON a.source_id = s.source_id
  FULL OUTER JOIN delivered d ON d.source_id = s.source_id AND d.day = a.day
 WHERE coalesce(a.day, d.day) IS NOT NULL;

CREATE UNIQUE INDEX ux_mv_source_funnel_daily ON mv_source_funnel_daily (source_id, funnel_date);

-- ---------------------------------------------------------------------------
-- mv_product_revenue_daily — what actually sold, by line and SKU.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_product_revenue_daily;
CREATE MATERIALIZED VIEW mv_product_revenue_daily AS
SELECT ol.sku_id,
       sk.sku_code,
       sk.product_name,
       pl.line_id,
       pl.name                                    AS product_line,
       e.event_at::date                           AS revenue_date,
       count(*) FILTER (WHERE e.to_status = 'DELIVERED')                     AS units_delivered,
       coalesce(sum(ol.line_value) FILTER (WHERE e.to_status = 'DELIVERED'), 0) AS realised_value,
       count(*) FILTER (WHERE e.to_status IN ('RTO','RETURNED'))             AS units_returned,
       coalesce(sum(ol.line_value) FILTER (WHERE e.to_status IN ('RTO','RETURNED')), 0) AS returned_value,
       count(*) FILTER (WHERE ol.is_upsell AND e.to_status = 'DELIVERED')    AS upsell_units
  FROM order_status_event e
  JOIN "order" o     ON o.order_id = e.order_id
  JOIN order_line ol ON ol.order_id = o.order_id
  JOIN sku sk        ON sk.sku_id = ol.sku_id
  JOIN product_line pl ON pl.line_id = sk.line_id
 WHERE e.to_status IN ('DELIVERED','RTO','RETURNED')
 GROUP BY ol.sku_id, sk.sku_code, sk.product_name, pl.line_id, pl.name, e.event_at::date;

CREATE UNIQUE INDEX ux_mv_product_revenue_daily ON mv_product_revenue_daily (sku_id, revenue_date);

-- ---------------------------------------------------------------------------
-- mv_rto_analysis — where returns come from, so they can be attacked.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_rto_analysis;
CREATE MATERIALIZED VIEW mv_rto_analysis AS
SELECT e.event_at::date                     AS rto_date,
       o.ship_state,
       o.payment_mode,
       coalesce(o.booked_by_employee_id, '00000000-0000-0000-0000-000000000000'::uuid)
                                            AS booked_by_employee_id,
       count(*)                             AS rto_count,
       coalesce(sum(o.final_value), 0)      AS rto_value,
       -- The prepaid ratio is the strongest RTO predictor available (F5), and it
       -- is only measurable at all because ingestion parses the split.
       avg(o.prepaid_ratio)                 AS avg_prepaid_ratio
  FROM order_status_event e
  JOIN "order" o ON o.order_id = e.order_id
 WHERE e.to_status IN ('RTO','RETURNED')
 GROUP BY 1, 2, 3, 4;

CREATE UNIQUE INDEX ux_mv_rto_analysis
  ON mv_rto_analysis (rto_date, ship_state, payment_mode, booked_by_employee_id);

-- ---------------------------------------------------------------------------
-- mv_geography_performance — where the business actually works.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_geography_performance;
CREATE MATERIALIZED VIEW mv_geography_performance AS
SELECT coalesce(o.ship_state, 'UNKNOWN')    AS ship_state,
       e.event_at::date                     AS perf_date,
       count(*) FILTER (WHERE e.to_status = 'DELIVERED')                     AS orders_delivered,
       coalesce(sum(o.final_value) FILTER (WHERE e.to_status = 'DELIVERED'), 0) AS realised_value,
       count(*) FILTER (WHERE e.to_status IN ('RTO','RETURNED'))             AS rto_count,
       coalesce(sum(o.final_value) FILTER (WHERE e.to_status IN ('RTO','RETURNED')), 0) AS rto_value
  FROM order_status_event e
  JOIN "order" o ON o.order_id = e.order_id
 WHERE e.to_status IN ('DELIVERED','RTO','RETURNED')
 GROUP BY 1, 2;

CREATE UNIQUE INDEX ux_mv_geography_performance ON mv_geography_performance (ship_state, perf_date);

-- ---------------------------------------------------------------------------
-- mv_repeat_due_queue — who is due to reorder, and whose list it belongs on.
--
-- Not historical, so no date grain: it is a worklist, and it is only ever asked
-- about today.
-- ---------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_repeat_due_queue;
CREATE MATERIALIZED VIEW mv_repeat_due_queue AS
SELECT c.customer_id,
       c.full_name,
       c.primary_phone,
       c.owner_employee_id,
       c.next_due_date,
       c.lifetime_orders,
       c.lifetime_value,
       (c.next_due_date - CURRENT_DATE) AS days_until_due
  FROM customer c
 WHERE c.next_due_date IS NOT NULL
   AND NOT c.do_not_call;

CREATE UNIQUE INDEX ux_mv_repeat_due_queue ON mv_repeat_due_queue (customer_id);

-- ===========================================================================
-- ACCESS CONTROL FOR THE MATERIALISED VIEWS
--
-- MATERIALISED VIEWS CANNOT CARRY RLS POLICIES. Postgres allows a policy only on
-- a table, so every matview above is, by itself, a complete bypass of the
-- isolation model — and `ALTER DEFAULT PRIVILEGES` (D-27) helpfully granted
-- app_role SELECT on all of them the moment they were created.
--
-- The effect, verified before this block existed: any signed-in rep could read
-- every colleague's daily KPIs, the full RTO analysis, and — worst — every
-- customer phone number in mv_repeat_due_queue. Rule 5 says a forgotten filter
-- must still return nothing. A matview returns everything.
--
-- So the matviews are revoked from app_role entirely, and each is exposed through
-- a security_barrier view carrying the same predicate its underlying table would
-- have had. A view executes with its OWNER's privileges, so app_role reaches the
-- data only through the filter. `security_barrier` stops a cheap user-supplied
-- function being pushed down below the predicate to leak rows it should not see.
-- ===========================================================================

REVOKE ALL ON mv_daily_employee_kpi, mv_source_funnel_daily, mv_product_revenue_daily,
              mv_rto_analysis, mv_geography_performance, mv_repeat_due_queue
  FROM app_role;

-- A rep sees her own row; an admin sees the team.
CREATE OR REPLACE VIEW v_daily_employee_kpi WITH (security_barrier = true) AS
  SELECT * FROM mv_daily_employee_kpi
   WHERE is_admin() OR employee_id = current_employee_id();

-- Holds primary_phone, so this is the one that matters most.
CREATE OR REPLACE VIEW v_repeat_due_queue WITH (security_barrier = true) AS
  SELECT * FROM mv_repeat_due_queue
   WHERE is_admin() OR owner_employee_id = current_employee_id();

CREATE OR REPLACE VIEW v_rto_analysis WITH (security_barrier = true) AS
  SELECT * FROM mv_rto_analysis
   WHERE is_admin() OR booked_by_employee_id = current_employee_id();

-- Company-wide aggregates with no employee dimension. CLAUDE.md rule 7: all
-- reports live inside ADMIN, and there is no per-rep slice of these to grant.
CREATE OR REPLACE VIEW v_source_funnel_daily WITH (security_barrier = true) AS
  SELECT * FROM mv_source_funnel_daily WHERE is_admin();

CREATE OR REPLACE VIEW v_product_revenue_daily WITH (security_barrier = true) AS
  SELECT * FROM mv_product_revenue_daily WHERE is_admin();

CREATE OR REPLACE VIEW v_geography_performance WITH (security_barrier = true) AS
  SELECT * FROM mv_geography_performance WHERE is_admin();

GRANT SELECT ON v_daily_employee_kpi, v_repeat_due_queue, v_rto_analysis,
                v_source_funnel_daily, v_product_revenue_daily, v_geography_performance
  TO app_role;
