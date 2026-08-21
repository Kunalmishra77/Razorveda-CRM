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

---

# Decisions taken 2026-08-21 — fifth pass

| ID | Decision | Rationale |
|---|---|---|
| **D-43** | **N9 resolved: the stage IS the disposition.** No new pipeline-stage vocabulary. `stage_probability(disposition)` = delivered orders ÷ leads that passed through that disposition, over a rolling window, materialised nightly from the order ledger. Below **30** leads, fall back to `lead_source.expected_conversion_rate`. Every forecast output carries `forecast_weight_source`. | A parallel vocabulary would give the system two ways to say where a lead sits. The disposition table has been the stage list all along. The 30-lead floor is the same shrinkage instinct as the EES score's k=30 — a rate computed from nine leads is noise wearing a decimal point. No new table, no invented numbers, self-correcting as history accumulates. docs/03 §10.1. |
| **D-44** | **N10 resolved: keep the term, neutralise the value.** `seasonality_index` stays in the Forecast formula and is seeded **1.0000, provisional, for all twelve months** in a new `seasonality_index` table. Revisit at 18+ months of history, or sooner if O-06 releases the 2025 archive. No screen may describe the forecast as seasonally adjusted while this holds. | Dropping it silently was wrong — F16 calls for seasonality. But it cannot be fitted on five months (Apr–Aug): an index fitted on that little data looks principled while encoding noise, which is worse than none. **A formula silently missing a term is far harder to find later than one carrying an obvious 1.0.** Values live in a seeded, admin-editable table, never as a constant. docs/03 §10.2. |
| **D-45** | New master tables join the master-data RLS loop (`ENABLE` + `FORCE`, read-all, admin-write) as a matter of course, and the coverage check is re-run after any schema change. | `seasonality_index` was added this session. All 26 tables carry RLS; the count is verified, not assumed. |

---

# Session log — 2026-08-21 · Phase 1 (part 1: auth + RLS)

| ID | Decision | Tier | Rationale |
|---|---|---|---|
| **D-46** | The RLS transaction issues `SET LOCAL ROLE app_role` **before** setting any value, and binds `app.user_id` / `app.user_role` via `set_config(..., true)` rather than `SET LOCAL <name> = '<literal>'`. | 1 | Two reasons. Owners bypass RLS, so switching role inside the transaction means a misconfigured `DATABASE_URL_APP` becomes a permissions error rather than a silent data leak. And `SET LOCAL` takes no bind parameters, so the literal form would mean interpolating a value into SQL on the authentication path; `set_config` is the parameterised equivalent. |
| **D-47** | The eight isolation tests live in a **separate suite** (`npm run test:rls`) that **fails, never skips**, when no database is present. | 1 | A suite that skips on a missing database turns "we never ran it" into "it passed". For RLS — the one thing in this system that fails silently — that is the worst possible default. Verified: with no `DATABASE_URL` the runner exits 1. |
| **D-48** | Isolation test 3 asserts a rep **can** read their own customers' phone numbers, not only that they cannot read others'. | 1 | N1 was a fail-*closed* bug: the policies compared an `employee_id` to a `user_id`, so every rep saw zero rows including their own. A test that only checks for absence would have passed while Lead Detail was broken. |
| **D-49** | Isolation test 8 runs the same query **as the table owner, without `SET ROLE`**, and asserts the count is HIGHER. | 1 | It is the test that stops the other seven lying. If those counts are ever equal, either isolation is broken or the seed has no cross-rep data — both worth failing for. |
| **D-50** | TOTP implemented on `node:crypto` and verified against the **published RFC 4226 and RFC 6238 test vectors**, rather than taking a dependency. | 2 | TOTP is HMAC plus a truncation rule, not a primitive being invented, and the RFC publishes official vectors — so this can be checked against the specification instead of trusted. Rejected `otplib`: perfectly reasonable, and swapping is small since the surface is two functions. 23 assertions, all RFC vectors. |
| **D-51** | Login check order is fixed: **password → locked → shift → TOTP**, and it is a security property, not style. | 2 | Every reason after the first is more specific than "no". Revealing one before the password is verified turns the login form into an account-enumeration oracle — which addresses exist, which are locked, who works which shift. Asserted: a locked account with a wrong password reports only `INVALID_CREDENTIALS` and never leaks the lock reason. |
| **D-52** | An ADMIN or OWNER with **no enrolled TOTP secret is refused**, not waved through. | 2 | The dangerous branch is mandatory 2FA that silently becomes optional because enrolment was never finished. Fails safe and is cheap to reverse. Rejected: allowing first-login enrolment, which would leave a window where an admin password alone is sufficient. |
| **D-53** | `isWithinShift` supports a window crossing midnight. | 2 | The seeded 10:00–20:00 does not need it, but a night shift would, and discovering that by locking a team out is an expensive way to find the bug. |

