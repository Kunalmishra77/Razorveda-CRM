-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security — the isolation mechanism (ADR-001, docs/05 section "RLS pattern")
--
-- The API must open every request inside a transaction and run:
--   SET LOCAL app.user_id   = '<uuid>';
--   SET LOCAL app.user_role = 'EMPLOYEE';
--
-- If a developer forgets a WHERE clause, these policies return zero rows
-- instead of another rep's data. Tests for this live in docs/05.
-- ═══════════════════════════════════════════════════════════════════════════

-- The app connects as app_role, which must NOT own any table.
-- Owners bypass RLS unless FORCE ROW LEVEL SECURITY is set, and the Phase 0
-- isolation test is meaningless if run as the owner. See README "RLS caveat".
--
-- On a managed host (Coolify, RDS) the DB user may lack CREATEROLE.
-- If this raises insufficient_privilege, have the host run it as superuser.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE EXCEPTION 'Cannot CREATE ROLE app_role. Run as superuser or ask the DB host to create it. RLS is not optional in this system.';
END $$;
GRANT USAGE ON SCHEMA public TO app_role;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;


CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_employee_id() RETURNS uuid AS $$
  SELECT employee_id FROM employee WHERE user_id = current_user_id();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean AS $$
  SELECT coalesce(current_setting('app.user_role', true), '') IN ('ADMIN','OWNER');
$$ LANGUAGE sql STABLE;

-- ─── lead ─────────────────────────────────────────────────────────────────
ALTER TABLE lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_isolation ON lead FOR ALL TO app_role
  USING (is_admin() OR assigned_to = current_employee_id())
  WITH CHECK (is_admin() OR assigned_to = current_employee_id());

-- ─── customer — visible only if the employee holds a lead or order for them ─
ALTER TABLE customer ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_isolation ON customer FOR ALL TO app_role
  USING (
    is_admin()
    OR EXISTS (SELECT 1 FROM lead l
               WHERE l.customer_id = customer.customer_id
                 AND l.assigned_to = current_employee_id())
    OR customer.owner_employee_id = current_employee_id()
  );

-- ─── order ────────────────────────────────────────────────────────────────
ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
CREATE POLICY order_isolation ON "order" FOR ALL TO app_role
  USING (is_admin() OR booked_by_employee_id = current_employee_id())
  WITH CHECK (is_admin() OR booked_by_employee_id = current_employee_id());

ALTER TABLE order_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_line FORCE ROW LEVEL SECURITY;
CREATE POLICY order_line_isolation ON order_line FOR ALL TO app_role
  USING (is_admin() OR EXISTS (SELECT 1 FROM "order" o
                               WHERE o.order_id = order_line.order_id
                                 AND o.booked_by_employee_id = current_employee_id()));

-- ─── activity ─────────────────────────────────────────────────────────────
ALTER TABLE activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_isolation ON activity FOR ALL TO app_role
  USING (is_admin() OR employee_id = current_employee_id())
  WITH CHECK (is_admin() OR employee_id = current_employee_id());

-- ─── attribution ledger — read own, write admin only ──────────────────────
ALTER TABLE attribution_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_read ON attribution_ledger FOR SELECT TO app_role
  USING (is_admin() OR employee_id = current_employee_id());
CREATE POLICY ledger_write ON attribution_ledger FOR INSERT TO app_role
  WITH CHECK (is_admin());

-- ─── scores — read own ────────────────────────────────────────────────────
ALTER TABLE employee_score_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_score_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY score_read ON employee_score_daily FOR SELECT TO app_role
  USING (is_admin() OR employee_id = current_employee_id());

-- ─── assignment log — read own ────────────────────────────────────────────
ALTER TABLE lead_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_read ON lead_assignment FOR SELECT TO app_role
  USING (is_admin() OR to_employee_id = current_employee_id()
                    OR from_employee_id = current_employee_id());
CREATE POLICY assignment_write ON lead_assignment FOR INSERT TO app_role
  WITH CHECK (is_admin());

-- ─── admin-only tables ────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingestion_batch','staging_row','column_mapping_template',
                           'audit_log','pii_access_log','incentive_slab','app_user']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('CREATE POLICY %I_admin_only ON %I FOR ALL TO app_role
                      USING (is_admin()) WITH CHECK (is_admin());', t, t);
  END LOOP;
END $$;

-- Master data: readable by all authenticated users, writable by admins only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_line','sku','lead_source','disposition',
                           'disposition_alias','working_calendar']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY;', t);   -- defect N6
    EXECUTE format('CREATE POLICY %I_read ON %I FOR SELECT TO app_role USING (true);', t, t);
    EXECUTE format('CREATE POLICY %I_write ON %I FOR INSERT TO app_role WITH CHECK (is_admin());', t, t);
    EXECUTE format('CREATE POLICY %I_update ON %I FOR UPDATE TO app_role USING (is_admin());', t, t);
  END LOOP;
