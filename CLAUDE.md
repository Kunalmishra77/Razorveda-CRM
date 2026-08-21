# CLAUDE.md — Razorveda Internal CRM & MIS Platform

You are the engineering lead on this project. This file is your standing context. Read it at the
start of every session. If anything here conflicts with a user instruction, ask — do not guess.

---

## 1. What this is

An internal CRM + MIS automation platform for **Razorveda**, an Indian ayurvedic D2C brand that
ships COD orders pan-India and sells through a 7-person tele-sales team.

It replaces nine Google Sheets and a manually-built MIS pack. The CRM is the smaller half of the
problem. The larger half is that there is currently no single trustworthy definition of a customer,
an order, or a salesperson's number.

**Read `docs/08-audit-findings.md` before writing any code.** Every design decision in this repo
exists because of a specific, measured defect in the client's current spreadsheets. If you don't
know why a rule exists, that file has the answer.

---

## 2. Non-negotiables

These are not preferences. Violating any of them is a bug.

1. **AI proposes, deterministic code disposes.**
   LLM calls are allowed for: column mapping on unseen headers, Hinglish remark normalisation,
   product-text → SKU tie-breaking, call summarisation.
   LLM calls are **forbidden** for: computing any money figure, deciding lead assignment,
   calculating any score, changing an order status, writing to the attribution ledger.
   Every number in every report is produced by SQL over immutable facts.

2. **Append-only for money and status.**
   `order_status_event`, `activity`, `lead_assignment`, `attribution_ledger`, `audit_log` are
   INSERT-only. Corrections are new rows, never UPDATEs. This is what makes a March report
   reproducible in December.

3. **Realised, not booked.**
   Employee credit and incentive are earned on **delivery**, not booking. RTO writes an automatic
   clawback entry. Never pay or score on booked value.

4. **Mobile number is the unique business key, NOT the primary key.**
   `customer.customer_id` is a UUID. Phones live in `customer_identifier` (many→one).
   10.9% of the client's historical rows have no valid mobile and still need to exist.

5. **Row-Level Security is the isolation mechanism.**
   "Employees see only their own leads" is enforced by Postgres RLS policies, not by application
   `WHERE` clauses. If a developer forgets a filter, the database must still return nothing.

6. **No auto-assignment.**
   Leads land in an unassigned pool. An admin distributes them via bulk selection.
   The only automatic movement is: untouched 48h → alert, untouched 72h → return to pool.

7. **Two roles only: `ADMIN` and `EMPLOYEE`.**
   Plus one `OWNER` account whose sole extra power is managing admins, targets and incentive rules.
   No team lead tier. No separate exec view. All reports live inside ADMIN.

8. **Reps dial from their own handsets.**
   Full phone numbers are visible to the assigned rep. No telephony integration in scope.
   Protection is detection + attribution: logged copy events, velocity lock, watermarking, no export.

9. **Deliberate simplicity.**
   ~2,000 rows/day. One Postgres, one API, one worker pool.
   **Do not introduce**: microservices, Kafka, Kubernetes, a data warehouse, ClickHouse, GraphQL,
   a monorepo tool, or an ORM abstraction layer over another ORM. If you think you need one, stop
   and ask.

10. **Every metric has exactly one definition.**
    `docs/03-metric-dictionary.md` is the single source of truth. No report computes its own
    arithmetic — reports read certified views. If a metric isn't in the dictionary, it doesn't exist.

---

## 3. Stack (decided — do not re-litigate)

| Layer | Choice |
|---|---|
| Frontend | Next.js 15 App Router, TypeScript, Tailwind, shadcn/ui, TanStack Query + Table |
| Backend | NestJS (Node 20), REST, Zod validation, OpenAPI |
| Database | PostgreSQL 16 with Row-Level Security. **No pgvector** (D-14) — pg_trgm + alias table for SKU matching. |
| Migrations | Drizzle Kit (SQL-first; the checked-in `db/schema.sql` is authoritative) |
| Queue | BullMQ on Redis 7 |
| Files | MinIO (S3-compatible) |
| Auth | JWT (15 min) + rotating refresh, Argon2id, TOTP 2FA for admins |
| AI | Provider-agnostic adapter. Default Gemini Flash. Never on the critical path. |
| Deploy | Docker Compose via Coolify, Mumbai VPS. **Dev/CI use local Postgres in Docker** (D-17); never run destructive tests against the Coolify DB. |
| Tests | Vitest (unit), Supertest (API), Playwright (critical E2E flows only) |

Monorepo layout (npm workspaces, no Turborepo/Nx):

```
apps/
  api/          NestJS
  web/          Next.js
  worker/       BullMQ processors
packages/
  db/           schema, migrations, seed
  shared/       Zod schemas, types, constants shared by api+web
  metrics/      certified SQL views + the metric registry
```

---

## 4. How to work

- **Phase by phase.** `tasks/phase-N-*.md` defines scope, deliverables and exit criteria.
  Do not start phase N+1 until phase N's exit criteria pass.
- **Plan before building.** For any task over ~100 lines, write the plan, show it, wait for a go.
- **Small commits, conventional messages.** `feat(ingestion): parse partial-prepaid payment strings`
- **Write the test with the rule.** Every business rule in `docs/` gets a unit test that cites the
  rule. Attribution, dedupe, payment parsing and metric formulas are non-optional test targets.
- **Fixtures are real.** `fixtures/` contains files with the client's actual messy headers
  (`Phone no`, `ProductDeatil`, `CustomerName`). Ingestion must handle these on day one.
- **Log decisions.** Anything you decide that isn't in `docs/`, append to `docs/09-decisions-log.md`.