| ID | Decision | Tier | Rationale |
|---|---|---|---|
| **D-54** | Refresh rotation carries **reuse detection**: presenting a superseded token revokes the whole session. Expiry is checked before reuse. | 2 | Rotation alone is not a control — a thief and the real user would take turns rotating. Detecting a stale token makes rotation a tripwire: a stolen token buys one use. Expiry first, so an ordinary lapsed login is not reported as an attack; training people to ignore security events is its own vulnerability. |
| **D-55** | Single active session enforced for **EMPLOYEE only**. ADMIN and OWNER exempt. | 2 | Three admins share upload and review duties across machines; a one-device rule there would be worked around rather than followed. Reps are the exfiltration surface the control exists for (docs/05). |
| **D-56** | Identity resolution does **not** compute name similarity. `pg_trgm` scores are passed in; this module is the pure decision over scored candidates. | 1 | Reimplementing trigram scoring in TypeScript would create a second source of truth for the most consequential number in dedupe, and the two would drift the first time either changed. No drift is possible by construction. |
| **D-57** | A fuzzy identity match requires **both** name ≥0.85 **and** a matching pincode. Name alone never merges. | 1 | docs/06 §4 states both. Worth restating because the client's data is full of single-word names — "Aarti" in Meerut and "Aarti" in Mysuru are different people, and silently merging two real customers is far more expensive to undo than reviewing 26 rows. |
| **D-58** | Money arithmetic uses exact scaled-integer BigInt internally, never JS floats; `splitMoney` uses **largest-remainder** so parts always re-sum to the whole. | 1 | Implements D-29 and D-39. Rounding each share independently loses paise: ₹1,000 across 33.33/33.33/33.34 gives ₹999.90. An attribution ledger that does not add up is worse than one a paisa unfair to one rep. Scaling to integers is a computation detail — nothing is stored or transmitted as paise (docs/02). |
| **D-59** | `company_base_value` **throws** when a non-upsell line has no `shopify_base_price`, rather than defaulting to zero. | 2 | Defaulting to zero credits the rep the entire order value — F7 reproduced faithfully in code. Failing loudly routes the row to the exception queue where a human decides. Expect this to fire on real data until O-02 confirms the base prices; that is the intended behaviour, not a defect. |
| **D-60** | A base above the final value **clamps** the credit to zero rather than paying negative. | 2 | The rep discounted below the committed cart. A clawback is a ledger event, not an arithmetic accident. `ruleApplied` records `_CLAMPED` so the case is visible in the ledger rather than indistinguishable from a zero-credit order. |
| **D-61** | Order-status transitions are guarded by an explicit table; NDR states are **not** terminal. | 2 | docs/ specifies the statuses and the clawback rule but not the graph, so this encodes the courier lifecycle a pan-India COD business actually has. FAILED_DELIVERY, NO_RESPONSE and REFUSED can all return to OFD, which is the whole reason the RTO_RECOVERY and NC_REFUSED channels exist. |
| **D-62** | `ledgerEffectOf` returns `NONE` for any **illegal** transition, and a clawback fires only on a transition **out of DELIVERED**. | 1 | Found by a test, not by review: the first version keyed purely on the destination, so an illegal `PENDING -> DELIVERED` still returned `REALISED_CREDIT`. A caller computing the effect before asserting the transition would have written money against an order that was never dispatched — into an append-only ledger, so uncorrectable by edit. The clawback rule matters equally: an order that goes straight to RTO never realised, so reversing it would double-count the loss. |

