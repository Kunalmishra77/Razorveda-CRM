# Razorveda Internal CRM & MIS Automation Platform
## A-to-Z Architecture, Data Strategy and Implementation Blueprint

**Prepared as:** MIS & Data Management Architecture Review
**Evidence base:** `MIS_Driven_Audit_Sheet-2025.xlsx` (3 tabs, 1,986 formula cells, 9 live IMPORTRANGE links) and `Riya_Chauhan.xlsx` (20 tabs, 2,159 populated customer rows)
**Date:** 20 August 2026
**Status:** Draft v1.0 — for review and sign-off

---

## 0. Executive Summary

You asked for a CRM. What the data actually shows is that **the CRM is the smaller half of the problem.** The larger half is that Razorveda currently has no single, trustworthy definition of a customer, an order, or a salesperson's number — and every report the management team looks at is reconstructed by hand from eleven disconnected spreadsheets.

Three findings frame everything that follows:

1. **There is no customer master.** In one employee's workbook alone, 954 unique mobile numbers appear across 1,627 row-instances — a redundancy factor of **1.71**. 39.3% of customers exist in two or more tabs, one appears in eight. Every tab is a private, divergent copy of the truth.

2. **The MIS spine is structurally fragile.** `MIS_Driven_Audit_Sheet-2025` pulls from nine separate Google Sheets via `IMPORTRANGE`, then the live Scoreboard reads **72 hardcoded cell addresses** (`='Team Audit '!K132`). One inserted row anywhere in any source file silently corrupts the company dashboard with no error and no alert.

3. **Money is being mis-measured, not just mis-reported.** Riya's own tabs contain **₹2,51,698 of Skinwise sales across 116 orders** (Apr–Aug), while the company Achieve Report shows `Skin-wise Revenue = ₹0` for all eleven BDEs. Roughly 16% of her booked value is invisible in the product P&L. Separately, 31% of Shopify upsell rows credit the full order value to the employee instead of only the upsell delta.

The platform described in this document therefore has a specific order of operations: **fix the data model first, automate ingestion second, automate scoring third, and only then automate the reports.** Building dashboards on top of the current data model would industrialise the existing errors.

**Recommended shape:** a single self-hosted PostgreSQL-backed web application (Next.js + NestJS + Redis workers) on a Mumbai VPS, with an upload-driven ingestion engine where **AI proposes the mapping and deterministic SQL does the arithmetic**. No microservices, no Kafka, no Kubernetes. At ~2,000 records/day the data volume is small; the difficulty is entirely in modelling and governance, not scale.

**Timeline:** 26 weeks to full deployment across 6 phases, with the team off Google Sheets by **Week 10**.

---

## 1. Evidence-Based Audit of the Current State

Every finding below is measured from the two files supplied, not inferred.

### 1.1 Data integrity findings

| # | Finding | Evidence | Severity |
|---|---|---|---|
| **F1** | **No customer identity.** Same customer duplicated across tabs with divergent status. | 954 unique mobiles → 1,627 row-instances; 375 customers (39.3%) in >1 tab; max 8 tabs | Critical |
| **F2** | **10.9% of rows are un-keyable.** No valid 10-digit Indian mobile, so they can never be deduplicated or attributed. | 236 of 2,159 rows | Critical |
| **F3** | **Column-shift corruption.** Data has physically slipped columns during copy-paste. | `Order Status` column contains 40+ customer names; `Client Category` contains PIN codes (247232, 440023…); `Data Resource` contains AWB numbers (9544610000000) | Critical |
| **F4** | **Uncontrolled disposition vocabulary.** | `updated user 18 aug.status` has **49 distinct values** for what should be ~12: `ringing` / `rinigng` / `ring` / `ring cut` / `bsy call cut` / `bsy cal cut` / `not connect` / `not connected` | High |
| **F5** | **Payment split is free text.** Prepaid/COD ratio — the single biggest RTO lever in COD ayurveda — cannot be computed. | 121 distinct payment-mode strings: `300 prepaid & 2200 cod`, `849 webpay & 1650 cod`, plus misspellings `preapid`, `prepiad`, `preapaid` | High |
| **F6** | **No schema contract between tabs.** The same field is named differently everywhere, so no formula or script can be reused. | `Number` / `Phone no` / `Phoneno`; `Customer name` / `CustomerName` / `Name`; `Product detail` / `ProductDeatil`; `Amount` / `Total amount`; `Agent` / `Caller name` / `CallerName` / `Agent Name`; `Category` / `Client Category` | High |

### 1.2 Financial and attribution findings

| # | Finding | Evidence | Severity |
|---|---|---|---|
| **F7** | **Upsell attribution leaks 31%.** The Shopify rule (employee credited only with the delta above the Shopify base) is applied manually and inconsistently. | 52 Shopify Upgrade rows with both amounts: 36 split correctly, **16 credit the full value**. Implied base prices cluster tightly at ₹899 / ₹849 / ₹949 — a deterministic rule that should never be manual. | Critical |
| **F8** | **Product P&L is wrong.** | Riya's tabs: Breast Care ₹9,99,802 · Skinwise ₹2,51,698 · Slimming ₹1,46,144 · Intimate ₹1,03,083 · Face ₹27,399 · Customisation ₹26,600 · Hair ₹19,000. Company Achieve Report reports **Skin-wise = ₹0 for every BDE**. | Critical |
| **F9** | **Order count is not a countable fact.** The Achieve Report shows fractional orders — Nikita 73.8, Divya 84.8, Shweta 5.22 — meaning volume is *derived* (value ÷ AOV), not counted from an order ledger. | `Razorveda (No of Orders) = 68.06` | High |
| **F10** | **Booked vs achieved is internally inconsistent.** | Nikita: booked ₹3,70,375 vs achieved ₹1,46,231 (60.5% gap). Divya: booked ₹2,10,638 vs achieved ₹2,16,785 — **achieved exceeds booked**, which is impossible. | High |
| **F11** | **RTO buffer is a hardcoded 15% that ignores actual RTO.** `Required Booking Value = Per Day Req Delivery × 1.15` for every single BDE, verified to 4 decimal places — while actual RTO ranges from 0% to 41%. | Kajal, RTO 41%, is told to book ₹10,511/day. To deliver her balance she actually needs ₹15,491/day — **the target understates her requirement by 47%**. | Critical |
| **F12** | **The same metric disagrees between two tabs of the same MIS pack.** | Nikita's RTO = 0.04 on `Team Audit`, 0.03 on `Achieve Report` | High |

### 1.3 Process and governance findings

| # | Finding | Evidence | Severity |
|---|---|---|---|
| **F13** | **Roster drift — no employee master.** | Brief names 7 employees. `Achieve Report` has 11 rows (adds Puja Singh, Mala, Priyanka, Kajal). `Scoreboard` has 10 (adds Priyanka & Kajal, drops Mala & Puja). Nobody can say who is on the team from the system. | High |
| **F14** | **Brittle dashboard wiring.** 9 `IMPORTRANGE` links + 72 hardcoded cross-sheet cell references. Fails silently, not loudly. | `B2='Team Audit '!K132` | Critical |
| **F15** | **Employees hold the master copy of company data.** Each rep's spreadsheet *is* the record of truth; there is no server-side copy the company controls. Offboarding a rep today means losing or begging for data. | Riya's file contains 4 months of full customer PII including addresses and PIN codes | Critical |
| **F16** | **Forecasting is straight-line extrapolation.** `Approx Guess Rest of Month = Per-day Avg Value × remaining days` — no seasonality, no pipeline weighting, no RTO adjustment. | Verified: 13,293.69 × 12 = 1,59,524.30 | Medium |

### 1.4 What is genuinely good and must be preserved

The current system is not naive. Three concepts in it are more sophisticated than most CRMs and **must survive migration**:

- **CD/ND (Connected Data / Not-connected Data)** as a first-class dialling metric, separate from conversion.
- **Frequency (Fq) / Buyers Fq** — repeat-contact and repeat-purchase counts per customer.
- **Data Given Date / Data Valid Till** — leads have an explicit shelf life and are measured against it. Most CRMs never model lead decay at all.

These become native fields in the new model, not afterthoughts.

---

## 2. Design Principles and Three Necessary Corrections

### 2.1 Principles

1. **One fact, one place, one definition.** Every number in every report resolves to a single row in a single table with a single documented formula.
2. **AI proposes, deterministic code disposes.** The LLM maps columns, normalises Hinglish remarks and resolves product names. It never computes a number. All arithmetic is SQL.
3. **Append-only truth.** Orders, calls, assignments and status changes are immutable events. Corrections are new events, never overwrites. This is what makes a report from March reproducible in December.
4. **Realised, not booked.** Employee score and incentive are earned on **delivery**, not booking. RTO claws back automatically. This single rule fixes F7, F10 and F11 at once.
5. **Build for 5 employees and 3,000 records/day, not for a million users.** Deliberate simplicity. One database, one API, one worker pool.
6. **Everything an admin does by hand today must become either automatic or a two-click exception review.**

### 2.2 Three corrections to the brief

These are places where the stated requirement will not survive contact with production. Flagging now is cheaper than flagging in Week 14.

---

**Correction 1 — Mobile number cannot be the primary key.**

It should be the *unique business identifier*, but not the physical primary key. Reasons, all visible in the data:

- 10.9% of rows have no valid mobile (F2). They still need to exist as records.
- Alternate numbers are already in use (`Alt number` column, populated on ~8% of rows) and sometimes the *alt* number is the real contact.
- Families share numbers. The data shows the same number attached to different customer names.
- People change numbers. If the phone is the PK, a number change orphans the entire order history.
- One row has `Alt number = 9650121669` repeated across multiple unrelated customers — a staff or courier number entered by mistake.

**Design:** surrogate `customer_id` (UUID) as PK. Phone lives in a `customer_identifiers` table (many identifiers → one customer) with `identifier_type`, `is_primary`, `confidence`, `verified_at`. Merge and un-merge are auditable operations. To the user it still behaves exactly as you described — type a number, get the customer — but the system survives number changes, shared numbers and blank numbers.

