# 09 — Decisions Log

Append-only. Claude Code must add an entry for any decision it makes that is not already documented.

---

## Decided

| # | Decision | Rationale | Date |
|---|---|---|---|
| D-01 | Surrogate UUID PK for customer; phone is a unique business key in `customer_identifier` | 10.9% of historical rows have no valid phone; alt numbers, shared numbers and number changes all occur in the real data | 2026-08-20 |
| D-02 | No auto-assignment. Admin bulk-assigns from a pool | Client decision | 2026-08-20 |
| D-03 | Reps dial from own handsets; no telephony integration | Client decision. Consequence: dial/connect/connectivity are self-reported | 2026-08-20 |
| D-04 | Two functional roles (ADMIN, EMPLOYEE) + one OWNER account | Client decision + governance gap noted in docs/05 | 2026-08-20 |
| D-05 | Incentive and score on **realised** (delivered) value with automatic clawback | Fixes findings F7, F10, F11 simultaneously | 2026-08-20 |
| D-06 | `Required Booking = Per Day Req ÷ (1 − rep 90d RTO)` replaces flat ×1.15 | Finding F11 — current formula understates Kajal's requirement by 47% | 2026-08-20 |
| D-07 | Product revenue allocated at `order_line` grain | Finding F8 — Skinwise reports ₹0 against ₹2.5L actual | 2026-08-20 |
| D-08 | Postgres RLS as the isolation mechanism, not application filters | ADR-001 | 2026-08-20 |
| D-09 | Append-only tables for money and status | ADR-002 — makes historical reports reproducible | 2026-08-20 |
| D-10 | Materialised views, no data warehouse | ADR-003 — 730K rows/year does not justify one | 2026-08-20 |
| D-11 | AI never computes a number, decides an assignment, or writes to the ledger | An LLM that occasionally hallucinates a total is worse than the current spreadsheet | 2026-08-20 |
| D-12 | Column-shift detector fails the whole batch at >20% type failure | Finding F3 — silent corruption went unnoticed for months | 2026-08-20 |

---

## Open — blocks Phase 0 / Phase 1

| # | Question | Blocks | Owner |
|---|---|---|---|
| O-01 | **Definitive employee roster.** Brief says 7; Achieve Report has 11 (adds Puja Singh, Mala, Priyanka, Kajal); Scoreboard has 10. `db/seed/employees.csv` is a best guess and must be confirmed. | Targets, assignment, incentive | Client |
| O-02 | **Confirm Shopify base price per SKU.** ₹899 / ₹849 / ₹949 clusters were reverse-engineered from order data. `db/seed/skus.csv` values are inferred. | Automatic upsell credit (Phase 3) | Client |
| O-03 | **Confirm `usage_days` per SKU.** Drives the repeat-purchase engine. Current values are estimates. | Repeat-due engine (Phase 3) | Client |
| O-04 | **Approve realised-basis scoring** (D-05). Changes how everyone is paid. | Phase 3 | Client |
| O-05 | **Approve rep-specific RTO buffers** (D-06). Some targets rise sharply. | Phase 4 | Client |
| O-06 | **Historical depth to migrate** — Apr–Aug 2026 only, or the full archive back to Sept 2025? | Phase 0 effort, Phase 6 model training | Client |
| O-07 | **Nominate the OWNER account.** | Phase 1 auth | Client |
| O-08 | **Working calendar** — which days are working days? Affects every "per day required" number. | Phase 0 seed | Client |
| O-09 | **Incentive slab values** — the defaults in docs/03 section 6 are proposals, not the client's actual scheme. | Phase 3 | Client |
| O-10 | **Cloud dialler in Phase 6** — yes / no / decide later. Determines whether dial metrics ever become real. | Phase 6 | Client |

---

## Session log

*(Claude Code appends here each session: date, phase, decisions made, questions raised.)*

---

# Decisions taken 20 Aug 2026 — in response to the Phase 0 kickoff audit

