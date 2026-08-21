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

---

# Session log — 2026-08-21 · Phase 0 (part 1)

Scaffold, `packages/shared`, `packages/metrics`. Decisions taken that were not already
documented, per CLAUDE.md section 4 ("Log decisions").

| ID | Decision | Rationale |
|---|---|---|
| **D-28** | Line endings forced to LF via `.gitattributes`. | Ingestion hashes raw file bytes (docs/06 stage 1). CRLF rewriting on checkout would give the same fixture a different SHA-256 on Windows and in Linux CI, making duplicate-file detection platform-dependent. The v3 zip shipped `delivered_data_sample.csv` with CRLF, so this was already live. |
| **D-29** | Money crosses the wire as a **decimal string**, never a JS number. | `numeric(12,2)` in Postgres; docs/02 says "Never float." A JSON number is an IEEE double, so parsing a rupee value into one reintroduces exactly the drift the schema forbids. `moneySchema` enforces the string form. |
| **D-30** | Postgres enums get the **same parity guardrail** as the metric dictionary. `packages/shared/test/enum-parity.test.ts` parses `db/schema.sql` and fails on any drift. | Not requested, but the failure mode is identical to the one D-20 and docs/03 rule 3 exist to prevent: a value added in SQL that silently never reaches the API and web. 15 enums, 18 assertions. |
| **D-31** | A metric's identity in the registry is **(section, name)**, not name alone. | "Upsell Index" legitimately appears in both docs/03 section 4 (attribution metric) and section 5 (EES score component). Keying on name alone would have made one of them invisible to the parity test. |
| **D-32** | The parity test **guards the guard**: it asserts the doc parser found >20 metrics across all five sections. | A parser that silently matches nothing makes every other assertion in the file pass vacuously. That is the classic way a guardrail rots without anyone noticing. |
| **D-33** | Local `docker-compose.yml` runs Postgres as `razorveda_migrator`, not `postgres`. | Implements D-21 in dev, not just in prod. The owner role and the app role must be different locally too, or the isolation test proves nothing on the machine where it is actually run. |

## Raised this session, not decided

| # | Observation | Status |
|---|---|---|
| **N7** | `docs/03-metric-dictionary.md` has **two headings numbered `## 6.`** — "6. Incentive" (line 114) and "6. Period basis" (line 133). The second is presumably section 7. | Flagged, not fixed. Harmless today because neither is a metric table, but the parity parser keys section context off the heading number, so a metric table added under the second `## 6.` would be filed under section 6 and mismatch the registry. Client/author call. |

---

# Decisions taken 2026-08-21 — third pass

| ID | Decision | Rationale |
|---|---|---|
| **D-34** | **O-08 resolved.** Sundays non-working, confirmed by reproducing the client's forward denominator exactly (`153,769.39 / 12 = 12,814.11583`, matching the sheet to five decimals). **Both** denominators come from `working_calendar` — no hand-typed day counts anywhere. Festival holidays seed **empty**, admin-toggleable, provisional until the client confirms. See metric dictionary section 8. | The forward rule was verifiable from the client's own numbers, so Sundays-off is confirmed by data rather than assumed. The backward rule was not reproducible by any calendar — see F17. |
| **D-35** | Section numbers in `docs/03` are **unique and sequential**, asserted by its own test (`packages/metrics/test/section-numbering.test.ts`) with its own failure message. The parity parser should eventually key off a stable slug, not the digit. | N7. A duplicate number does not fail loudly — it files a metric under the wrong section, and parity then reports a *missing metric*, sending the next person to edit the registry when the defect is a heading. The separate test fails first and names the document, the line numbers and the fix. |
| **D-36** | Corrections ship as **instructions or file patches over an existing tree**, never a folder replacement. | A folder replacement destroyed `.git` and `.gitattributes` once already, silently. Nothing in the working tree should be able to disappear without a commit recording it. |
| **D-37** | A markdown table in `docs/03` whose first header cell is `Metric` or `Component` **is** a metric-definition table, by parser contract. Denominator rules, levers, bases and other prose tables must use a different header or a code block. | Caught immediately by the parity test while applying D-34: rendering the section 8 denominators as a `\| Metric \|` table added three phantom metrics (39 -> 42). The parser was right; the formatting was wrong. Documented so the next person renders it correctly the first time. |

## New finding

| ID | Finding | Evidence | Design response |
|---|---|---|---|
| **F17** | **`Per Day Avg Value` divides by a hand-typed 11 where the calendar gives 14.** Every rep's "Approx Guess Rest of Month" is overstated by roughly a third. | Working days 1–17 Aug 2026 with Sundays off is 14. No calendar rule produces 11. Nikita: `146,230.61 / 11 = 13,293.69 -> x12 = 1,59,524` against the calendar-correct `146,230.61 / 14 = 10,445.04 -> x12 = 1,25,340`. A **₹34,184 over-forecast on one rep.** | Both denominators read `working_calendar` (D-34). This is the mechanism behind the over-forecasting recorded in F16 — the v1 audit blamed straight-line extrapolation, which was true but smaller than the wrong divisor. Carry into the Phase 2 variance report citing metric dictionary section 8. |