---

**Correction 2 — Screenshots cannot be blocked in a browser. Something better can be done instead.**

No web application on earth can prevent a screenshot. `PrintScreen`, phone cameras, and OS-level capture are outside the browser's control. Any vendor who promises this is selling you a placebo.

What **actually** protects the asset — a customer's phone number — is making sure the employee never sees the full number in the first place:

- **Server-side number masking + click-to-call.** The rep sees `98••••4312` and a Call button. The dialler (Exotel / Servetel / Knowlarity) connects both legs server-side. The rep completes hundreds of calls per day and never possesses a single complete number. *This is the control. Everything else is a supplement.*
- Click-to-reveal for genuine exceptions, with a per-hour quota, a mandatory reason, and a full reveal audit log.
- Per-session diagonal watermark on every data view: employee name, ID, timestamp, IP. A photographed screen becomes traceable to the person who leaked it.
- Hard caps: 50 rows per page, no bulk list view, no export endpoints, no API tokens for the employee role.
- Reveal-velocity anomaly detection → auto-lock and admin alert.
- Copy/right-click/print-CSS blocking as friction, understood to be friction only.
- If you want true screenshot blocking, it requires a **Windows desktop shell** (Electron with `SetWindowDisplayAffinity`), which is a Phase 6 option — not a browser feature.

Net effect: substantially stronger than "we blocked screenshots," and honest about what it does.

---

**Correction 3 — Pure efficiency-based lead allocation will corrupt its own scoreboard.**

If the highest-scoring rep receives the most and best leads, her score rises because of lead quality, not skill; the gap widens; and within two months the score measures allocation history rather than ability. Juniors never get a fair sample and can never climb. This is a well-known feedback trap and it will happen here.

**Design:** efficiency-weighted allocation with four guardrails —

- **Lead-quality stratification.** Leads are tiered before allocation (source, product, geography, prepaid propensity). Allocation shares apply *within* each tier, so nobody gets a systematically better mix.
- **Floor and cap.** Every active rep receives at least 60% of an equal share; nobody receives more than 180%.
- **Exploration quota.** 10% of high-value leads are round-robined regardless of score. This keeps the comparison statistically valid and is what makes the score defensible in an appraisal conversation.
- **Bayesian shrinkage.** Low-volume reps are pulled toward the team mean, so a rep with 2 orders cannot top the leaderboard on a fluke — exactly the Megha/Puja situation visible in the current Scoreboard.

The engine remains fully configurable, as you asked; these are defaults, not constraints.

---

## 3. Target System Architecture

### 3.1 Logical layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│  L6  PRESENTATION     Admin Portal · Employee Portal · Exec Dashboard   │
│                       Daily WhatsApp/Email digest · Mobile-responsive   │
├─────────────────────────────────────────────────────────────────────────┤
│  L5  INTELLIGENCE     Efficiency Scoring · Assignment Engine            │
│                       RTO Risk Model · Repeat-Purchase Due Engine       │
│                       Next-Best-Product · Campaign ROI · Forecast       │
├─────────────────────────────────────────────────────────────────────────┤
│  L4  SEMANTIC LAYER   Metric Dictionary · Certified Views               │
│                       (single definition of every KPI — Section 4)      │
├─────────────────────────────────────────────────────────────────────────┤
│  L3  CORE DOMAIN      Customer 360 · Order Ledger · Lead Lifecycle      │
│                       Activity Log · Attribution Ledger · Incentives    │
├─────────────────────────────────────────────────────────────────────────┤
│  L2  INGESTION        Upload → Fingerprint → AI Column Map → Validate   │
│                       → Stage → Exception Review → Commit (reversible)  │
├─────────────────────────────────────────────────────────────────────────┤
│  L1  SOURCES          9 upload channels (Shopify, Meta, WhatsApp Web,   │
│                       Add-to-Cart, Call, WA Campaign, Delivered, RTO,   │
│                       NC/Refused)  + manual entry + telephony CDR       │
└─────────────────────────────────────────────────────────────────────────┘
                    ┌──────────────────────────────────────┐
                    │  CROSS-CUTTING: AuthN/AuthZ · RLS ·   │
                    │  Audit Trail · Observability · Backup │
                    └──────────────────────────────────────┘
```

### 3.2 Physical deployment

```
                         Cloudflare (WAF, DDoS, rate limit)
                                      │
                          ┌───────────▼───────────┐
                          │  Nginx / Traefik      │
                          │  TLS termination      │
                          └───────────┬───────────┘
        ┌─────────────────────────────┼─────────────────────────────┐
        │                             │                             │
┌───────▼────────┐          ┌─────────▼────────┐        ┌───────────▼────────┐
│ Next.js 15     │          │ NestJS API       │        │ Worker Pool        │
│ (SSR frontend) │◄────────►│ REST + Zod       │◄──────►│ BullMQ · ingestion │
│                │          │ RBAC + RLS ctx   │        │ scoring · reports  │
└────────────────┘          └─────────┬────────┘        └───────────┬────────┘
                                      │                             │
              ┌───────────────────────┼─────────────────────────────┤
              │                       │                             │
     ┌────────▼────────┐   ┌──────────▼─────────┐      ┌────────────▼───────┐
     │ PostgreSQL 16   │   │ Redis 7            │      │ MinIO / S3         │
     │ OLTP + RLS      │   │ cache · queue      │      │ uploads · exports  │
     │ matviews (MIS)  │   │ session            │      │ call recordings    │
     └────────┬────────┘   └────────────────────┘      └────────────────────┘
              │
     ┌────────▼────────┐   ┌────────────────────┐      ┌────────────────────┐
     │ pgvector        │   │ AI Service (Python)│      │ Telephony (Exotel) │
     │ product/name    │   │ column map · NLP   │      │ masked click-2-call│
     │ resolution      │   │ Hinglish normalise │      │ CDR webhook        │
     └─────────────────┘   └────────────────────┘      └────────────────────┘

Host: Mumbai VPS (8 vCPU / 16 GB / 200 GB NVMe) via Coolify + Docker Compose
DR:   nightly pg_dump + continuous WAL archiving to object storage (separate region)
```

### 3.3 Recommended technology stack

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui, TanStack Table/Query | SSR keeps sensitive rows server-rendered; no client-side data store to scrape |
| API | NestJS (Node 20), REST, Zod validation, OpenAPI | Structured modules map cleanly to the domain; strong DI for the rules engine |
| Database | **PostgreSQL 16**, Row-Level Security | RLS enforces "reps see only their leads" *at the database*, not in application code. This is the single most important stack choice in the document. |
| Cache / Queue | Redis 7 + BullMQ | Ingestion, scoring and report refresh as retryable background jobs |
| Analytics | Postgres materialised views, refreshed on schedule | At ~2,000 rows/day you reach 730K rows/year. Postgres handles this for a decade. **Do not introduce ClickHouse or a warehouse.** Revisit only past 50M rows. |
| Object store | MinIO (self-hosted) or S3 | Raw uploads retained immutably for replay and audit |
| AI | Gemini Flash / Claude Haiku via API, + pgvector embeddings | Column mapping, Hinglish remark normalisation, SKU resolution. Cheap, cached, non-critical-path |
| Telephony | Exotel / Servetel / Knowlarity | Number masking, click-to-call, recording, auto-CDR → activity log |
| Auth | JWT + rotating refresh, TOTP 2FA for admins, device+IP session binding | |
| Deploy | Docker Compose on Coolify | Matches existing infrastructure and operating knowledge |
| Observability | Sentry (errors), Prometheus + Grafana (metrics), Loki (logs), Uptime Kuma | |

**Explicitly rejected:** microservices, Kafka, Kubernetes, a separate data warehouse, a graph database. All are wrong at this scale and would add months of build and a permanent operations burden for zero measurable benefit.

---

## 4. The Semantic Layer — Metric Dictionary

**This is the highest-value section of the document.** Finding F12 (the same metric disagreeing between two tabs of the same MIS pack) exists because no such dictionary exists. Every metric below is a certified SQL view. Reports may only read from these views; no report computes its own arithmetic.

### 4.1 Activity metrics

| Metric | Definition | Formula | Grain |
|---|---|---|---|
| **Total Dialling** | Distinct outbound call attempts | `COUNT(activity WHERE type='CALL')` | rep × day |
| **Num of Connect** | Attempts where customer answered | `COUNT(activity WHERE type='CALL' AND connected=true)` | rep × day |
| **Connectivity %** | Answer rate | `Num of Connect ÷ Total Dialling` | rep × day × source |
| **CD** (Connected Data) | Distinct leads connected at least once | `COUNT(DISTINCT lead_id WHERE ever_connected)` | rep × period |
| **ND** (Not-connected Data) | Distinct leads never connected | `Assigned Leads − CD` | rep × period |
| **Today's CD** | Leads first connected today | `COUNT(DISTINCT lead WHERE first_connect_date = today)` | rep × day |
| **Fq (Frequency)** | Contact attempts against one lead | `COUNT(activity) GROUP BY lead_id` | lead |
| **Buyers Fq** | Number of purchases by a customer | `COUNT(order WHERE status='DELIVERED') GROUP BY customer_id` | customer |
| **Follow-up SLA** | % of due follow-ups actioned same day | `actioned_on_time ÷ due` | rep × day |

### 4.2 Data-block metrics (preserving the `Team Audit` model)

| Metric | Definition | Formula |
|---|---|---|
| **No of Data** | Leads in an assigned block | `COUNT(lead) WHERE batch_id = X` |
| **Given Date** | Date block was assigned | `batch.assigned_at` |
| **Data Valid Till** | Shelf-life expiry | `assigned_at + source.validity_days` |
| **Order Target** | Expected orders from the block | `No of Data × source.expected_conversion_rate` |
| **Till Achieve Order** | Orders realised from block to date | `COUNT(order WHERE lead.batch_id = X AND delivered)` |
| **Conversion %** | Block yield | `Till Achieve Order ÷ No of Data` |
| **Data Ageing** | Days since assignment | `today − assigned_at` |
| **Untouched Leads** | Assigned but zero activity — *new, and the single most actionable operational metric* | `COUNT(lead WHERE activity_count = 0 AND age > 2 days)` |

### 4.3 Revenue metrics — corrected definitions

These replace the current definitions and fix findings F7, F9, F10, F11.

| Metric | Current (broken) | Corrected definition |
|---|---|---|
| **Booked Value** | Ambiguous, occasionally lower than Achieved (F10) | `SUM(order.final_value) WHERE order_date IN period` — status-independent. **Provisional.** |
| **Achieved / Realised Value** | Mixed with Booked | `SUM(order.final_value) WHERE status='DELIVERED' AND delivered_date IN period`. **This is the only number that pays incentive.** |
| **Total Orders** | Derived, fractional (73.8) (F9) | `COUNT(DISTINCT order_id)` — an integer, always |
| **Product-wise Revenue** | Skinwise = ₹0 despite ₹2.5L of sales (F8) | Allocated at **order-line** level to `product.line`, so multi-line orders split correctly across Breast Care / Skinwise / Slimming / Intimate / Face / Hair / Customisation |
| **AOV** | Not tracked | `Realised Value ÷ Delivered Orders` |
| **RTO %** | Two different values in two tabs (F12) | `RTO Value ÷ (Delivered Value + RTO Value)` for orders **dispatched** in period. One definition, computed once. |
| **Value Balance** | `Target − Achieved` ✓ (correct) | Retained unchanged |
| **Per Day Req Delivery** | `Value Balance ÷ remaining working days` ✓ | Retained; working-day calendar becomes a configurable master |
| **Required Booking Value** | `Per Day Req Delivery × 1.15` — flat 15% for everyone (F11) | **`Per Day Req Delivery ÷ (1 − rep_rolling_90d_RTO%)`.** Kajal at 41% RTO gets ₹15,491/day instead of ₹10,511 — a correct target instead of a comforting one. |
| **Approx Guess Rest of Month** | Straight-line ×  remaining days (F16) | Pipeline-weighted: `(open pipeline × stage probability) + (run-rate × remaining days × seasonality index)`, RTO-adjusted |

### 4.4 Attribution metrics — new

| Metric | Definition |
|---|---|
| **Company Base Revenue** | Order value already committed by the customer before any rep intervention (Shopify cart value, WhatsApp campaign order value) |
| **Employee Credited Value** | `order.final_value − company_base_value`, per the source rule table in Section 9 |
| **Upsell Index** | `Employee Credited Value ÷ Company Base Value` on upsell-eligible orders — the truest single measure of selling skill |
| **Realised Credited Value** | Employee Credited Value where order status = DELIVERED. **Incentive basis.** |
| **Clawback** | Credited value reversed when a delivered order flips to RTO/Return |

---

## 5. Database Architecture

PostgreSQL 16. Every table carries `created_at`, `updated_at`, `created_by`, and where relevant `deleted_at` (soft delete). Row-Level Security policies are applied to every customer-facing table.

### 5.1 Entity map

```
                          ┌──────────────┐
                          │   customer   │  (surrogate UUID PK — golden record)
                          └──────┬───────┘
       ┌─────────────────────────┼─────────────────────────┐
       │                         │                         │
