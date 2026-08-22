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
-- A rep may write a ledger row ONLY for herself. Admin-only was too tight: a rep
-- booking an order legitimately creates its provisional BOOKED_CREDIT, and the
-- insert was refused. Crediting anyone else remains impossible, which is the part
-- that matters — nobody can quietly move credit onto another rep's ledger.
CREATE POLICY ledger_write ON attribution_ledger FOR INSERT TO app_role
  WITH CHECK (is_admin() OR employee_id = current_employee_id());

-- ─── scores — read own ────────────────────────────────────────────────────
ALTER TABLE employee_score_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_score_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY score_read ON employee_score_daily FOR SELECT TO app_role
  USING (is_admin() OR employee_id = current_employee_id());
-- The nightly EES run writes a row per rep, so it needs more than SELECT. This
-- table shipped with a read policy and NO write policy at all, which meant the
-- score could never be written by anything — the fifth instance of a read policy
-- without its write half (audit_log, order_status_event, attribution_ledger,
-- app_user were the others). INSERT raises rather than filtering silently, so
-- this one at least announced itself.
--
-- Admin only, and deliberately: a rep who could write `employee_score_daily`
-- could set her own efficiency score.
CREATE POLICY score_write ON employee_score_daily FOR ALL TO app_role
  USING (is_admin()) WITH CHECK (is_admin());

-- ─── notification outbox — read your own, admins read all ─────────────────
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_read ON notification_outbox FOR SELECT TO app_role
  USING (is_admin() OR recipient_id = current_user_id());
