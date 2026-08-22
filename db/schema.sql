-- ═══════════════════════════════════════════════════════════════════════════
-- Razorveda CRM — PostgreSQL 16 schema
-- Authoritative for v1. Future changes go through Drizzle migrations.
-- Every design choice here traces to docs/08-audit-findings.md.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
-- pgvector REMOVED in v1 (decision D-14). 20 SKUs do not need embeddings;
-- pg_trgm + the alias table is sufficient. Revisit only above ~500 SKUs.

-- ─── ENUMS ────────────────────────────────────────────────────────────────
CREATE TYPE user_role         AS ENUM ('OWNER','ADMIN','EMPLOYEE');
CREATE TYPE employee_status   AS ENUM ('ACTIVE','ON_LEAVE','SUSPENDED','EXITED');
CREATE TYPE customer_type     AS ENUM ('NEW','EXISTING');
CREATE TYPE buyer_stage       AS ENUM ('PROSPECT','FIRST','SECOND','THIRD','REPEAT','LOYAL','DORMANT','CHURNED');
CREATE TYPE identifier_type   AS ENUM ('MOBILE','ALT_MOBILE','WHATSAPP','EMAIL');
CREATE TYPE payment_mode      AS ENUM ('COD','PREPAID','PARTIAL_PREPAID','UNKNOWN');
CREATE TYPE order_status      AS ENUM ('PENDING','CONFIRMED','PROCESSING','DISPATCHED','IN_TRANSIT',
                                       'OFD','DELIVERED','RTO','RETURNED','CANCELLED',
                                       'FAILED_DELIVERY','NO_RESPONSE','REFUSED');
CREATE TYPE attribution_rule  AS ENUM ('FULL_CREDIT','UPSELL_DELTA','SPLIT_PERCENT');
CREATE TYPE ledger_entry_type AS ENUM ('BOOKED_CREDIT','REALISED_CREDIT','CLAWBACK','ADJUSTMENT','MANUAL_OVERRIDE');
CREATE TYPE activity_type     AS ENUM ('CALL','WHATSAPP','SMS','NOTE','STATUS_CHANGE','ORDER','SYSTEM');
CREATE TYPE disposition_cat   AS ENUM ('CONNECTED','NOT_CONNECTED','POSITIVE','NEGATIVE','CLOSED');
CREATE TYPE batch_status      AS ENUM ('UPLOADED','MAPPING','VALIDATING','REVIEW','SHIFTED','COMMITTED','ROLLED_BACK','FAILED');
CREATE TYPE row_status        AS ENUM ('VALID','WARNING','ERROR','DUPLICATE','PARKED');
CREATE TYPE assign_method     AS ENUM ('MANUAL','BULK','TRANSFER','RECALL','SYSTEM');
CREATE TYPE lead_temperature  AS ENUM ('HOT','WARM','COLD');