┌──────▼──────────────┐  ┌───────▼────────┐      ┌─────────▼──────────┐
│customer_identifier  │  │      lead      │      │       order        │
│ phone/alt/email     │  │ one per lead   │      │ header             │
│ many → one customer │  │ instance from  │      └─────────┬──────────┘
└─────────────────────┘  │ a source batch │                │
                         └───────┬────────┘      ┌─────────▼──────────┐
                                 │               │    order_line      │
                    ┌────────────┼──────────┐    │ sku · qty · value  │
                    │            │          │    └─────────┬──────────┘
          ┌─────────▼───┐ ┌──────▼──────┐   │              │
          │lead_assign  │ │  activity   │   │      ┌───────▼────────┐
          │ ment (log)  │ │ call/wa/note│   │      │ order_status   │
          └─────────────┘ └─────────────┘   │      │ _event (append)│
                                            │      └────────────────┘
                          ┌─────────────────▼──┐
                          │ attribution_ledger │  (append-only, money)
                          └────────────────────┘
```

### 5.2 Core tables

```sql
-- ═══ IDENTITY ═══════════════════════════════════════════════════════════
customer (
  customer_id        uuid PK,
  primary_phone      varchar(15) UNIQUE,        -- E.164, business key
  full_name          text,
  gender             text,
  city, state, pincode,
  address_json       jsonb,                     -- versioned addresses
  customer_type      enum('NEW','EXISTING'),    -- DERIVED, never typed
  first_order_date   date,
  last_order_date    date,
  lifetime_orders    int   DEFAULT 0,           -- maintained by trigger
  lifetime_value     numeric(12,2) DEFAULT 0,
  buyer_stage        enum('PROSPECT','FIRST','SECOND','THIRD',
                          'REPEAT','LOYAL','DORMANT','CHURNED'),
  rto_count          int DEFAULT 0,
  rto_risk_score     numeric(4,3),              -- 0.000–1.000, model output
  owner_employee_id  uuid FK → employee,        -- relationship ownership
  owner_expires_at   timestamptz,
  next_due_date      date,                      -- repeat-purchase engine
  do_not_call        boolean DEFAULT false,
  merged_into        uuid FK → customer         -- de-dupe audit
)

customer_identifier (
  identifier_id  uuid PK,
  customer_id    uuid FK,
  type           enum('MOBILE','ALT_MOBILE','WHATSAPP','EMAIL'),
  value          varchar(120),
  is_primary     boolean,
  confidence     numeric(3,2),
  source_batch_id uuid,
  UNIQUE(type, value) WHERE is_primary          -- solves Correction 1
)

-- ═══ MASTER DATA ════════════════════════════════════════════════════════
product_line   (line_id, name)     -- Breast Care, Skinwise, Slimming Care,
                                   -- Intimate Care, Face Care, Hair Care,
                                   -- Customisation
sku (
  sku_id uuid PK, sku_code text UNIQUE, product_name text,
  line_id FK, variant text,        -- '100 gm', '60 capsule', '50 ml'
  pack_size text,                  -- '(1 Pack)', '(2 Pack)'
  mrp numeric, shopify_base_price numeric,   -- ← drives upsell rule (F7)
  is_active boolean,
  name_aliases text[],             -- 'MAMO FIRM Breast…', 'Mamo Firm Cream'
  name_embedding vector(768)       -- pgvector fuzzy resolution
)

employee (
  employee_id uuid PK, emp_code text UNIQUE, full_name text,
  role enum('SUPER_ADMIN','ADMIN','TEAM_LEAD','EMPLOYEE'),
  status enum('ACTIVE','ON_LEAVE','SUSPENDED','EXITED'),   -- fixes F13
  monthly_target numeric, joined_on date, exited_on date,
  wip_cap int DEFAULT 150, allocation_weight numeric DEFAULT 1.0
)

lead_source (
  source_id uuid PK, code text UNIQUE,   -- SHOPIFY, META_ADS, WEB_WHATSAPP,
                                         -- ADD_TO_CART, WEB_CALL, WA_CAMPAIGN,
                                         -- DELIVERED_REPEAT, RTO, NC_REFUSED
  display_name text,
  validity_days int,                     -- → Data Valid Till
  expected_conversion_rate numeric,      -- → Order Target
  attribution_rule enum('FULL_CREDIT','UPSELL_DELTA','SPLIT_PERCENT'),
  base_value_field text,                 -- where the company base comes from
  employee_credit_percent numeric DEFAULT 100
)

disposition (                            -- fixes F4 — closed vocabulary
  disposition_id uuid PK, code text UNIQUE, label text,
  category enum('CONNECTED','NOT_CONNECTED','POSITIVE','NEGATIVE','CLOSED'),
  is_terminal boolean,
  requires_followup_date boolean,
  counts_as_connect boolean,             -- drives Connectivity %
  aliases text[]  -- ['ringing','rinigng','ring','ring cut'] → RINGING
)

working_calendar (calendar_date PK, is_working_day boolean, month_key text)

-- ═══ LEAD & ACTIVITY ════════════════════════════════════════════════════
lead (
  lead_id uuid PK, customer_id FK, source_id FK,
  ingestion_batch_id FK,
  received_at timestamptz, valid_till date,
  quality_tier enum('A','B','C'),        -- stratification, Correction 3
  predicted_value numeric,
  current_disposition_id FK,
  lead_temperature enum('HOT','WARM','COLD'),   -- preserved from current model
  assigned_to uuid FK → employee,
  assigned_at timestamptz,
  first_contact_at, last_contact_at timestamptz,
  contact_attempts int DEFAULT 0,        -- → Fq
  ever_connected boolean DEFAULT false,  -- → CD/ND
  next_followup_at timestamptz,
  is_converted boolean, converted_order_id FK,
  closed_at timestamptz, close_reason text
)

lead_assignment (          -- append-only; full transfer history
  assignment_id uuid PK, lead_id FK,
  from_employee_id, to_employee_id uuid,
  assigned_by uuid, assignment_method enum('AUTO','MANUAL','TRANSFER',
                                           'REBALANCE','EXPLORATION'),
  reason text, assigned_at timestamptz
)

activity (                 -- append-only; every touch
  activity_id uuid PK, lead_id FK, customer_id FK, employee_id FK,
  type enum('CALL','WHATSAPP','SMS','NOTE','STATUS_CHANGE','ORDER'),
  connected boolean, duration_seconds int,
  disposition_id FK,
  remark_raw text,                       -- Hinglish, as typed
  remark_normalised text,                -- AI-cleaned English
  sentiment enum('POSITIVE','NEUTRAL','NEGATIVE'),
  intent_tags text[],                    -- ['price_objection','has_stock']
  call_recording_url text, telephony_call_id text,
  occurred_at timestamptz
)