| ID | Decision | Tier | Rationale |
|---|---|---|---|
| **D-63** | `connected` is true only when the rep ticks it **and** the disposition's `counts_as_connect` agrees. | 1 | "Ringing" with connected ticked is a mis-click, not a conversation. The disposition is the closed vocabulary (F4); the checkbox is self-reported (D-03). Trusting the checkbox alone would inflate CD, which the client reads daily. |
| **D-64** | `NOTE` and `SYSTEM` activities do **not** increment `contact_attempts` and do not require a disposition. | 1 | Fq is a real metric in the client's MIS, not a row counter. A note about a customer is not a contact attempt. |
| **D-65** | A terminal disposition clears `next_followup_at` and stamps `closed_at`, and a closed lead leaves the worklist entirely. | 2 | 174 client leads sat with a rep for a full validity window producing nothing. A dead lead that keeps claiming the top of the worklist is how that happens. `closed_at` is set once and never moved by a later activity. |
| **D-66** | `remark_raw` is stored byte-for-byte apart from trailing whitespace. No case change, no spell correction, no transliteration. | 1 | docs/07 §4. Four months of Hinglish remarks are the raw material for Phase 6 objection intelligence; normalising on the way in destroys the evidence and leaves only a guess at what was meant. |
| **D-67** | Pre-assign warnings are ordered **destination-rep first**, then leads. | 2 | An admin reads the first line and little else. "Megha is on leave" is more actionable than "4 of these are past validity". |
| **D-68** | The Suggested Split's new-joiner yield floor is **relative to the team median (25%)**, not an absolute constant. | 2 | Found by a test. The first version floored yield at 0.1, which against a team yielding ₹800/lead is numerically indistinguishable from zero — so a new joiner was proposed nothing, never built a record, and stayed at nothing. Only a relative floor self-corrects. Rejected: excluding zero-yield reps entirely, which would force an override on every assignment involving a new joiner. |
| **D-69** | The Suggested Split uses largest-remainder and **stops short rather than exceeding a WIP cap**. | 2 | An admin told to assign 59 of 60 stops trusting the button. Where the team is genuinely capped the shortfall must be visible, not hidden by pushing reps past their caps. |
| **D-70** | Worklist bands are evaluated in priority order and the **first match wins**; a lead that is several things at once is ranked by its most urgent truth. | 1 | docs/07 §4 fixes the order and forbids user sorting. A repeat-due customer whose follow-up is also overdue belongs in Overdue: a promise the rep made beats a system-generated nudge. |
| **D-71** | A follow-up promised earlier **today** stays in "Due today", not "Overdue". | 2 | A 09:00 promise at 11:00 is still today's work. Promoting it mid-morning would make the top of the list churn all day, and the band is a plan for the day rather than a stopwatch. |
| **D-72** | Ageing leads sort by **closest to validity expiry**, not by age. | 2 | Leads decay against Data Valid Till, which most CRMs never model. A lead expiring tomorrow deserves the last chance ahead of an older one with three weeks left. |

| ID | Decision | Tier | Rationale |
|---|---|---|---|
| **D-73** | The table selection model lives in `packages/shared` as pure functions, not inside the React component, so **exit criterion 3 becomes a test** instead of "manual check, documented". | 1 | Applying the standing default: if something is untestable as specified, make it testable and say what changed. A manual check is performed once and assumed forever. 20 assertions now cover shift-click, including the range-deselect case nobody thinks to ask for. |
| **D-74** | "Select all in filter" stores **exclusions**, and the client sends `{mode: 'FILTER', excludeLeadIds}` rather than a list of ids. The server **re-runs the filter inside the assigning transaction**. | 1 | The browser holds 25 of 486 rows, so it cannot send the ids. Re-running server-side also means the set assigned is the set that exists at commit time, not a snapshot the admin loaded ten minutes ago — an ingestion batch may have added rows and another admin may have taken some. The returned count reports what actually happened. |
| **D-75** | Bulk assign uses **set-based statements** (`FROM unnest($1::uuid[])`), not a loop, and runs in one transaction. | 1 | Exit criterion 2 is 200 leads under 2 seconds. One round trip regardless of batch size makes that comfortable rather than marginal, and one transaction means a partial assignment cannot exist. The service returns both the leads moved and the `lead_assignment` rows written so a caller can assert they match — if those diverge, the append-only history no longer explains the current state. |
| **D-76** | `assigned_to IS NULL` is hardcoded into the pool query and is not a caller-supplied filter. | 1 | The absence of an assignment IS the pool (docs/02). Allowing a caller to drop that clause would let a bulk assign silently steal leads another rep is already working. Transfers are a separate, explicit action with their own `assign_method`. |
| **D-77** | The API loads the `disposition` rule from the master table and ignores any client claim about whether a follow-up is required. | 1 | Exit criterion 4 requires the API to reject, not only the UI to block. A closed vocabulary enforced in the browser is a free-text field with a nicer widget — which is what F4's 49 spellings look like after four months. |
| **D-78** | `DATABASE_URL_APP` has **no fallback** to `DATABASE_URL`; the API refuses to start without it. | 1 | A fallback would be the single worst failure mode in this codebase: connecting as the migration user disables every RLS policy while leaving all eight isolation tests green, because those tests `SET ROLE` explicitly. Failing to boot is loud; silent bypass is not. |
