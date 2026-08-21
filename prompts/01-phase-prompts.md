# Phase Prompts

One prompt per phase. Paste one at a time, in a fresh session.

---

## Phase 0 — Foundation (Weeks 1–2)

```
Read CLAUDE.md and tasks/phase-0-foundation.md.

Build Phase 0 only. Deliverables:
1. Scaffold the monorepo exactly as specified in CLAUDE.md section 3. npm workspaces only.
2. docker-compose.yml with postgres:16, redis:7, minio. Health checks on all three.
3. packages/db: apply db/schema.sql then db/rls-policies.sql. Set up Drizzle Kit so future changes
   are migrations, but treat the checked-in SQL as the source of truth for v1.
4. A seed script that loads every CSV in db/seed/ idempotently — re-running must not duplicate.
5. packages/shared: Zod schemas and TypeScript types for every entity in docs/02-data-model.md.
6. packages/metrics: a metric registry mirroring docs/03-metric-dictionary.md one-to-one, with the
   SQL for each certified view. Include a test that FAILS if a metric exists in the doc but not in
   the registry, or vice versa.
7. A working `npm run dev` bringing up api + web + worker + infra.
8. README a new developer can follow in under 15 minutes.

Exit criteria are in the phase doc. Show me the plan first. Then build. Then prove each exit
criterion with a command I can run myself.
```

---

## Phase 1 — Core Platform (Weeks 3–6)

```
Read CLAUDE.md and tasks/phase-1-core.md. Phase 0 is complete.

Build Phase 1 only: auth + two roles + RLS, customer golden record, order ledger with lines,
activity log, admin shell, employee portal, manual lead entry, bulk assignment console.

Priorities in order:
1. Auth and RLS first, with tests that PROVE an employee cannot read another employee's lead even
   by calling the API directly with a forged lead id. These tests exist before any UI.
2. Customer golden record with identity resolution: exact phone → alt identifier → fuzzy.
3. Order ledger. order_line is mandatory — product P&L comes from lines, never from a single
   product column. See docs/08-audit-findings.md finding F8 for why.
4. Bulk assignment console per docs/07-ui-spec.md section 3.
5. Employee worklist with the priority ordering from docs/07-ui-spec.md section 4.

Use design/prototype.html as the visual reference. Match the information architecture. You do not
need to match the CSS exactly, but density and tone should be the same — this is an operations
tool, not a marketing site.

Show me the plan first. Build in the order above. After each numbered item, stop and let me look.
```

---

## Phase 2 — Ingestion Engine (Weeks 7–10)

```
Read CLAUDE.md, tasks/phase-2-ingestion.md and docs/06-ingestion-spec.md. Phase 1 is complete.

Build the seven-stage pipeline and all nine upload channels.

Non-negotiable order:
1. The normalisation library FIRST, as pure functions with no I/O: phone, name, encoding, date,
   payment-string, disposition alias, product→SKU. Write tests from fixtures/ BEFORE the
   implementation. Every file in fixtures/ must parse correctly before you build anything else.
2. File fingerprinting + batch model + rollback. Prove a duplicate file is refused.
3. Column mapping with template caching. AI path runs only on a template miss.
4. Identity resolution + merge queue.
5. Validation including the column-shift detector — >20% type failure fails the whole batch.
6. Exception review UI. Admin sees ONLY exceptions, never clean rows.
7. Commit transaction. Leads land in the unassigned pool, unassigned.

Then write a backfill script for the client's historical workbooks and a reconciliation report
comparing rebuilt numbers against their existing Achieve Report, per rep, with variances explained
rather than hidden.

Show me the plan first.
```

---

## Phase 3 — Scoring, Attribution & Lifecycle (Weeks 11–13)

```
Read CLAUDE.md and tasks/phase-3-scoring.md. Phase 2 is complete.

Build:
1. Attribution ledger with the source rule table in docs/03-metric-dictionary.md section 4.
   company_base_value is looked up from sku.shopify_base_price — never typed by a human.
   Test both worked examples: ₹500→₹2,000 gives credit ₹1,500; ₹700→₹1,800 gives credit ₹1,100.
2. Booked → Realised → Clawback transitions driven by order_status_event.
3. Incentive engine: slabs, delivery-quality multiplier, prepaid bonus, product SPIF, repeat bonus.
4. Nightly performance scoring with Bayesian shrinkage (k=30) and source-mix neutralisation.
   This score REPORTS on reps. It does not assign leads.
5. Repeat-purchase due engine: delivered_date + sku.usage_days − 5 → lead in the owner's worklist.
6. Follow-up automation: due reminders, 48h untouched alert, 72h auto-return to pool.

Every money calculation gets a unit test. Show me the plan first.
```

---

## Phase 4 — MIS Automation (Weeks 14–17)

```
Read CLAUDE.md, tasks/phase-4-mis.md and docs/04-report-specs.md. Phase 3 is complete.

Build every report in docs/04-report-specs.md. Rules:
- Reports read certified views from packages/metrics. No report computes its own arithmetic.
- Materialised views refreshed CONCURRENTLY every 15 min plus a 00:05 previous-day close.
- Every report is back-datable to any period.
- Scheduled delivery: 07:30 rep plan, 08:00 admin exception digest, 21:00 management one-pager,
  Monday 09:00 weekly pack, 1st-of-month close pack.
- Corrected RTO-adjusted targets go live here: Required Booking = Per Day Req ÷ (1 − rep 90d RTO),
  replacing the flat ×1.15. See docs/08-audit-findings.md finding F11.
- Hinglish remark normalisation as a nightly batch. The raw remark is always preserved.

Show me the plan first. Daily reports before weekly, weekly before monthly.
```

---

## Phase 5 — Hardening (Weeks 18–20)

```
Read CLAUDE.md, tasks/phase-5-hardening.md and docs/05-security-model.md. Phase 4 is complete.

Build: session watermarking, copy-event logging, velocity detection with auto-lock, full access
logging, single-session enforcement, shift-hour login windows, admin security console.

Then run a self-directed security review against docs/05-security-model.md and report findings by
severity. Specifically try to break RLS: cross-employee reads via direct API calls, forged ids,
IDOR on every endpoint taking a lead/customer/order id, and pagination abuse. Write a failing test
for anything you find before fixing it.

Also verify backup and restore end to end on a scratch database and document the exact commands.
An untested backup is not a backup.
```

---

## Phase 6 — Intelligence (Weeks 21–24)

```
Read CLAUDE.md and tasks/phase-6-intelligence.md. Phase 5 is complete.

Build in this order, stopping after each for review:
1. Geography intelligence: state and pincode RTO heatmap, delivery TAT by courier, regional product
   affinity. Highest business value for a pan-India COD brand.
2. RTO risk scoring. Features: prior RTO count, prepaid ratio, pincode band, order value,
   pre-dispatch contact, product line, courier. Start with logistic regression — do not reach for
   anything heavier until it underperforms. Report lift against a held-out month.
3. Pre-dispatch risk queue in the admin console with a prepaid-conversion action.
4. Cross-purchase matrix and next-best-product suggestion. Display only, never auto-action.
5. Objection intelligence from normalised remarks: top reasons by product and by state.
6. Pipeline-weighted forecasting with seasonality and RTO adjustment, plus a daily
   "will we hit target" signal.
```