-- ═══ ORDER LEDGER ═══════════════════════════════════════════════════════
order (
  order_id uuid PK, order_number text UNIQUE,
  customer_id FK, lead_id FK, source_id FK,
  booked_by_employee_id FK,
  order_date date, dispatch_date date, delivered_date date, rto_date date,
  gross_value numeric(12,2),
  company_base_value numeric(12,2),      -- pre-intervention value (F7)
  final_value numeric(12,2),
  discount_value numeric(12,2), coupon_code text,
  payment_mode enum('COD','PREPAID','PARTIAL_PREPAID'),   -- fixes F5
  prepaid_amount numeric(12,2),          -- parsed from '300 prepaid & 2200 cod'
  cod_amount numeric(12,2),
  prepaid_ratio numeric GENERATED,       -- the RTO lever, finally measurable
  awb_number text, courier_partner text,
  current_status enum('PENDING','CONFIRMED','PROCESSING','DISPATCHED',
                      'IN_TRANSIT','OFD','DELIVERED','RTO','RETURNED',
                      'CANCELLED','FAILED_DELIVERY','NO_RESPONSE','REFUSED'),
  shipping_address_json jsonb,
  rto_predicted_risk numeric(4,3)
)

order_line (               -- fixes F8 — product P&L at line grain
  line_id uuid PK, order_id FK, sku_id FK,
  quantity int, unit_price numeric, line_value numeric,
  is_upsell_line boolean, is_free_item boolean
)

order_status_event (       -- append-only; reproducible history
  event_id uuid PK, order_id FK,
  from_status, to_status text,
  event_at timestamptz, source enum('UPLOAD','MANUAL','COURIER_API'),
  ingestion_batch_id FK, changed_by uuid
)

-- ═══ MONEY ══════════════════════════════════════════════════════════════
attribution_ledger (       -- append-only; the incentive source of truth
  entry_id uuid PK, order_id FK, employee_id FK,
  entry_type enum('BOOKED_CREDIT','REALISED_CREDIT',
                  'CLAWBACK','ADJUSTMENT','MANUAL_OVERRIDE'),
  company_base_value numeric, employee_credited_value numeric,
  rule_applied text, rule_version int,
  is_realised boolean, period_key text,   -- '2026-08'
  approved_by uuid, note text, created_at timestamptz
)

employee_score_daily (     -- computed nightly, never edited
  employee_id, score_date PK,
  leads_assigned, leads_touched, leads_untouched,
  dials, connects, connectivity_pct,
  orders_booked, orders_delivered, orders_rto,
  booked_value, realised_value, credited_value, realised_credited_value,
  upsell_index, rto_pct, conversion_pct, followup_sla_pct, data_hygiene_pct,
  efficiency_score numeric(5,2),         -- 0–100 blended
  efficiency_percentile numeric,
  shrinkage_applied boolean
)

-- ═══ INGESTION ══════════════════════════════════════════════════════════
ingestion_batch (
  batch_id uuid PK, source_id FK, uploaded_by uuid,
  file_name text, file_hash char(64) UNIQUE,   -- SHA-256 → no double-count
  file_url text,                                -- immutable raw copy
  row_count int, rows_valid int, rows_exception int,
  rows_duplicate int, rows_committed int,
  mapping_template_id FK,
  status enum('UPLOADED','MAPPING','VALIDATING','REVIEW',
              'COMMITTED','ROLLED_BACK','FAILED'),
  committed_at timestamptz, rolled_back_at timestamptz
)

staging_row (
  staging_id uuid PK, batch_id FK, row_number int,
  raw_json jsonb,                        -- exactly as uploaded
  mapped_json jsonb,                     -- after column mapping
  normalised_json jsonb,                 -- after cleaning
  validation_status enum('VALID','WARNING','ERROR','DUPLICATE'),
  validation_errors jsonb,
  resolved_customer_id uuid, resolved_action enum('CREATE','MERGE','UPDATE'),
  committed_entity_id uuid
)

column_mapping_template (
  template_id uuid PK, source_id FK,
  header_signature char(64),             -- hash of sorted headers
  mapping jsonb,                         -- {"Phone no":"primary_phone", …}
  confidence numeric, confirmed_by uuid, use_count int
)

-- ═══ GOVERNANCE ═════════════════════════════════════════════════════════
audit_log (
  log_id bigserial PK, actor_id uuid, actor_role text,
  action text, entity_type text, entity_id uuid,
  before_json jsonb, after_json jsonb,
  ip_address inet, user_agent text, occurred_at timestamptz
)

pii_reveal_log (           -- every unmasked phone view (Correction 2)
  reveal_id bigserial PK, employee_id uuid, customer_id uuid,
  reason text, ip_address inet, occurred_at timestamptz
)
```

### 5.3 Row-Level Security — the isolation guarantee

Employee data isolation is enforced in the database, not in application code. If a developer forgets a `WHERE` clause, or an endpoint is called directly, the database still returns nothing.

```sql
ALTER TABLE lead ENABLE ROW LEVEL SECURITY;

CREATE POLICY lead_employee_isolation ON lead
  FOR ALL TO app_role
  USING (
    current_setting('app.user_role') IN ('ADMIN','SUPER_ADMIN')
    OR assigned_to = current_setting('app.user_id')::uuid
  );
```

Equivalent policies apply to `customer`, `order`, `activity` and `attribution_ledger`. Requirement — *"employees should not have access to other employees' data"* — becomes a structural property of the system rather than a promise.

### 5.4 Indexing and performance plan

| Index | Purpose |
|---|---|
| `customer(primary_phone)` unique btree | O(1) new-vs-existing check on every ingested row |
| `customer_identifier(type, value)` | Alt-number matching |
| `lead(assigned_to, next_followup_at) WHERE NOT is_converted` | Employee daily worklist — the hottest query in the system |
| `lead(source_id, received_at DESC)` | Source performance reports |
| `order(delivered_date, source_id)` partial `WHERE status='DELIVERED'` | Realised-revenue reporting |
| `order_line(sku_id)` + `order(order_date)` | Product-wise P&L |
| `activity(employee_id, occurred_at DESC)` BRIN | Time-series activity; BRIN keeps it tiny |
| `sku USING ivfflat (name_embedding)` | Fuzzy product-name resolution |

Materialised views for MIS: `mv_daily_employee_kpi`, `mv_product_revenue_daily`, `mv_source_funnel_daily`, `mv_rto_analysis`, `mv_repeat_due_queue`. Refreshed `CONCURRENTLY` every 15 minutes plus once at 00:05 for the previous-day close.

---

## 6. Ingestion & AI Processing Pipeline

Your requirement is clear: admin uploads a file, everything else is automatic. The pipeline below delivers that while remaining fully auditable and fully reversible — because an ingestion engine you cannot undo is a liability, not an asset.

### 6.1 The nine upload channels

| # | Channel | File origin | Creates | Attribution rule | Validity |
|---|---|---|---|---|---|
| 1 | **Shopify Orders** | Shopify export | Customer + Order (base value set) | `UPSELL_DELTA` | 3 days |
| 2 | **Meta Ads Leads** | Meta Lead Ads CSV | Lead only | `FULL_CREDIT` | 7 days |
| 3 | **Website WhatsApp** | Chat export | Lead only | `FULL_CREDIT` | 5 days |
| 4 | **Add to Cart** | Shopify abandoned cart | Lead + intent SKUs | `FULL_CREDIT` | 2 days |
| 5 | **Website Call** | Call tracking export | Lead only | `FULL_CREDIT` | 1 day |
| 6 | **WhatsApp Campaign** | AiSensy / Combird | Lead, sometimes Order | `UPSELL_DELTA` if order present | 7 days |
| 7 | **Delivered Customers** | Courier / internal | Repeat-purchase lead | `FULL_CREDIT` | 30 days |
| 8 | **RTO** | Courier RTO report | Order status event + recovery lead | `FULL_CREDIT` on recovery | 15 days |
| 9 | **NC / Refused** | Courier NDR report | Order status event + recovery lead | `FULL_CREDIT` on recovery | 3 days |

### 6.2 The seven-stage pipeline

```
[1] UPLOAD          Admin drops XLSX/CSV into the channel's upload box.
                    SHA-256 fingerprint computed. Identical file already
                    ingested → blocked with a message. Solves the
                    double-counting risk inherent in daily manual uploads.
                    Raw file copied immutably to object storage.
                              │
[2] COLUMN MAPPING  Header signature hashed → look up saved template.
                    HIT  (≈95% of days): deterministic, zero AI, instant.
                    MISS (new/changed layout): LLM sees headers + 5 sample
                    rows, proposes a mapping with per-field confidence.
                    Admin confirms once; template is saved forever.
                              │  Directly addresses F6 — 'Phone no' /
                              │  'Phoneno' / 'Number' / 'ProductDeatil'
                              ▼
[3] NORMALISATION   Deterministic transforms, no AI:
                    · Phone → E.164; strip +91/0/spaces; reject non-6789
                    · Names → title case, strip emoji (data contains
                      '【G】【u】【p】【t】【a】❣️' and 'Aditi ❤️')
                    · Encoding repair (data contains mojibake
                      'à¤®à¥‹à¤¹à¤¨' = Devanagari read as Latin-1)
                    · Dates → ISO; ambiguous DD-MM vs MM-DD resolved by
                      source-level locale rule (data has both '15-06-26'
                      and '2026-12-06' meaning the same June date)
                    · Payment string → structured split. '300 prepaid &
                      2200 cod' → prepaid=300, cod=2200, mode=PARTIAL.
                      Alias table absorbs preapid/prepiad/webpay. (F5)
                    · Disposition → closed vocabulary via alias table (F4)
                    · Product text → SKU via exact → alias → pgvector
                      similarity → human queue. (F8)
                    · Column-shift detection: if ≥20% of a column fails its
                      type check, flag the whole batch as SHIFTED and stop.
                      This is what would have caught F3 in April.
                              │