END $$;


-- ─── employee: readable, but targets are not everyone's business (defect N6) ──
-- Reps need to see colleague names (transfer notes, ownership labels) but a rep
-- should not read another rep's monthly_target. The API must select the public
-- column set for non-admins; this policy is the backstop.
ALTER TABLE employee ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee FORCE  ROW LEVEL SECURITY;
-- Deliberately uses current_user_id() (a GUC read) and NOT current_employee_id()
-- (which SELECTs from employee). With FORCE RLS on this table, a policy that
-- called current_employee_id() would recurse into itself. Do not "simplify" this.
CREATE POLICY employee_read ON employee FOR SELECT TO app_role
  USING (is_admin() OR user_id = current_user_id() OR status = 'ACTIVE');
CREATE POLICY employee_write ON employee FOR INSERT TO app_role WITH CHECK (is_admin());
CREATE POLICY employee_update ON employee FOR UPDATE TO app_role USING (is_admin());
-- monthly_target is column-level, not row-level, so RLS cannot hide it.
-- v1: the API selects a public column set for non-admins. Enforced in code + tested.
-- If you want hard enforcement, move targets to an admin-only view and revoke the
-- column from app_role. Logged as O-13 — not decided, so not done here.

-- ═══════════════════════════════════════════════════════════════════════════
-- ADDED — defect B1. These three tables were unprotected.
-- customer_identifier holds every phone number in the business; one join
-- through it defeats "no cross-customer search" and "no bulk list view".
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE customer_identifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_identifier FORCE  ROW LEVEL SECURITY;
-- NOTE: uses current_employee_id(), NOT current_setting('app.user_id').
-- app.user_id is an app_user.user_id; lead.assigned_to is an employee.employee_id.
-- They are different UUIDs joined by employee.user_id. Comparing them directly
-- fails closed and hides a rep's own rows. (defect N1)
CREATE POLICY customer_identifier_isolation ON customer_identifier FOR ALL TO app_role
  USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM lead l
      WHERE l.customer_id = customer_identifier.customer_id
        AND l.assigned_to = current_employee_id()
    )
    OR EXISTS (
      SELECT 1 FROM customer c
      WHERE c.customer_id = customer_identifier.customer_id
        AND c.owner_employee_id = current_employee_id()
    )
  )
  WITH CHECK (is_admin());

ALTER TABLE order_status_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_event FORCE  ROW LEVEL SECURITY;
CREATE POLICY order_status_event_isolation ON order_status_event FOR ALL TO app_role
  USING (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM "order" o
      WHERE o.order_id = order_status_event.order_id
        AND o.booked_by_employee_id = current_employee_id()
    )
  )
  WITH CHECK (is_admin());

ALTER TABLE order_credit_split ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_credit_split FORCE  ROW LEVEL SECURITY;
CREATE POLICY order_credit_split_isolation ON order_credit_split FOR ALL TO app_role
  USING (is_admin() OR employee_id = current_employee_id())
  WITH CHECK (is_admin());

-- ═══════════════════════════════════════════════════════════════════════════
-- Grants (defect B3, comment corrected per N5).
-- Honest description: app_role keeps broad SELECT/INSERT/UPDATE. The real
-- narrowing here is REVOKE UPDATE on the six append-only tables (defence in
-- depth beside the triggers) and REVOKE DELETE everywhere. RLS does the row
-- filtering; these grants are the coarse outer boundary, not the fine one.
-- ═══════════════════════════════════════════════════════════════════════════
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_role;
GRANT USAGE ON SCHEMA public TO app_role;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_role;
REVOKE UPDATE ON activity, order_status_event, lead_assignment,
       attribution_ledger, audit_log, pii_access_log FROM app_role;
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;

-- ON ALL TABLES only covers tables that exist right now. Without this, every
-- future migration silently creates a table app_role cannot touch. (defect N5)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS PROOF HARNESS — Phase 0 exit criterion 4 must use this shape.
-- Running the check as the table owner proves nothing.
-- ═══════════════════════════════════════════════════════════════════════════
--   SET ROLE app_role;
--   SET app.user_role = 'EMPLOYEE';
--   SET app.user_id   = '<a real employee uuid>';
--   SELECT count(*) FROM lead;                  -- only that rep's leads
--   SELECT count(*) FROM customer_identifier;   -- only their customers' phones
--   RESET ROLE;