## Raised this session, not decided

| # | Question | Status |
|---|---|---|
| **N8** | Are `Per Day Avg Value` and `Approx Guess Rest of Month` **certified metrics** that belong in docs/03 section 3 with registry entries, or legacy formulas superseded by `Forecast`? Section 8 now specifies how to compute both, but neither is defined in section 3 and neither is in the registry. Under docs/03 rule 1 ("if a metric is not in this file, it does not exist and no screen may display it") they currently cannot be displayed. | Flagged, not decided. `Forecast` (section 3) is their stated replacement per F16, so the honest reading is that they are legacy — but section 8 gives them live computation rules, which reads as though they survive. Needs one line either way. |

---

# Decisions taken 2026-08-21 — fourth pass

| ID | Decision | Rationale |
|---|---|---|
| **D-38** | **N8 resolved by splitting.** `Per Day Avg Value` is registered **live**; `Approx Guess Rest of Month` is registered **legacy**; `Forecast` is redefined as the live replacement. `MetricDef` gains `status: 'live' \| 'legacy'`. | They looked like one question because they sit in the same sheet column group. One is a sound run-rate whose only defect was the hand-typed divisor; the other is the straight-line formula F16 exists to replace. A legacy metric is **recorded, not omitted** — an "it is documented but not a metric" category outside the dictionary is how the dictionary starts rotting. Rule 1 holds unbroken. |
| **D-39** | **Exact arithmetic, rounded once at render.** No metric consumes another metric's displayed form. docs/03 section 9. | The hand-typed `11` (F17, ₹34,184) and the multiplied-display `10,445.04` (₹1) are the same defect at different magnitudes: a rounded intermediate escaping into a computed result. Enforced as two lint assertions on registry view SQL, plus a third that records they are inert until Phase 4 views land so they cannot rot into decoration. |
| **D-40** | **`_local_dev_marker` sentinel.** `migrate --fresh` creates it; `seed` and `migrate --fresh` refuse without it. Host check retained alongside. | The Tailscale form of the production URL is `127.0.0.1:55432` — loopback — so host-matching is decorative against the person most likely to trip it. The marker is independent of the URL: production has tables and no marker, so it fails closed. Two cheap checks, neither sufficient alone. Residual gap stated in source and README: this guards a stray `DATABASE_URL` during a seed, not a determined operator. |
| **D-41** | **No forced-reset column.** The un-nominated OWNER account is seeded `is_locked = true` with `locked_reason` naming O-07. | `app_user` has no such column, and adding one to hold an open business decision is worse than using the lock that already exists. docs/05 test 8 already requires that a locked account cannot authenticate until an admin unlocks it — exactly the semantics wanted, and stronger. Claiming the account is set-email plus unlock. **Do not "add the missing flag" later.** |
| **D-42** | **Argon2id parameters pinned in `packages/shared`** (m=19456, t=2, p=1 — OWASP minimums), asserted against a real hash in `packages/db`. | A library swap must not be able to change the cost factor quietly. `@node-rs/argon2` loaded its prebuilt binary with no native build (43 ms, `$argon2id$` confirmed), so no fallback was needed — but the assertion is what makes that durable. Never bcrypt, never a silent fallback. |

## Raised this session, not decided

| # | Question | Status |
|---|---|---|
| **N9** | **`stage_probability` has no defined stage vocabulary.** `Forecast` multiplies `open_pipeline × stage_probability`, and the probabilities must come from a seeded table rather than constants. But no document defines what a *pipeline stage* is. `buyer_stage` is customer lifecycle (PROSPECT…CHURNED); `disposition` is contact outcome; neither is a pipeline stage with a conversion probability. | **Flagged, table not created.** Seeding one would mean inventing a stage vocabulary, and CLAUDE.md §4 forbids guessing a business rule. The registry records that probabilities are data, not constants, so nothing is hardcoded in the meantime. Needs a stage list before the table can be seeded from `expected_conversion_rate`. Forecast is Phase 4/6, so this is not urgent. |
| **N10** | **The revised `Forecast` drops `seasonality_index`.** The previous definition was `(open_pipeline × stage_probability) + (run_rate × remaining_days × seasonality_index)`, RTO-adjusted. F16's design response in docs/08 says "pipeline-weighted forecast **with seasonality** and RTO adjustment", and docs/10 Part 4.7 repeats it. The new formula has no seasonality term. | **Flagged, implemented as specified.** Deliberate simplification or an oversight? A pan-India ayurvedic D2C business plausibly has festival seasonality, which is also why O-08's holiday list matters. One line either way; docs/08 F16 should be amended if the drop is intended. |