[4] IDENTITY        Match on primary_phone → alt identifiers → fuzzy
    RESOLUTION      (name + pincode + Levenshtein). Outcome per row:
                    CREATE new customer / UPDATE existing / MERGE candidate
                    / DUPLICATE within batch. Merges above 0.95 confidence
                    are automatic; 0.80–0.95 go to the review queue.
                    customer_type is DERIVED here — never uploaded.
                              │
[5] VALIDATION      Row-level rules: mandatory fields, phone validity,
                    pincode-vs-state consistency, amount sanity (order
                    value > 10× the SKU MRP → flag), future dates,
                    duplicate-order detection (same customer + SKU + value
                    within 48h). Each row lands VALID / WARNING / ERROR.
                              │
[6] EXCEPTION       Admin sees ONLY the exceptions — typically 3–8% of
    REVIEW          rows. Clean rows are never shown. Bulk actions:
                    accept-all-warnings, fix-and-retry, discard.
                    This is the entire manual workload: minutes per day.
                              │
[7] COMMIT          Single transaction: staging → live tables. Leads
                    created, orders written, status events appended,
                    lifecycle recalculated, assignment queue populated.
                    Batch is fully reversible via ROLLBACK BATCH for 7 days.
```

### 6.3 Where AI is used — and where it is forbidden

| AI is used for | Model | Fallback if it fails |
|---|---|---|
| Column mapping on unseen headers | LLM, cached as template | Admin maps manually once |
| Hinglish remark → normalised English + intent tags | LLM, batched nightly | Raw remark retained and displayed |
| Product text → SKU resolution | pgvector + LLM tie-break | Human resolution queue |
| Disposition free-text → closed vocabulary | Alias table first, LLM only on miss | Defaults to `OTHER`, flagged |
| Call summary and next-best-action suggestion | LLM | Feature simply absent |

**AI is forbidden from:** computing any revenue figure, deciding lead assignment, calculating any efficiency score, altering an order status, or writing to the attribution ledger. Every number in every report is produced by SQL over immutable facts. This is non-negotiable — an LLM that occasionally hallucinates a total is worse than the spreadsheet you have today.

### 6.4 Idempotency and reversibility

Manual daily uploads fail in exactly two ways: the same file uploaded twice, and a bad file uploaded once. Both are handled structurally.

- **File-level:** SHA-256 fingerprint, unique-constrained. A re-upload is rejected, not merged.
- **Row-level:** natural key `(source, external_ref)` or `(phone, order_date, value)` prevents duplicates when a partially overlapping file arrives — which is normal for daily Shopify exports.
- **Batch-level:** `ROLLBACK BATCH` reverses every insert and update from a batch within 7 days, using the append-only event log to restore prior state.
- **Replay:** the raw file is retained, so a batch can be re-processed after a rule fix without asking anyone to re-download anything.

---

## 7. Lead Assignment Engine

### 7.1 Employee Efficiency Score (EES)

Computed nightly per employee over a rolling 30-day window, on delivered outcomes.

| Component | Weight | Metric | Rationale |
|---|---|---|---|
| Conversion Rate | 25% | Delivered orders ÷ leads assigned | Core productivity |
| Value per Lead | 25% | Realised value ÷ leads assigned | Rewards value, not just count |
| **Delivery Quality** | **20%** | `1 − RTO%` | **In a COD ayurveda business a rep booking ₹3L at 41% RTO destroys more margin than a rep booking ₹1.5L at 3%. The current scoreboard is blind to this.** |
| Upsell Index | 15% | Credited value ÷ base value on eligible orders | Isolates selling skill from lead luck |
| Activity Discipline | 10% | Follow-up SLA + dial coverage + untouched-lead rate | Process compliance |
| Data Hygiene | 5% | Dispositions filled, remarks present, no stale leads | Protects the MIS itself |

**Normalisation:** each component is percentile-ranked within the active team, then weighted. Applied on top:

- **Bayesian shrinkage** — `adjusted = (n × observed + k × team_mean) ÷ (n + k)` with `k = 30` leads. A rep with 12 leads cannot top the chart on a lucky order.
- **Source-mix neutralisation** — scores computed within source cohorts and re-weighted, so a rep loaded with Delivered-Data leads is not compared naively against one on Meta Ads.
- **7-day lag** — allocation uses last week's score to prevent oscillation.
- **Manual override** — admins can pin an `allocation_weight`, with the override logged and shown on the dashboard.

### 7.2 Allocation algorithm

```
For each ingestion batch:

1. STRATIFY      Each lead → tier A / B / C by predicted value
                 (source × product × geography × prepaid propensity).

2. RESERVE       Continuity: existing customers route to their owning rep
                 if the rep is active and ownership has not expired (90d).
                 Relationship beats efficiency. Always.

3. EXPLORATION   Set aside 10% of tier-A leads for round-robin allocation
                 regardless of score. This is what keeps the leaderboard
                 honest and gives juniors a fair sample.

4. CAPACITY      Exclude reps at WIP cap (default 150 open leads) or
                 on leave. Never assign into a backlog.

5. WEIGHTED      Within each tier, share_i = EES_i^γ / Σ(EES_j^γ), γ=1.0
   ALLOCATION    Apply floor 0.6× and cap 1.8× of equal share.
                 Largest-remainder rounding — no lead is ever lost.

6. WRITE         lead_assignment rows (append-only) + notification.
                 Every assignment records its method and reason.

7. AUDIT         Weekly fairness report: leads/tier/rep, score vs share,
                 exploration-arm conversion vs allocated-arm conversion.
                 If exploration conversion ≈ allocated conversion, the
                 score is not measuring skill — and you will know.
```

**Rebalancing:** if a rep goes on leave, is suspended or exits, open leads are re-queued using the same algorithm with a mandatory handover note. If a lead is untouched for 48 hours, it is auto-flagged; at 72 hours it returns to the pool and the rep's Activity Discipline score is debited.

### 7.3 Configurability

Admins control, without a developer: component weights, γ, floor/cap, exploration %, WIP caps, per-source validity days, expected conversion rates, tier thresholds, and per-employee overrides. Every change is versioned, so any past allocation can be explained.

---

## 8. Sales Attribution & Incentive Engine

### 8.1 The rule table

This encodes your Shopify and WhatsApp examples exactly, and generalises them.

| Source | Company Base Revenue | Employee Credited Value | Worked example |
|---|---|---|---|
| Shopify Orders | Shopify order value at import | `final − base` | ₹500 order upsold to ₹2,000 → company ₹500, employee **₹1,500** |
| WhatsApp Campaign (order present) | Campaign order value | `final − base` | ₹700 order upsold to ₹1,800 → company ₹700, employee **₹1,100** |
| Meta Ads Leads | ₹0 | Full order value | Rep created the entire sale |
| Website WhatsApp | ₹0 | Full order value | |
| Website Call | ₹0 | Full order value | |
| Add to Cart | ₹0 | Full order value | Cart was never a committed order |
| Delivered / Repeat | ₹0 | Full order value | Repeat sale is rep-generated |
| RTO Recovery | ₹0 | Full value (configurable %) | Recovering a dead order is real work |
| NC / Refused Recovery | ₹0 | Full value (configurable %) | |
| Split ownership | per rule | Split by configured % across reps | Handles `Riya Chauhan / Shopify` and `Riya / Divya` correctly |

`company_base_value` is resolved automatically from `sku.shopify_base_price` and the imported order value — never typed by a human. **This alone eliminates the 31% leakage in F7.**

### 8.2 Two ledgers, one truth

```
ORDER BOOKED     →  BOOKED_CREDIT entry     (provisional; shows on
                    live dashboard as "Booked")

ORDER DELIVERED  →  REALISED_CREDIT entry   (counts toward incentive)

ORDER RTO/RETURN →  CLAWBACK entry          (automatic reversal)