-- ─── MASTER DATA ──────────────────────────────────────────────────────────
CREATE TABLE product_line (
  line_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sku (
  sku_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku_code            text UNIQUE NOT NULL,
  product_name        text NOT NULL,
  line_id             uuid NOT NULL REFERENCES product_line(line_id),
  variant             text,
  pack_size           text,
  mrp                 numeric(10,2) NOT NULL,
  -- Drives UPSELL_DELTA attribution (F7). The seeded values are REVERSE-ENGINEERED
  -- from the client's order data, not confirmed prices — and this column decides
  -- how much a rep is paid. CLAUDE.md rule 1: never guess a money figure.
  --
  -- So the number and its provenance are separate. The seeded value is a
  -- SUGGESTION shown to the admin; attribution refuses to compute until an admin
  -- confirms it in Master Data. Until then the order lands in the exception queue,
  -- which is the intended workflow, not a defect. (O-02, D-81)
  shopify_base_price            numeric(10,2),
  shopify_base_price_confirmed  boolean NOT NULL DEFAULT false,
  shopify_base_price_set_by     uuid,   -- FK added after app_user exists, below
  shopify_base_price_set_at     timestamptz,
  usage_days          int,                    -- drives the repeat-purchase engine
  name_aliases        text[] DEFAULT '{}',
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  user_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text UNIQUE NOT NULL,
  password_hash  text NOT NULL,
  role           user_role NOT NULL,
  totp_secret    text,
  is_locked      boolean NOT NULL DEFAULT false,
  locked_reason  text,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- sku is declared before app_user (masters are ordered by dependency), so the
-- provenance FK is attached here rather than inline. Found by running it:
-- "relation app_user does not exist".
ALTER TABLE sku
  ADD CONSTRAINT sku_base_price_set_by_fkey
  FOREIGN KEY (shopify_base_price_set_by) REFERENCES app_user(user_id);

-- Server-side sessions. JWTs alone cannot satisfy docs/05, which requires a
-- single active session per employee and immediate revocation — a stateless
-- token cannot be taken back. The access token carries `sid`; this row decides
-- whether that sid is still allowed to act (D-54, D-55).
--
-- The refresh token itself is NEVER stored, only its SHA-256. A dump of this
-- table must not let anyone resume a session.
CREATE TABLE app_session (
  session_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  refresh_token_hash  char(64) NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  revoked_reason      text,
  device_fingerprint  text,
  ip_address          inet
);
CREATE INDEX ix_session_user_active ON app_session(user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX ux_session_refresh ON app_session(refresh_token_hash);

CREATE TABLE employee (
  employee_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid UNIQUE REFERENCES app_user(user_id),
  emp_code         text UNIQUE NOT NULL,
  full_name        text NOT NULL,
  status           employee_status NOT NULL DEFAULT 'ACTIVE',   -- fixes F13
  monthly_target   numeric(12,2) DEFAULT 0,
  wip_cap          int DEFAULT 150,
  shift_start      time DEFAULT '10:00',
  shift_end        time DEFAULT '20:00',
  joined_on        date,
  exited_on        date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_source (
  source_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text UNIQUE NOT NULL,
  display_name             text NOT NULL,
  validity_days            int NOT NULL DEFAULT 7,
  expected_conversion_rate numeric(5,4) DEFAULT 0.10,
  attribution              attribution_rule NOT NULL DEFAULT 'FULL_CREDIT',
  employee_credit_percent  numeric(5,2) NOT NULL DEFAULT 100,
  date_locale              text NOT NULL DEFAULT 'DMY',
  is_active                boolean NOT NULL DEFAULT true
);

CREATE TABLE disposition (
  disposition_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text UNIQUE NOT NULL,
  label                  text NOT NULL,
  category               disposition_cat NOT NULL,
  is_terminal            boolean NOT NULL DEFAULT false,
  requires_followup_date boolean NOT NULL DEFAULT false,
  counts_as_connect      boolean NOT NULL DEFAULT false,
  sort_order             int DEFAULT 0
);

CREATE TABLE disposition_alias (           -- fixes F4: 49 spellings of ~12 outcomes
  alias_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disposition_id uuid NOT NULL REFERENCES disposition(disposition_id),
  alias          text UNIQUE NOT NULL
);

CREATE TABLE working_calendar (
  calendar_date  date PRIMARY KEY,
  is_working_day boolean NOT NULL DEFAULT true,
  -- to_char(date, text) is STABLE, not IMMUTABLE: it depends on DateStyle, so
  -- Postgres rejects it in a generated column ("generation expression is not
  -- immutable"). extract() on a date IS immutable, so the format is built from
  -- immutable parts instead. Same 'YYYY-MM' contract as attribution_ledger.period_key.
  month_key      text GENERATED ALWAYS AS (
                   lpad(extract(year  from calendar_date)::text, 4, '0') || '-' ||
                   lpad(extract(month from calendar_date)::text, 2, '0')
                 ) STORED
);

-- Seasonality multiplier used by the Forecast metric (docs/03 section 3).
-- Seeded 1.0 for all twelve months and flagged provisional: a seasonality index
-- fitted on five months of history (Apr-Aug) would look principled while encoding
-- noise. The TERM stays in the formula and the VALUE is neutralised, because a
-- formula silently missing a term is far harder to find later than one carrying
-- an obvious 1.0. Revisit at 18+ months, or sooner if O-06 releases the 2025
-- archive. Admin-editable data, never a constant in code. (D-44)
CREATE TABLE seasonality_index (
  month_of_year  int PRIMARY KEY CHECK (month_of_year BETWEEN 1 AND 12),
  index_value    numeric(6,4) NOT NULL DEFAULT 1.0000 CHECK (index_value > 0),
  is_provisional boolean NOT NULL DEFAULT true,
  note           text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ─── IDENTITY ─────────────────────────────────────────────────────────────
CREATE TABLE customer (
  customer_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_phone      varchar(15) UNIQUE,          -- business key, NOT the PK (see D-01)
  full_name          text,
  gender             text,
  city               text,
  state              text,
  pincode            varchar(10),
  address_json       jsonb DEFAULT '{}'::jsonb,
  customer_type      customer_type NOT NULL DEFAULT 'NEW',   -- DERIVED, never uploaded
  first_order_date   date,
  last_order_date    date,
  lifetime_orders    int NOT NULL DEFAULT 0,
  lifetime_value     numeric(12,2) NOT NULL DEFAULT 0,
  stage              buyer_stage NOT NULL DEFAULT 'PROSPECT',
  rto_count          int NOT NULL DEFAULT 0,
  rto_risk_score     numeric(4,3),
  owner_employee_id  uuid REFERENCES employee(employee_id),
  owner_expires_at   timestamptz,
  next_due_date      date,
  do_not_call        boolean NOT NULL DEFAULT false,
  merged_into        uuid REFERENCES customer(customer_id),
  -- Provenance, so a rollback can NAME the customers it is leaving behind.
  -- Rollback cannot delete them: a customer created by an import may since have
  -- been called, sold to, or merged, and destroying that is worse than keeping a
  -- row with no live lead or order against it. Before this column they were not
  -- merely unremovable, they were unidentifiable — the admin was told a batch
  -- had been rolled back with no way to see what remained. (D-136)
  ingestion_batch_id uuid,   -- FK attached after ingestion_batch exists, see below
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_identifier (
  identifier_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customer(customer_id) ON DELETE CASCADE,
  type            identifier_type NOT NULL,
  value           varchar(120) NOT NULL,
  is_primary      boolean NOT NULL DEFAULT false,
  confidence      numeric(3,2) NOT NULL DEFAULT 1.00,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_identifier_primary ON customer_identifier(type, value) WHERE is_primary;
CREATE INDEX ix_identifier_lookup ON customer_identifier(type, value);

-- ─── INGESTION ────────────────────────────────────────────────────────────
CREATE TABLE column_mapping_template (
  template_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        uuid NOT NULL REFERENCES lead_source(source_id),
  header_signature char(64) NOT NULL,
  mapping          jsonb NOT NULL,
  confidence       numeric(3,2),
  confirmed_by     uuid REFERENCES app_user(user_id),
  use_count        int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, header_signature)
);

CREATE TABLE ingestion_batch (
  batch_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid NOT NULL REFERENCES lead_source(source_id),
  uploaded_by         uuid NOT NULL REFERENCES app_user(user_id),
  file_name           text NOT NULL,
  file_hash           char(64) NOT NULL,              -- refuses duplicate uploads; see index below
  file_url            text NOT NULL,
  row_count           int DEFAULT 0,
  rows_valid          int DEFAULT 0,
  rows_exception      int DEFAULT 0,
  rows_duplicate      int DEFAULT 0,
  rows_committed      int DEFAULT 0,
  mapping_template_id uuid REFERENCES column_mapping_template(template_id),
  status              batch_status NOT NULL DEFAULT 'UPLOADED',
  shift_detail        jsonb,                          -- populated when status = SHIFTED
  committed_at        timestamptz,
  rolled_back_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- customer is declared long before ingestion_batch, so this provenance FK is
-- attached here rather than inline — the same shape as sku_base_price_set_by
-- above, and the same way it was found: a fresh build said
-- "relation ingestion_batch does not exist".
ALTER TABLE customer
  ADD CONSTRAINT customer_ingestion_batch_fkey
  FOREIGN KEY (ingestion_batch_id) REFERENCES ingestion_batch(batch_id);

-- The duplicate guard is PARTIAL, and deliberately so.
--
-- Its job is to stop the same export being COUNTED TWICE (docs/06 stage 1). A
-- rolled-back batch was un-counted, so re-uploading that file is not a double
-- count — it is the admin taking back a rollback they did by mistake. A plain
-- UNIQUE would have made the duplicate message ("roll back batch X first if you
-- meant to replace it") a lie: rolling back would not have helped, because the
-- hash was still taken. Found by running the rollback path end to end.
CREATE UNIQUE INDEX ux_batch_file_hash_active
  ON ingestion_batch (file_hash) WHERE status <> 'ROLLED_BACK';

CREATE TABLE staging_row (
  staging_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id             uuid NOT NULL REFERENCES ingestion_batch(batch_id) ON DELETE CASCADE,
  row_number           int NOT NULL,
  raw_json             jsonb NOT NULL,
  mapped_json          jsonb,
  normalised_json      jsonb,
  validation_status    row_status NOT NULL DEFAULT 'VALID',
  validation_errors    jsonb DEFAULT '[]'::jsonb,
  resolved_customer_id uuid REFERENCES customer(customer_id),
  resolved_action      text,
  committed_entity_id  uuid
);
CREATE INDEX ix_staging_exceptions ON staging_row(batch_id) WHERE validation_status <> 'VALID';

-- ─── LEAD & ACTIVITY ──────────────────────────────────────────────────────
CREATE TABLE lead (
  lead_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            uuid NOT NULL REFERENCES customer(customer_id),
  source_id              uuid NOT NULL REFERENCES lead_source(source_id),
  ingestion_batch_id     uuid REFERENCES ingestion_batch(batch_id),
  received_at            timestamptz NOT NULL DEFAULT now(),
  valid_till             date,
  predicted_value        numeric(12,2),
  product_interest       text,
  temperature            lead_temperature,
  current_disposition_id uuid REFERENCES disposition(disposition_id),
  assigned_to            uuid REFERENCES employee(employee_id),   -- NULL = unassigned pool
  assigned_at            timestamptz,
  first_contact_at       timestamptz,
  first_connected_at     timestamptz,   -- drives Today's CD (metric 1.6); set on the FIRST activity with connected=true
  last_contact_at        timestamptz,
  contact_attempts       int NOT NULL DEFAULT 0,     -- Fq
  ever_connected         boolean NOT NULL DEFAULT false,  -- CD/ND
  next_followup_at       timestamptz,
  is_converted           boolean NOT NULL DEFAULT false,
  converted_order_id     uuid,
  closed_at              timestamptz,
  close_reason           text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lead_worklist  ON lead(assigned_to, next_followup_at) WHERE NOT is_converted;
CREATE INDEX ix_lead_pool      ON lead(source_id, received_at DESC)   WHERE assigned_to IS NULL;
CREATE INDEX ix_lead_untouched ON lead(assigned_at) WHERE contact_attempts = 0 AND assigned_to IS NOT NULL;

CREATE TABLE lead_assignment (                 -- APPEND ONLY
  assignment_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid NOT NULL REFERENCES lead(lead_id),
  from_employee_id  uuid REFERENCES employee(employee_id),
  to_employee_id    uuid REFERENCES employee(employee_id),
  assigned_by       uuid REFERENCES app_user(user_id),
  method            assign_method NOT NULL,
  reason            text,
  assigned_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity (                        -- APPEND ONLY
  activity_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            uuid REFERENCES lead(lead_id),
  customer_id        uuid NOT NULL REFERENCES customer(customer_id),
  employee_id        uuid REFERENCES employee(employee_id),
  type               activity_type NOT NULL,
  connected          boolean,
  disposition_id     uuid REFERENCES disposition(disposition_id),
  remark_raw         text,                     -- Hinglish, verbatim, never altered
  remark_normalised  text,
  sentiment          text,
  intent_tags        text[] DEFAULT '{}',
  occurred_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_activity_emp_time ON activity USING brin (occurred_at);
CREATE INDEX ix_activity_lead ON activity(lead_id, occurred_at DESC);

-- ─── ORDERS ───────────────────────────────────────────────────────────────
CREATE TABLE "order" (
  order_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number          text UNIQUE NOT NULL,
  customer_id           uuid NOT NULL REFERENCES customer(customer_id),
  lead_id               uuid REFERENCES lead(lead_id),
  source_id             uuid NOT NULL REFERENCES lead_source(source_id),
  booked_by_employee_id uuid REFERENCES employee(employee_id),
  order_date            date NOT NULL DEFAULT CURRENT_DATE,
  dispatch_date         date,
  delivered_date        date,
  rto_date              date,
  gross_value           numeric(12,2) NOT NULL DEFAULT 0,
  discount_value        numeric(12,2) NOT NULL DEFAULT 0,
  final_value           numeric(12,2) NOT NULL,   -- FULL order value. NOT the sheet's "Final amount" -- see docs/06 money mapping
  legacy_credit_value   numeric(12,2),            -- the sheet's "Final amount" = manual credit. Reconciliation only, never computed on.
  company_base_value    numeric(12,2) NOT NULL DEFAULT 0,   -- looked up, never typed (F7)
  coupon_code           text,
  payment_mode          payment_mode NOT NULL DEFAULT 'UNKNOWN',
  prepaid_amount        numeric(12,2) NOT NULL DEFAULT 0,   -- fixes F5
  cod_amount            numeric(12,2) NOT NULL DEFAULT 0,
  prepaid_ratio         numeric(5,4) GENERATED ALWAYS AS
                          (CASE WHEN final_value > 0 THEN prepaid_amount / final_value ELSE 0 END) STORED,
  awb_number            text,
  courier_partner       text,
  current_status        order_status NOT NULL DEFAULT 'PENDING',
  shipping_address_json jsonb DEFAULT '{}'::jsonb,
  ship_state            text,
  ship_pincode          varchar(10),
  rto_predicted_risk    numeric(4,3),
  ingestion_batch_id    uuid REFERENCES ingestion_batch(batch_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_order_delivered ON "order"(delivered_date, source_id) WHERE current_status = 'DELIVERED';
CREATE INDEX ix_order_date ON "order"(order_date);
CREATE INDEX ix_order_geo ON "order"(ship_state, ship_pincode);

CREATE TABLE order_line (                      -- product P&L lives here (F8)
  line_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES "order"(order_id) ON DELETE CASCADE,
  sku_id        uuid NOT NULL REFERENCES sku(sku_id),
  quantity      int NOT NULL DEFAULT 1,
  unit_price    numeric(10,2) NOT NULL,
  line_value    numeric(12,2) NOT NULL,
  is_upsell     boolean NOT NULL DEFAULT false,
  is_free_item  boolean NOT NULL DEFAULT false
);
CREATE INDEX ix_order_line_sku ON order_line(sku_id);

CREATE TABLE order_status_event (              -- APPEND ONLY
  event_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES "order"(order_id),
  from_status        order_status,
  to_status          order_status NOT NULL,
  event_at           timestamptz NOT NULL DEFAULT now(),
  source             text NOT NULL DEFAULT 'MANUAL',
  ingestion_batch_id uuid REFERENCES ingestion_batch(batch_id),
  changed_by         uuid REFERENCES app_user(user_id)
);
CREATE INDEX ix_status_event_order ON order_status_event(order_id, event_at);

CREATE TABLE order_credit_split (               -- handles "Riya / Divya" and "Riya / Shopify"
  split_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES "order"(order_id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employee(employee_id),
  percent      numeric(5,2) NOT NULL
);

-- ─── MONEY ────────────────────────────────────────────────────────────────
CREATE TABLE attribution_ledger (              -- APPEND ONLY. Source of truth for incentive.
  entry_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL REFERENCES "order"(order_id),
  employee_id             uuid NOT NULL REFERENCES employee(employee_id),
  entry_type              ledger_entry_type NOT NULL,
  company_base_value      numeric(12,2) NOT NULL DEFAULT 0,
  employee_credited_value numeric(12,2) NOT NULL DEFAULT 0,
  rule_applied            text NOT NULL,
  rule_version            int NOT NULL DEFAULT 1,
  is_realised             boolean NOT NULL DEFAULT false,
  period_key              text NOT NULL,
  approved_by             uuid REFERENCES app_user(user_id),
  note                    text,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ledger_period ON attribution_ledger(employee_id, period_key, entry_type);

CREATE TABLE incentive_slab (
  slab_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  min_value    numeric(12,2) NOT NULL,
  max_value    numeric(12,2),
  percent      numeric(5,2) NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  -- O-09: the values in docs/03 section 6 are PROPOSALS, not the client's scheme.
  -- The flag travels with the row so every figure computed from it can say so.
  -- An incentive statement that looks authoritative and is not gets paid, and the
  -- correction is a conversation about money that has already been promised.
  is_provisional boolean NOT NULL DEFAULT true
);

-- The four modifiers from docs/03 section 6. In tables, versioned, admin-editable,
-- "never hardcoded" -- so they need somewhere to live rather than constants in a
-- service. One table because they share a shape: a condition, a value, a window.
CREATE TYPE incentive_modifier_kind AS ENUM (
  'DELIVERY_QUALITY',   -- multiplies the payable; RTO% banded
  'PREPAID_BONUS',      -- adds percentage points when prepaid ratio clears a floor
  'PRODUCT_SPIF',       -- adds percentage points on one product line
  'REPEAT_BONUS'        -- flat rupees per qualifying order
);

CREATE TABLE incentive_modifier (
  modifier_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           incentive_modifier_kind NOT NULL,
  -- Inclusive lower bound, exclusive upper, both optional. Holds an RTO band, a
  -- prepaid-ratio floor, or a Buyer Fq threshold depending on kind.
  threshold_min  numeric(10,4),
  threshold_max  numeric(10,4),
  -- Which product line a SPIF applies to. NULL means every line.
  line_id        uuid REFERENCES product_line(line_id),
  -- Multiplier for DELIVERY_QUALITY, percentage points for the bonuses,
  -- rupees for REPEAT_BONUS. The kind decides which, and the engine asserts it.
  value          numeric(10,4) NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  is_provisional boolean NOT NULL DEFAULT true,
  note           text
);
CREATE INDEX ix_modifier_active ON incentive_modifier(kind, effective_from);

CREATE TABLE employee_score_daily (
  employee_id            uuid NOT NULL REFERENCES employee(employee_id),
  score_date             date NOT NULL,
  leads_assigned         int DEFAULT 0,
  leads_touched          int DEFAULT 0,
  leads_untouched        int DEFAULT 0,
  dials                  int DEFAULT 0,
  connects               int DEFAULT 0,
  connectivity_pct       numeric(5,4),
  orders_booked          int DEFAULT 0,
  orders_delivered       int DEFAULT 0,
  orders_rto             int DEFAULT 0,
  booked_value           numeric(12,2) DEFAULT 0,
  realised_value         numeric(12,2) DEFAULT 0,
  credited_value         numeric(12,2) DEFAULT 0,
  realised_credited      numeric(12,2) DEFAULT 0,
  upsell_index           numeric(6,3),
  rto_pct                numeric(5,4),
  conversion_pct         numeric(5,4),
  followup_sla_pct       numeric(5,4),
  data_hygiene_pct       numeric(5,4),
  efficiency_score       numeric(5,2),
  shrinkage_applied      boolean DEFAULT false,
  PRIMARY KEY (employee_id, score_date)
);

-- ─── GOVERNANCE ───────────────────────────────────────────────────────────
CREATE TABLE audit_log (                       -- APPEND ONLY
  log_id      bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES app_user(user_id),
  actor_role  user_role,
  action      text NOT NULL,
  entity_type text,
  entity_id   uuid,
  before_json jsonb,
  after_json  jsonb,
  ip_address  inet,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_time ON audit_log USING brin (occurred_at);

CREATE TABLE pii_access_log (                  -- APPEND ONLY. Copy/view of a phone number.
  access_id   bigserial PRIMARY KEY,
  employee_id uuid REFERENCES employee(employee_id),
  lead_id     uuid REFERENCES lead(lead_id),
  customer_id uuid REFERENCES customer(customer_id),
  action      text NOT NULL,                   -- 'VIEW' | 'COPY'
  ip_address  inet,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_pii_velocity ON pii_access_log(employee_id, occurred_at DESC);

-- ─── APPEND-ONLY ENFORCEMENT ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only. Write a new row instead of % (see CLAUDE.md rule 2).',
    TG_TABLE_NAME, TG_OP;
END; $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['order_status_event','activity','lead_assignment',
                           'attribution_ledger','audit_log','pii_access_log']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION deny_mutation();', t, t);
  END LOOP;
END $$;