-- Writes are admin-only: the scheduler runs as an admin, and a rep who could
-- INSERT here could compose a message that looks like it came from the system.
-- Both halves present from the start -- a read policy without its write half is
-- the single most repeated defect in this codebase (D-160).
CREATE POLICY outbox_write ON notification_outbox FOR ALL TO app_role
  USING (is_admin()) WITH CHECK (is_admin());

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
                           -- Both halves of the incentive scheme. A rep who could
                           -- read the slabs could work out every colleague's
                           -- payable from figures she can already see.
                           'incentive_slab','incentive_modifier','app_user']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('CREATE POLICY %I_admin_only ON %I FOR ALL TO app_role
                      USING (is_admin()) WITH CHECK (is_admin());', t, t);
  END LOOP;
END $$;

-- ─── authentication: the one path that runs with no user context ─────────
--
-- Logging in must read app_user, but app_user is admin-only and a user who is
-- signing in HAS NO ROLE YET. The lookup returned zero rows, so every password
-- looked wrong — including the right one. Found by running it.
--
-- The fix is a narrow SECURITY DEFINER function, NOT opening the table. It runs
-- as its owner, returns only the columns authentication needs, and is the single
-- controlled doorway into a table that holds password hashes. Widening app_user
-- itself would have exposed every hash to any query app_role can make.
CREATE OR REPLACE FUNCTION auth_lookup(p_email text)
RETURNS TABLE (
  user_id       uuid,
  password_hash text,
  role          user_role,
  is_locked     boolean,
  locked_reason text,
  totp_secret   text,
  full_name     text,
  shift_start   text,
  shift_end     text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.user_id, u.password_hash, u.role, u.is_locked, u.locked_reason, u.totp_secret,
         e.full_name, e.shift_start::text, e.shift_end::text
    FROM app_user u
    LEFT JOIN employee e ON e.user_id = u.user_id
   WHERE lower(u.email) = lower(p_email);
$$;
GRANT EXECUTE ON FUNCTION auth_lookup(text) TO app_role;

-- Two-factor enrolment writes to app_user, which is admin-only — and an admin
-- enrolling for the FIRST TIME has no session, so is_admin() is false.
--
-- The failure mode here is worse than a refusal: RLS filters an UPDATE SILENTLY.
-- The statement succeeded, matched zero rows, and the code read that as "this
-- account already has an authenticator". A permissions problem wearing a
-- business-rule message, with nothing in the log. Found by enrolling.
--
-- `totp_secret IS NULL` stays in the WHERE clause so the one-time rule is enforced
-- by the database rather than by the caller, and two concurrent enrolments cannot
-- both win.
CREATE OR REPLACE FUNCTION auth_enrol_totp(p_user_id uuid, p_secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE updated int;
BEGIN
  UPDATE app_user SET totp_secret = p_secret
   WHERE user_id = p_user_id AND totp_secret IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END;
$$;
GRANT EXECUTE ON FUNCTION auth_enrol_totp(uuid, text) TO app_role;

-- Same reason: recording a successful sign-in touches an admin-only table from a
-- context that has no role yet.
CREATE OR REPLACE FUNCTION auth_touch_last_login(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE app_user SET last_login_at = now() WHERE user_id = p_user_id;
$$;
GRANT EXECUTE ON FUNCTION auth_touch_last_login(uuid) TO app_role;

-- Reading back your OWN recent copy events, for the velocity check.
--
-- pii_access_log is deliberately write-open and read-admin-only: reading is the
-- half that protects anything, since the log is a record of who touched whose
-- phone number. But the velocity check runs AS THE REP, in the same request as
-- her copy, and it needs to count her last ninety seconds.
--
-- Without this the check ran, saw zero rows, and never fired — the lock was
-- installed and inert. The comment above pii_access_log's policy warned that an
-- admin-only INSERT "would have silently disabled the copy-velocity lock". It was
-- right about the mechanism and wrong about which half: the INSERT was fixed and
-- the SELECT was what disabled it.
--
-- Scoped to the caller. A rep can count her own events and nobody else's, so this
-- doorway cannot be turned into a way to read a colleague's copy history.
CREATE OR REPLACE FUNCTION security_recent_pii_copies(p_employee_id uuid, p_window_secs int)
RETURNS TABLE (at double precision, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (is_admin() OR p_employee_id = current_employee_id()) THEN
    RAISE EXCEPTION 'security_recent_pii_copies: may only read your own access log';
  END IF;

  RETURN QUERY
    -- extract() returns NUMERIC in Postgres 14+, not double precision. Declaring
    -- the wrong type here raised "structure of query does not match function
    -- result type" -- loudly, for once, which is why it took a minute rather than
    -- a session to find.
    SELECT (extract(epoch FROM p.occurred_at) * 1000)::double precision, p.action::text
      FROM pii_access_log p
     WHERE p.employee_id = p_employee_id
       AND p.occurred_at >= now() - make_interval(secs => p_window_secs);
END;
$$;
GRANT EXECUTE ON FUNCTION security_recent_pii_copies(uuid, int) TO app_role;

-- The copy-velocity lock (docs/05, Phase 5 deliverable 3).
--
-- SECURITY DEFINER because of who is calling it: the rep being locked. She is an
-- EMPLOYEE, so she cannot write app_user (admin-only), cannot write
-- notification_outbox (admin-only, D-182), and must not be able to. The lock has
-- to happen anyway, and it has to happen in the same breath as the copy event
-- that triggered it — a lock that waits for a nightly job is not a lock.
--
-- All three effects in one function so they cannot half-happen: an account locked
-- with live sessions still working, or locked with nobody told, are both worse
-- than not locking.
CREATE OR REPLACE FUNCTION security_lock_account(
  p_employee_id uuid,
  p_reason      text,
  p_alert_body  text
) RETURNS TABLE (locked boolean, sessions_revoked int, admins_alerted int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   uuid;
  v_name      text;
  v_sessions  int := 0;
  v_admins    int := 0;
  v_slot      text;
BEGIN
  SELECT e.user_id, e.full_name INTO v_user_id, v_name
    FROM employee e WHERE e.employee_id = p_employee_id;
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  -- Already locked: do nothing and say so. Re-locking would spam admins with an
  -- alert per copy for an account that is already stopped.
  IF EXISTS (SELECT 1 FROM app_user WHERE user_id = v_user_id AND is_locked) THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  UPDATE app_user SET is_locked = true, locked_reason = p_reason WHERE user_id = v_user_id;

  -- Revoking the sessions is the half that actually stops her. Without it the
  -- lock only takes effect at her next sign-in, which may be tomorrow.
  --
  -- REVOKED, NOT DELETED. The first version deleted the rows, which worked only
  -- because SECURITY DEFINER runs as the owner: app_role has INSERT, SELECT and
  -- UPDATE on app_session and deliberately no DELETE. It also destroyed the
  -- session history — where she was signed in from, and for how long — which is
  -- exactly what an admin needs when deciding whether the lock was fair.
  UPDATE app_session
     SET revoked_at = now(), revoked_reason = 'Copy-velocity lock'
   WHERE user_id = v_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  -- One slot per lock event, so a later lock of the same account alerts again.
  v_slot := p_employee_id::text || ':' || extract(epoch FROM now())::bigint::text;

  INSERT INTO notification_outbox (kind, slot_key, recipient_id, channel, subject, body, status)
  SELECT 'velocity_lock_alert', v_slot, u.user_id, 'IN_APP',
         'Account locked: ' || coalesce(v_name, 'a rep'), p_alert_body, 'PENDING'
    FROM app_user u
   WHERE u.role IN ('ADMIN','OWNER') AND NOT u.is_locked;
  GET DIAGNOSTICS v_admins = ROW_COUNT;

  INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
  VALUES (v_user_id, 'EMPLOYEE', 'ACCOUNT_LOCKED_VELOCITY', 'employee', p_employee_id,
          jsonb_build_object('reason', p_reason, 'sessions_revoked', v_sessions));

  RETURN QUERY SELECT true, v_sessions, v_admins;
END;
$$;
GRANT EXECUTE ON FUNCTION security_lock_account(uuid, text, text) TO app_role;

-- Sessions are created and checked before any user context exists, so they carry
-- their own policy rather than sitting in the admin-only loop. A row holds a
-- refresh token HASH, never the token, so read access buys an attacker nothing —
-- and the API is the only client that can reach this table at all.
ALTER TABLE app_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_session FORCE  ROW LEVEL SECURITY;
CREATE POLICY app_session_all ON app_session FOR ALL TO app_role
  USING (true) WITH CHECK (true);

-- ─── append-only logs: READ is admin-only, WRITE is open ──────────────────
--
-- These were in the admin-only loop above, and that was wrong in two ways that
-- only showed up when the code ran.
--
--   audit_log      a LOGIN ATTEMPT has no session yet, so is_admin() is false and
--                  the attempt could not be recorded. An audit log that refuses
--                  the writes it exists to capture is not an audit log — and a
--                  FAILED login by an unknown address is exactly the row you most
--                  want kept.
--
--   pii_access_log docs/05 requires every copy-number action to write a row, and
--                  the people copying numbers are REPS. Admin-only INSERT would
--                  have silently disabled the copy-velocity lock, which is the
--                  main anti-exfiltration control in the system.
--
-- Reading stays admin-only, which is the half that protects anything. Forging a
-- row is not a practical concern: app_role has no SQL access of its own, and
-- actor_id is set server-side from the session, never from a request body.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['audit_log','pii_access_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY;', t);
    EXECUTE format('CREATE POLICY %I_read  ON %I FOR SELECT TO app_role USING (is_admin());', t, t);
    EXECUTE format('CREATE POLICY %I_write ON %I FOR INSERT TO app_role WITH CHECK (true);', t, t);
  END LOOP;
END $$;

-- Master data: readable by all authenticated users, writable by admins only.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_line','sku','lead_source','disposition',
                           'disposition_alias','working_calendar','seasonality_index']
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
  -- WITH CHECK mirrors USING rather than being admin-only.
  --
  -- It was `is_admin()`, which meant a rep booking an order could not write its
  -- own opening PENDING event — the order insert succeeded and the very next
  -- statement was refused. Found by booking one. A rep can still only write
  -- events for orders SHE booked; she cannot touch anyone else's.
  WITH CHECK (
    is_admin()
    OR EXISTS (
      SELECT 1 FROM "order" o
      WHERE o.order_id = order_status_event.order_id
        AND o.booked_by_employee_id = current_employee_id()
    )
  );

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