Incentive payable = Σ REALISED_CREDIT − Σ CLAWBACK, for period_key
```

Consequences, all of them desirable:

- Booking a large order that RTOs earns the rep nothing — the behavioural incentive finally matches company margin.
- Achieved can never exceed Booked (fixes F10) because they are derived from the same ledger.
- The RTO buffer in targets becomes rep-specific and correct (fixes F11).
- Incentive computation stops being a monthly manual exercise and becomes a report.

### 8.3 Incentive slab engine

Configurable slabs on realised credited value, with modifiers:

| Lever | Example | Effect |
|---|---|---|
| Base slab | ₹1L → 2%, ₹2L → 3%, ₹3L → 4% | Standard |
| Delivery-quality multiplier | RTO < 5% → ×1.15; RTO > 20% → ×0.75 | Prices in margin destruction |
| Prepaid bonus | Prepaid ratio > 30% → +0.5% | Directly attacks the RTO root cause |
| Product-line SPIF | Skinwise → +1% for the quarter | Fixes the ₹0 Skinwise problem commercially, not just in reporting |
| Repeat-customer bonus | Buyer Fq ≥ 3 → +₹100/order | Rewards LTV over churn |

---

## 9. Module Hierarchy & Role Permissions

### 9.1 Module map

```
REVVEDA CRM
│
├── 1. ADMIN CONSOLE ──────────────── (Sunita · Sonam · Sonia)
│   ├── 1.1 Data Upload Centre        9 channels · batch history · rollback
│   ├── 1.2 Exception Review          mapping · duplicates · merge queue
│   ├── 1.3 Lead Assignment           auto-run · manual · transfer · rebalance
│   ├── 1.4 Employee Management       roster · targets · WIP · weights · access
│   ├── 1.5 Customer 360 (full)       search · history · merge · DNC
│   ├── 1.6 Order Management          status · AWB · RTO · manual order entry
│   ├── 1.7 Master Data               SKUs · lines · sources · dispositions ·
│   │                                 calendar · attribution rules · slabs
│   ├── 1.8 MIS & Reports             full catalogue (Section 10)
│   ├── 1.9 Audit & Security          audit log · PII reveals · sessions
│   └── 1.10 System Settings          scoring weights · SLAs · notifications
│
├── 2. EMPLOYEE PORTAL ────────────── (7 BDEs)
│   ├── 2.1 My Dashboard              target vs achieved · today's plan ·
│   │                                 rank · realised vs booked · RTO
│   ├── 2.2 My Worklist               priority queue: overdue → due today →
│   │                                 hot → fresh → ageing (never a raw list)
│   ├── 2.3 Lead Detail               masked number · click-to-call ·
│   │                                 disposition · remark · follow-up · order
│   ├── 2.4 Order Entry               SKU picker · auto-price · payment split ·
│   │                                 live upsell-credit preview
│   ├── 2.5 My Follow-ups             calendar view · overdue highlighted
│   ├── 2.6 My Customers              only owned customers · full order history
│   └── 2.7 My Performance            own metrics only · incentive projection
│
├── 3. TEAM LEAD (optional, Phase 4)  team-scoped read + reassignment
│
└── 4. EXECUTIVE VIEW                 read-only KPI wall · no PII
```

### 9.2 Permission matrix

| Capability | Employee | Team Lead | Admin | Super Admin |
|---|:--:|:--:|:--:|:--:|
| View own assigned leads | ✅ | ✅ | ✅ | ✅ |
| View other employees' leads | ❌ | Team only | ✅ | ✅ |
| See full unmasked mobile | ❌ (reveal w/ reason + quota) | ❌ | ✅ | ✅ |
| Click-to-call | ✅ | ✅ | ✅ | ✅ |
| Export / download data | ❌ | ❌ | ✅ (watermarked, logged) | ✅ |
| Print | ❌ | ❌ | ✅ | ✅ |
| Bulk list view (>50 rows) | ❌ | ❌ | ✅ | ✅ |
| Create / edit order | ✅ own leads | ✅ team | ✅ | ✅ |
| Change order status | ❌ | ❌ | ✅ | ✅ |
| Upload data files | ❌ | ❌ | ✅ | ✅ |
| Assign / transfer leads | ❌ | ✅ team | ✅ | ✅ |
| Edit master data | ❌ | ❌ | ✅ | ✅ |
| Change scoring weights | ❌ | ❌ | ✅ | ✅ |
| Edit attribution ledger | ❌ | ❌ | ✅ (adjustment only, logged) | ✅ |
| View audit log | ❌ | ❌ | ✅ | ✅ |
| Manage admins | ❌ | ❌ | ❌ | ✅ |
| Delete anything | ❌ | ❌ | Soft only | Soft only |

All three admins hold identical `ADMIN` permissions as specified. **One `SUPER_ADMIN` — the business owner — should exist above them**, because three people with mutually unrevocable full access and no supervising role is a governance gap, not a design.

---

## 10. MIS & Reporting Catalogue

Every existing manual report is replaced by a live equivalent. Nothing is dropped.

### 10.1 Direct replacements

| Current artefact | Replaced by | Refresh |
|---|---|---|
| `Team Audit` (per-rep, per-data-block) | **Data Block Performance** — auto-populated from `lead` + `ingestion_batch`; no IMPORTRANGE | 15 min |
| `Score board & Audit Live Dashboard` | **Live Team Scoreboard** — from `employee_score_daily`; no hardcoded cell refs (fixes F14) | 15 min |
| `Achieve Report` | **Target vs Achievement** — with corrected product split (F8), integer orders (F9), rep-specific RTO buffer (F11) | 15 min |
| `Follow up Sheet` | **Follow-up Queue** — a live worklist, not a report | Real time |
| `RTO Sheet` / `nc refused` | **RTO & NDR Console** with recovery workflow | On upload |
| `PlaningSheet` | **Daily Plan** — auto-generated from required run-rate and pipeline | 00:05 daily |
| Nine employee workbooks | **Deleted.** Data lives server-side; reps have no file. (fixes F15) | — |

### 10.2 Full report catalogue

**Sales & Revenue**
Daily/weekly/monthly revenue · booked vs realised · product-line P&L (Breast Care, Skinwise, Slimming, Intimate, Face, Hair, Customisation) · SKU-level sales · AOV trend · discount & coupon impact · prepaid vs COD mix · state/city geography heatmap.

**Employee Performance**
Live scoreboard · target vs achieved · efficiency breakdown by component · dialling & connectivity · CD/ND analysis · conversion funnel by source · upsell index league · RTO by rep · follow-up SLA compliance · untouched-lead exception · incentive projection & payout sheet.

**Lead & Source Analytics**
Source-wise funnel (received → assigned → connected → converted → delivered) · cost per lead and cost per delivered order where ad spend is entered · campaign ROI · lead ageing pyramid · data-block yield vs `Data Valid Till` · connectivity by source and time-of-day (drives dialling shift planning) · dead-lead analysis.

**Customer Analytics**
New vs existing split · buyer-stage distribution (First / Second / Third / Repeat / Loyal) · repeat-purchase due queue · cohort retention by first-purchase month · LTV by acquisition source · dormant and win-back list · product cross-purchase matrix (which SKU leads to which next).

**Operations & Risk**
Order status pipeline · dispatch and delivery TAT by courier · RTO analysis by rep, product, geography, payment mode, value band · NDR/refused reasons · high-risk-order pre-dispatch alert list · courier performance comparison.

**Management**
Executive one-pager (revenue, orders, RTO%, conversion, top rep, top product) · month-close pack · MTD pace vs required run-rate · rolling forecast · team capacity utilisation · data-quality scorecard.

### 10.3 Answering the management questions from the brief

| Question | Where it is answered | Latency |
|---|---|---|
| How much of product X was sold? | Product-line P&L → SKU drill-down | 15 min |
| How much revenue did employee Y generate? | Scoreboard → booked / realised / credited | 15 min |
| Which lead source performed best? | Source funnel, ranked by delivered value per lead | 15 min |
| Which campaign had the highest ROI? | Campaign ROI (requires spend entry) | 15 min |
| Which customers are due for repeat purchase? | Repeat-Due Queue — already a worklist, not a report | Real time |
| Who has the highest conversion rate? | Efficiency breakdown, source-normalised | Nightly |

### 10.4 Push, not pull

Reports nobody opens are reports nobody uses.

- **07:30 daily** — each rep receives their plan on WhatsApp/email: target gap, overdue follow-ups, repeat-due customers, yesterday's realised value.
- **08:00 daily** — admins receive the exception digest: files pending upload, unresolved duplicates, untouched leads, high-RTO-risk orders awaiting dispatch.
- **21:00 daily** — management receives the one-pager.
- **Monday 09:00** — weekly pack including the allocation fairness audit.
- **1st of month** — month-close pack with incentive computation ready for approval.
- **Real-time alerts** — target achieved, RTO spike beyond threshold, ingestion failure, PII-reveal anomaly, employee inactive for 2 hours during shift.

---

## 11. Workflows

### 11.1 Admin day (target: under 25 minutes)

```
09:00  Open Admin Console. Review overnight digest.
09:05  Upload today's files into the nine channel boxes. Drag, drop, done.
09:10  System processes: fingerprint → map → normalise → resolve → validate.
       Typical outcome on ~500 rows: ~470 clean, ~25 warnings, ~5 exceptions.
09:12  Review the ~30 flagged rows only. Bulk-accept warnings; resolve the
       handful of genuine merge/mapping questions.
09:18  Commit. Assignment engine runs automatically; reps are notified.
09:22  Scan the exception dashboard: untouched leads, stale follow-ups,
       high-RTO-risk orders queued for dispatch.
09:25  Done. The remainder of the day is exception-driven, not routine.
```

Everything that today consumes hours of copy-paste across nine spreadsheets collapses into this.

### 11.2 Employee day

```
Login → 2FA → device-bound session
   │
   ▼
MY DASHBOARD    Target ₹3,00,000 · Realised ₹1,19,720 (39.9%)
                Required today ₹15,023 · Booked today ₹4,850
                Rank 3 of 7 · RTO 8% (team 4% — flagged)
   │
   ▼
MY WORKLIST     Priority-ordered, never a raw list:
                🔴 Overdue follow-ups (4)      ← must clear first
                🟠 Due today (11)
                🔥 Hot leads untouched (3)
                🔵 Fresh assigned today (18)
                ⚪ Ageing, valid-till expiring (7)
   │
   ▼
LEAD DETAIL     98••••4312  [📞 Call]   ← number never fully displayed
                Customer 360: 2 previous orders, last Skinwise 24 Jun,
                LTV ₹4,700, buyer stage SECOND, RTO history 0
                AI suggestion: "Due for Skinwise Pigmentation refill;
                last objection was price — offer 2-pack bundle"
   │
   ├─► Call connects automatically via masked telephony.
   │   Recording + duration attach to the activity log with no rep action.
   │
   ▼
DISPOSITION     Closed dropdown (no free-text status). Remark in Hinglish
                as natural. Follow-up date mandatory where the disposition
                requires it. Saving is blocked without a disposition —
                this is what permanently kills the 49-variant problem (F4).
   │
   ▼
ORDER ENTRY     SKU picker with live pricing · payment split captured as
                structured prepaid/COD · live credit preview:
                "Order ₹2,000 · Shopify base ₹500 · Your credit ₹1,500
                 (realises on delivery)"
                The rep sees exactly how they are scored, as they sell.
```

### 11.3 Customer lifecycle state machine

```
        ┌──────────┐   lead ingested
        │ PROSPECT │◄──────────────────────────────┐
        └────┬─────┘                               │
             │ first delivered order               │
        ┌────▼─────┐                               │
        │  FIRST   │                               │ win-back
        └────┬─────┘                               │ succeeds
             │ 2nd delivered                       │
        ┌────▼─────┐   3rd    ┌────────┐  4th+   ┌─┴──────┐
        │  SECOND  │─────────►│ THIRD  │────────►│ REPEAT │
        └──────────┘          └────────┘         └───┬────┘
                                                     │ ≥6 orders
                                                 ┌───▼────┐
                                                 │ LOYAL  │
                                                 └───┬────┘
                                                     │
   no order for (usage_days × 2)              ┌──────▼──────┐
   ─────────────────────────────────────────► │  DORMANT    │
                                              └──────┬──────┘
   no response to 3 win-back attempts                │
   ───────────────────────────────────────────► ┌────▼─────┐
                                                │ CHURNED  │
                                                └──────────┘