### Definition of done for any feature
1. Zod-validated input, typed end to end
2. RLS policy exists and is tested for the tables touched
3. Unit test for the business rule, citing the doc section
4. Audit-log entry written where the action mutates data
5. Error states in the UI say what happened and what to do next
6. No `any`, no unhandled promise, no silent catch

---

## 5. Domain vocabulary

Use these exact terms in code, comments and UI. Do not invent synonyms.

| Term | Meaning |
|---|---|
| **Lead** | One instance of a customer arriving from a source. A customer can have many leads over time. |
| **Pool** | Leads committed but not yet assigned to anyone. |
| **Disposition** | The outcome of a contact attempt. Closed vocabulary — see `db/seed/dispositions.csv`. |
| **CD / ND** | Connected Data / Not-connected Data. Distinct leads ever connected vs never. |
| **Fq** | Frequency — contact attempts against one lead. |
| **Buyer Fq** | Number of delivered orders by a customer. |
| **Company Base Value** | Order value already committed before any rep intervention (Shopify cart, campaign order). |
| **Employee Credited Value** | `final_value − company_base_value`, per the source's attribution rule. |
| **Booked** | Order created. Provisional. |
| **Realised** | Order delivered. The only basis for score and incentive. |
| **Clawback** | Reversal written when a delivered order later returns. |
| **RTO** | Return To Origin — undelivered parcel returned to the warehouse. |
| **NDR** | Non-Delivery Report — failed delivery attempt, may still be recovered. |
| **Data Valid Till** | A lead's shelf life. Source-configured. Leads decay. |

Product lines: `Breast Care`, `Skinwise`, `Slimming Care`, `Intimate Care`, `Face Care`,
`Hair Care`, `Customisation`.

Lead sources: `SHOPIFY`, `META_ADS`, `WEB_WHATSAPP`, `ADD_TO_CART`, `WEB_CALL`, `WA_CAMPAIGN`,
`DELIVERED_REPEAT`, `RTO_RECOVERY`, `NC_REFUSED`.

---

## 6. Things that will bite you

Learned from the client's real data. Handle all of these in ingestion from day one.

- Phone fields contain `9876543210`, `+919876543210`, `09876543210`, `9876543210.0`, and literal
  text like `code`. Normalise to 10 digits starting 6/7/8/9, else park the row.
- Names contain emoji and decorative unicode: `Aditi ❤️`, `【G】【u】【p】【t】【a】❣️`.
- Devanagari arrives mojibake'd: `à¤®à¥‹à¤¹à¤¨` is `मोहन` read as Latin-1. Repair, don't discard.
- Payment mode is free text with 121 variants: `300 prepaid & 2200 cod`, `849 webpay & 1650 cod`,
  and misspellings `preapid`, `prepiad`, `preapaid`. Parse into `prepaid_amount` + `cod_amount`.
- Dispositions have 49 spellings of ~12 outcomes: `ringing`/`rinigng`/`ring`/`ring cut`,
  `bsy call cut`/`bsy cal cut`. Use the alias table.
- **Column shift is real.** Customer names appear inside the `Order Status` column, PIN codes inside
  `Client Category`, AWB numbers inside `Data Resource`. If >20% of a column fails its type check,
  fail the whole batch loudly.
- Dates arrive as both `15-06-26` and `2026-12-06` meaning the same thing. Resolve by source rule.
- The same customer appears in up to 8 different tabs. Dedupe is not optional.

---

## 7. What NOT to build

- Auto-assignment / allocation engine (explicitly removed by the client)
- Click-to-call, call recording, telephony (Phase 6 optional, not now)
- Direct Shopify/Meta/WhatsApp API integrations (client wants upload-only)
- Team Lead role, executive portal
- Mobile native apps
- Multi-tenancy (single company)
- Any export capability for the EMPLOYEE role

---

## 7b. Corrections applied 20 Aug 2026

A Phase 0 audit found 15 defects in the v1 documents. They are fixed in the files, and the
reasoning is in `docs/09-decisions-log.md` under D-13 … D-21 (and D-22 … D-27 for the second pass). Four are worth carrying in your head:

1. **Realised can exceed Booked in a period.** The invariant is per order. Incentive is cash basis
   (delivered-in-period). Metric dictionary §6. The old "impossible" claim was wrong.
2. **The sheet's `Final amount` is NOT `final_value`.** It is the manual employee credit. The words
   are inverted. `final_value` comes from `Total amount`. See docs/06 money mapping. Getting this
   wrong corrupts every historical order.
3. **`customer_identifier` must have an RLS policy.** It holds every phone number in the business.
   It was missing from both the doc and the SQL. Fixed — never remove it.
4. **`app_role` owns nothing.** Owners bypass RLS. Any isolation test must `SET ROLE app_role` first
   or it proves nothing.

### Second correction pass (21 Aug) — six more, three were mine

5. **Never compare `current_setting('app.user_id')` to an `employee_id`.** `app.user_id` is an
   `app_user.user_id`; `lead.assigned_to` is an `employee.employee_id`. Use `current_employee_id()`
   and `is_admin()`. The raw comparison fails closed — it looks like isolation and hides a rep's
   own rows.
6. **Exception:** a policy *on the `employee` table* must use `current_user_id()`, because
   `current_employee_id()` selects from `employee` and would recurse under FORCE RLS.
7. **Decision IDs are unique.** The audit-response block is D-13…D-21. Do not restart numbering.
8. **`ALTER DEFAULT PRIVILEGES` is set** so future migrations do not create tables `app_role`
   cannot read. Do not remove it.

---

## 8. Start here

If this is your first session, open `prompts/00-kickoff.md`.