The engineering audit raised 15 findings (B1–B15). Verified against the files; the following are
now **decided**. Anything not listed here remains open.

*Numbered D-13 onward — the block above already uses D-01…D-12. (defect N4)*

| ID | Decision | Rationale |
|---|---|---|
| **D-13** | Booked/Realised invariant is **per order**, not per period. Incentive on **cash basis** (delivered-in-period). Cohort basis available as a secondary report. | B4 was correct and the v1 draft was wrong. See metric dictionary §6. The F10 "impossible" claim about Divya is withdrawn — it is most likely a cohort artefact. |
| **D-14** | **pgvector removed from v1.** SKU resolution uses exact → alias table → `pg_trgm` similarity → human queue. | 20 SKUs do not need embeddings, and it removes a Coolify blocker. Revisit above ~500 SKUs. |
| **D-15** | **One customer per mobile number.** `customer.primary_phone` stays UNIQUE. A different recipient name on an order is stored on the order, not as a second customer. | B9. Families sharing a number is an *ordering* fact, not an *identity* fact. Two customer records on one number would break dedupe and the <1% duplicate target. The surrogate PK is justified by blank phones, alt numbers and number changes — not by shared numbers. |
| **D-16** | `employee_credit_percent` stays 100 for RTO_RECOVERY and NC_REFUSED, **flagged as O-11** for the client. | B11. Recovering a dead order is real work, so full credit is defensible — but it is a money rule and the client has never been asked. |
| **D-17** | Dev and CI run against **local Postgres in Docker**. Coolify is the deploy target only. | Destructive schema and RLS tests must never touch the only live database. Requires Docker Desktop. |
| **D-18** | Fixtures are corrected in **Phase 0**, not Phase 2. | Phase 2 mandates writing tests from fixtures. Wrong fixtures produce tests that encode wrong expectations. |
| **D-19** | Seed roster keeps 9 employees including Megha (ON_LEAVE) and Shweta, marked provisional. | Megha powers the "rep on leave" assignment warning. O-01 stays open. |
| **D-20** | Alias test asserts **every seeded alias resolves**, plus a separate documented list of the 49 observed raw strings. | B14. "All 49 variants" was untestable as written. |
| **D-21** | The app connects as `app_role`, which **owns nothing**. CI fails if the API's `DATABASE_URL` role owns any table in `public`. | B3. Owners bypass RLS; a test run as owner proves nothing. |

## New open decisions for the client

| ID | Question | Blocks |
|---|---|---|
| **O-11** | Should RTO / NC recovery earn 100% employee credit, or a reduced percentage? | Phase 3 |
| **O-12** | Confirm the per-target-field type contracts for column-shift detection (B10) — which fields are strictly typed (pincode, AWB, enum, date, numeric) so the detector watches more than one column. | Phase 2 |

## Second correction pass — 21 Aug 2026 (defects N1–N6)

| ID | Decision |
|---|---|
| **D-22** | All RLS policies go through `current_employee_id()` / `is_admin()`. Raw `current_setting('app.user_id')` comparisons against an `employee_id` are a bug (N1). CI greps for them. |
| **D-23** | A policy on the `employee` table uses `current_user_id()`, never `current_employee_id()` — the latter selects from `employee` and recurses under FORCE RLS. |
| **D-24** | Settled decisions beat stale prose. Where a doc contradicts a logged decision, the decision wins and the doc gets corrected in the same commit (N2, N3). |
| **D-25** | Decision IDs are globally unique and never reused. Audit-response block is D-13…D-21; this block is D-22 onward (N4). |
| **D-26** | `ALTER DEFAULT PRIVILEGES` is required so future migrations inherit `app_role` grants (N5). |
| **D-27** | All seven master tables get `FORCE ROW LEVEL SECURITY` (N6). |

| ID | Open question |
|---|---|
| **O-13** | `employee.monthly_target` is column-level, which RLS cannot hide. v1 filters it in the API for non-admins. Do we want hard enforcement via an admin-only view and a column REVOKE? |