```

**Repeat-purchase due engine.** Each SKU carries a `usage_days` value (e.g. a 60-capsule pack ≈ 30 days). On delivery, `customer.next_due_date = delivered_date + usage_days − 5`. On that date the customer automatically enters the owning rep's worklist as a repeat-due lead. **This replaces the entire "Delivered Customer Data" manual re-upload workflow with a calculation** — and it is the single highest-ROI automation in the platform, because repeat buyers convert several times better than cold Meta leads and cost nothing to acquire.

### 11.4 Order lifecycle

```
PENDING → CONFIRMED → PROCESSING → DISPATCHED → IN_TRANSIT → OFD → DELIVERED
                                                                │
                            ┌───────────────────────────────────┤
                            ▼                 ▼                 ▼
                          RTO           FAILED_DELIVERY      REFUSED
                            │                 │                 │
                            └────────► RECOVERY LEAD ◄──────────┘
                                    (auto-created, routed to
                                     the owning rep, credited
                                     on successful recovery)

CANCELLED / NO_RESPONSE reachable from PENDING or CONFIRMED.
Every transition writes an immutable order_status_event.
```

---

## 12. Security Architecture

### 12.1 Layered controls

| Layer | Controls |
|---|---|
| **Network** | Cloudflare WAF + DDoS · rate limiting · optional office-IP allowlist for admin routes · TLS 1.3 only · HSTS |
| **Identity** | Argon2id passwords · mandatory TOTP 2FA for admins · JWT (15 min) + rotating refresh · single active session per employee · device fingerprint binding · shift-hours login window · auto-logout after 10 min idle |
| **Authorisation** | RBAC in the API **plus PostgreSQL Row-Level Security** — a forgotten `WHERE` clause still returns nothing |
| **Data at rest** | Full-disk encryption · `pgcrypto` on phone and address columns · encrypted backups with keys held separately |
| **PII exposure** | Default-masked mobile (`98••••4312`) · click-to-call so the full number is never rendered · reveal requires a reason, is quota-limited and logged · addresses masked until an order exists |
| **Anti-exfiltration** | No export endpoint for the employee role · no API tokens · max 50 rows per page · no bulk list view · per-session dynamic watermark (name, ID, timestamp, IP) on every data surface · copy/right-click/print blocking as friction · reveal-velocity anomaly detection with auto-lock |
| **Audit** | Every read of PII, every write, every login, every permission change, every ledger adjustment — immutable, append-only, admin-visible |
| **Backup / DR** | Nightly `pg_dump` + continuous WAL archiving to a separate region · **restore drill executed monthly, not assumed** · RPO 15 min, RTO 4 hours |
| **Application** | Zod validation on every input · parameterised queries only · CSP + HttpOnly SameSite cookies · CSRF tokens · file-upload type/size/content validation · dependency scanning in CI |

### 12.2 The honest position on screenshots

Restating Correction 2 because it will be asked again: **no browser application can block screenshots.** The value delivered instead is that the employee never possesses the asset — click-to-call means a rep can work a full day of calls without ever seeing a complete phone number. Combined with watermarking, reveal quotas and velocity detection, a leak becomes both hard to execute at scale and attributable to an individual. If absolute capture-blocking is a hard requirement, the only real answer is a Windows desktop shell, scoped as an optional Phase 6 item.

### 12.3 Offboarding

Today, an exiting employee walks out with a spreadsheet containing four months of customer PII (F15). In the new system: access is revoked in one click, open leads auto-rebalance to the team with a handover note, the customer data was never on their machine, and every record they viewed in their final 30 days is available for review.

---

## 13. Automation Opportunities, Ranked by Return

| # | Automation | Effort | Impact | Phase |
|---|---|---|---|---|
| 1 | **Repeat-purchase due engine** | Low | **Very High** — converts a manual re-upload into free, high-converting pipeline | 3 |
| 2 | **Auto MIS generation** | Medium | **Very High** — eliminates the manual reporting burden entirely | 4 |
| 3 | **Auto upsell-credit calculation** | Low | **Very High** — recovers the 31% attribution leakage (F7) | 3 |
| 4 | **AI column mapping** | Medium | High — makes the upload workflow genuinely one-click | 2 |
| 5 | **Auto lead assignment** | Medium | High — removes daily manual distribution | 3 |
| 6 | **Rep-specific RTO-adjusted targets** | Low | High — fixes structurally wrong targets (F11) | 4 |
| 7 | **RTO risk scoring pre-dispatch** | High | High — flag high-risk COD orders for prepaid conversion before shipping | 6 |
| 8 | **Hinglish remark normalisation + intent tagging** | Medium | Medium — makes 4 months of remarks searchable and analysable | 4 |
| 9 | **Next-best-product recommendation** | High | Medium — cross-sell from the co-purchase matrix | 6 |
| 10 | **Auto follow-up reminders + escalation** | Low | Medium — untouched leads stop being invisible | 3 |
| 11 | **Courier status sync** | Medium | Medium — replaces manual RTO/NDR uploads if an API is later permitted | 6 |
| 12 | **WhatsApp template send from CRM** | Medium | Medium — logged, templated, no personal WhatsApp | 6 |
| 13 | **Call recording transcription + QA scoring** | High | Medium — objective call-quality audit | 6+ |
| 14 | **Anomaly alerts** (RTO spike, rep inactivity, ingestion failure) | Low | Medium | 4 |

---

## 14. Scalability

Current load is small: ~2,000 rows/day ≈ 7.3 lakh rows/year. The plan is honest about that.

| Horizon | Volume | Action |
|---|---|---|
| Year 1 | <1M rows, 10 users | Single Postgres. No change needed. |
| Year 2–3 | 3–5M rows, 25 users | Table partitioning on `activity` and `order_status_event` by month; read replica for reporting |
| Year 4–5 | 15M+ rows, 50+ users | Move MIS to a read replica; consider columnar extension. Still one Postgres. |
| Only past 50M rows | — | Evaluate ClickHouse. Not before. |

**Functional scalability matters far more than data scalability here.** The design already anticipates: multiple brands under one platform (`brand_id` on the SKU and order tables), multiple teams and shifts, a Team Lead tier, marketplace channels (Amazon/Flipkart) as additional sources, and a future direct-integration path — the ingestion pipeline is source-agnostic, so a Shopify API connector would simply become another producer feeding the same staging tables, with no change downstream.

---

## 15. Implementation Roadmap

Six phases, 26 weeks. **The team is off Google Sheets at Week 10** — everything after that is deepening capability, not restoring it.

### Phase 0 — Foundation & Data Archaeology · Weeks 1–2

| Deliverable | Detail |
|---|---|
| Metric Dictionary sign-off | Every KPI in Section 4 agreed and frozen. Nothing is built until this is signed. |
| Master data build | Full SKU catalogue with product lines, MRP, **Shopify base price**, usage_days, name aliases |
| Employee master | Definitive roster, resolving F13 (7 vs 11 vs 10) |
| Source & disposition masters | 9 sources with validity days; ~15 dispositions with the full alias map |
| Historical extraction | All 9 employee workbooks parsed, profiled, cleansed; duplicate and column-shift report per file |
| Environment | VPS, Coolify, Postgres, Redis, MinIO, CI/CD, staging |

**Exit criteria:** signed metric dictionary; SKU master with base prices; historical extract with a measured data-quality score.

### Phase 1 — Core Platform · Weeks 3–6

Auth, RBAC, RLS, admin shell, employee shell. Customer golden record + identity resolution. Order ledger with line-level products. Activity log. Manual lead entry and manual assignment. Customer 360. **Pilot: one employee (recommend Riya — richest dataset) runs parallel with her sheet for two weeks.**

**Exit criteria:** pilot rep completes a full week entirely in the CRM; her CRM numbers reconcile to her sheet within 1%.

### Phase 2 — Ingestion Engine · Weeks 7–10

All nine upload channels. File fingerprinting and rollback. AI column mapping with template caching. Normalisation rules (phone, date, payment split, encoding, disposition, SKU). Identity resolution and merge queue. Exception review UI. Historical backfill of Apr–Aug 2026.

**Exit criteria:** admin completes a full day's upload across nine channels in under 25 minutes with fewer than 5% exception rows. **Google Sheets frozen to read-only. Full team live.**

### Phase 3 — Intelligence & Attribution · Weeks 11–14

Efficiency scoring engine with shrinkage and source normalisation. Assignment engine with stratification, floors/caps and the exploration arm. Attribution ledger with booked/realised/clawback. Incentive slab engine. Repeat-purchase due engine. Follow-up automation and escalation.

**Exit criteria:** one month's incentive computed by the system and reconciled against a manual calculation; allocation fairness audit produced.

### Phase 4 — MIS Automation · Weeks 15–18

Full report catalogue. Materialised views and refresh scheduling. Executive dashboard. Scheduled push digests (WhatsApp/email). Alerting. Hinglish remark normalisation. Corrected RTO-adjusted targets go live.

**Exit criteria:** `MIS_Driven_Audit_Sheet-2025` is formally retired. No human prepares a report for one full month.

### Phase 5 — Security Hardening · Weeks 19–22

Number masking and click-to-call telephony integration. Watermarking, reveal quotas and logging. Anomaly detection. Full audit trail UI. Penetration test and remediation. DR restore drill. Load test. User training and documentation.

**Exit criteria:** clean pen-test remediation; successful restore drill; all users trained and signed off.

### Phase 6 — Advanced Intelligence · Weeks 23–26

RTO risk model (trained on the historical corpus — this is why Phase 0 backfill matters). Next-best-product. Campaign ROI with spend entry. Pipeline-weighted forecasting. Optional: WhatsApp templated sending, courier status sync, desktop shell.

**Exit criteria:** RTO model demonstrates lift over baseline on a held-out month; forecast accuracy measured against actuals.

### Indicative team

| Role | Phases | Allocation |
|---|---|---|
| Solution Architect / Tech Lead | 0–6 | 50% |
| Backend Engineer (Node/Postgres) | 1–6 | 100% × 2 |
| Frontend Engineer (Next.js) | 1–6 | 100% |
| Data Engineer (ingestion, migration, ML) | 0–3, 6 | 75% |
| QA Engineer | 1–6 | 50% |
| BA / MIS Analyst (metric dictionary, UAT, training) | 0–5 | 50% |

≈ 4.75 FTE across 26 weeks.

---

## 16. Migration & Cutover

```
STEP 1  EXTRACT     All 9 employee workbooks + the MIS pack, snapshotted
                    and version-locked. Nobody edits them during migration.

STEP 2  PROFILE     Per-file data-quality report: duplicate rate, invalid
                    phones, column-shift ranges, disposition variants,
                    unmapped products. Shared with the team — this is also
                    the change-management conversation.

STEP 3  CLEANSE     Deterministic rules first, AI second, human last.
                    Every correction logged with before/after so any
                    historical number remains explainable.

STEP 4  RESOLVE     Build the golden customer record. Expect ~40% of rows
                    to collapse into existing customers, based on the
                    measured 1.71 redundancy factor.

STEP 5  RECONCILE   Rebuild Apr–Aug MIS from the new database and compare
                    against the existing Achieve Report, rep by rep.
                    Differences are EXPECTED — Skinwise moving from ₹0 to
                    ~₹2.5L is the system working correctly. Each variance
                    is explained in writing and signed off. Do not skip
                    this step; it is what buys management's trust.

STEP 6  PARALLEL    Two weeks, one rep (Phase 1) then two weeks, full team
                    (Phase 2). Sheets remain writable but the CRM is
                    authoritative.

STEP 7  FREEZE      Sheets set to read-only, retained for 12 months as an
                    archive. CRM becomes sole system of record.

STEP 8  HYPERCARE   30 days of daily standups, priority bug SLA, and a
                    weekly variance review.
```

**Migration principle:** never overwrite history to make it look tidy. Load it as it was, flag what was wrong, and let the reconciliation report explain the difference. A migration that quietly "fixes" the past destroys the audit trail and the credibility of the new system at the same time.

---

## 17. Acceptance Criteria

The project is complete when every one of these is objectively true:

| # | Criterion | Measure |
|---|---|---|
| 1 | Zero manual MIS preparation | No human touches a report for one full month |
| 2 | Admin daily data workload | < 25 minutes across all nine channels |
| 3 | Duplicate customer rate | < 1% (from a measured 39.3% cross-tab redundancy) |
| 4 | Un-keyable records | < 1% (from 10.9%) |
| 5 | Attribution accuracy | 100% of eligible orders auto-split (from 69%) |
| 6 | Product P&L completeness | Every order line mapped to a product line; Skinwise revenue non-zero and correct |
| 7 | Order count integrity | Integer everywhere; no derived fractional counts |
| 8 | Report latency | Any management question answered in < 15 minutes of data currency |
| 9 | Employee data isolation | Verified by penetration test — zero cross-rep leakage |
| 10 | PII exposure | > 90% of calls completed without any full number being rendered |
| 11 | Metric consistency | Every KPI has exactly one definition; no two screens disagree |
| 12 | Auditability | Any historical number reproducible and traceable to source rows |
| 13 | Recoverability | Monthly restore drill passes; RPO ≤ 15 min, RTO ≤ 4 hours |
| 14 | Adoption | 100% of orders and dispositions entered in the CRM; sheets read-only |

---

## 18. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Employee resistance** — the new system makes performance transparent and unhide-able | **High** | High | Phase the transparency. Launch with self-view only, then team view. Frame the scoreboard around incentive earning, not surveillance. Involve the top rep as pilot and champion. Realised-credit scoring actually *increases* pay for the low-RTO reps — lead with that. |
| Migration reveals historically wrong numbers | High | Medium | Anticipated and planned for in Step 5. Reconciliation report with written variance explanations, signed off before go-live. |
| Admins keep uploading files inconsistently (wrong channel, edited headers) | Medium | Medium | Channel-specific validation; header-signature detection; upload checklist; batch rollback available. |
| Efficiency score gamed (cherry-picking, disposition manipulation) | Medium | High | Delivered-outcome basis · exploration arm as control · data-hygiene component · disposition-change audit · call recordings for spot QA. |
| AI mis-maps a column silently | Low | High | Confidence thresholds, mandatory human confirmation on first use, template caching, column-shift detection, batch rollback. |
| Telephony integration delayed | Medium | Medium | Masking and reveal-logging ship independently in Phase 5; click-to-call is additive, not a dependency. |
| Scope creep | **High** | High | Metric dictionary frozen in Phase 0. Anything new enters a Phase 6+ backlog. |
| Key-person dependency during build | Medium | High | Documented schema, seeded ADRs, no undocumented business logic in code. |
| RTO stays high regardless of software | Medium | High | The platform makes RTO *visible and priced* (delivery-quality weight, prepaid bonus, risk flagging). Fixing it remains a commercial decision, not a technical one — be explicit about this with management. |

---

## 19. Best Practices to Institutionalise

1. **Metric dictionary is a controlled document.** Changing a KPI definition is a change request with an effective date, not a Tuesday edit.
2. **Nothing enters production without a source.** Every number traces to an ingestion batch or a logged user action.
3. **Append-only for anything involving money or status.** Corrections are new entries.
4. **Reference data lives in tables, never in code.** Slabs, weights, validity days, aliases — all admin-editable and versioned.
5. **Master data has one owner.** One named person owns the SKU master. Skinwise showing ₹0 is a master-data failure, not a reporting failure.
6. **Exception-driven operations.** People look at what is wrong, never at what is fine.
7. **Data quality is a published KPI.** A daily score visible to the whole team, with a named owner.
8. **Restore drills monthly.** An untested backup is not a backup.
9. **Quarterly attribution audit.** Re-run a past month through the current rules and confirm the numbers still reproduce.
10. **Every automated decision must be explainable.** A rep who asks "why did I get 12 leads and she got 20?" gets a real answer from the system.

---

## 20. Open Decisions Required From You

These block Phase 0 and need your call before build starts.

| # | Decision | Why it matters |
|---|---|---|
| 1 | **Brand name: Razorveda or Razorveda?** The brief says Razorveda; every data file says Razorveda. | Affects master data, UI, and reporting labels |
| 2 | **Confirm the definitive employee roster.** Brief: 7. Achieve Report: 11 (adds Puja Singh, Mala, Priyanka, Kajal). Scoreboard: 10. | Blocks targets, allocation and incentive setup |
| 3 | **Approve realised-basis scoring.** Incentive on delivery, not booking, with automatic RTO clawback. | The most consequential business-rule change in this document |
| 4 | **Approve the corrected RTO buffer.** Rep-specific instead of a flat 15%. Some targets will rise sharply — Kajal's daily requirement moves from ₹10,511 to ₹15,491. | Affects target-setting conversations with the team |
| 5 | **Approve the exploration arm** (10% of tier-A leads round-robined). Slight short-term efficiency cost for a defensible long-term scoreboard. | Determines whether the score is measurable or self-fulfilling |
| 6 | **Telephony provider** — Exotel / Servetel / Knowlarity, or defer masking to Phase 6. | Number masking is the strongest data-protection control available |
| 7 | **Confirm `usage_days` per SKU.** Needed to drive the repeat-purchase engine. | Highest-ROI automation depends on it |
| 8 | **Shopify base price per SKU** — confirm the ₹899 / ₹849 / ₹949 clusters observed in the data are the live list. | Required for automatic upsell-credit calculation |
| 9 | **Historical depth to migrate** — Apr–Aug 2026 only, or the full 2025 archive (`Combird History` goes back to Sept 2025)? | Affects Phase 0 effort and RTO model training data |
| 10 | **Super Admin owner** — who sits above the three admins? | Governance gap flagged in Section 9.2 |

---

## Appendix A — Evidence Index

| Finding | Source | Verification |
|---|---|---|
| 954 unique mobiles / 1,627 instances / 39.3% cross-tab | `Riya_Chauhan.xlsx`, 14 customer tabs | E.164 normalisation, set intersection across tabs |
| 10.9% un-keyable rows | 236 of 2,159 populated rows | No valid 10-digit number starting 6/7/8/9 |
| 121 payment-mode strings | `Apr–Aug Order Sheet` | Distinct-value count on `Payment Mode` |
| 49 status variants | `updated user 18 aug` | Distinct-value count on `status` |
| Upsell split applied on 36 of 52 | `Apr–Aug Order Sheet`, Shopify Upgrade rows | `Total amount` vs `Final amount` comparison |
| Skinwise ₹2,51,698 across 116 orders vs ₹0 reported | Riya order tabs vs `Achieve Report` | Group-by on `Product` column |
| Required Booking = Per Day Req × 1.15 exactly | `Achieve Report`, all 11 rows | Ratio verified to 4 decimal places |
| Per Day Req Delivery = Value Balance ÷ 12 | `Achieve Report` | Exact for all rows |
| Approx Guess = Per-day Avg × 12 | `Achieve Report` | Exact for all rows |
| 9 IMPORTRANGE links, 72 hardcoded refs, 1,986 formula cells | `MIS_Driven_Audit_Sheet-2025.xlsx` | Formula-string scan across all tabs |
| Fractional order counts | `Achieve Report` | 73.8, 84.8, 68.06, 5.22 |
| Column-shift corruption | `Apr–Aug Order Sheet` | Customer names in `Order Status`, PIN codes in `Client Category`, AWBs in `Data Resource` |

---

*End of blueprint. Section 20 requires your decisions before Phase 0 can begin.*
