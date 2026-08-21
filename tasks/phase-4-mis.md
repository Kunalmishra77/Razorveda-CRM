# Phase 4 — MIS Automation (Weeks 14–17)

## Goal
**Nobody prepares a report, ever again.** This is the phase the client is actually buying.

## Deliverables
1. Every report in `docs/04-report-specs.md` — daily first, then weekly, then monthly.
2. Materialised views: `mv_daily_employee_kpi`, `mv_product_revenue_daily`, `mv_source_funnel_daily`,
   `mv_rto_analysis`, `mv_repeat_due_queue`, `mv_geography_performance`.
   Refresh `CONCURRENTLY` every 15 min + 00:05 previous-day close.
3. Scheduled delivery: 07:30 rep plan, 08:00 admin exception digest, 21:00 management one-pager,
   Monday 09:00 weekly pack, 1st-of-month close pack. WhatsApp + email.
4. Alerting: target hit, RTO spike, ingestion failure, rep with assigned leads and zero dials by
   14:00, copy-velocity anomaly.
5. **Corrected RTO-adjusted targets go live:**
   `Required Booking = Per Day Req Delivery ÷ (1 − rep_rolling_90d_RTO)`, replacing the flat ×1.15
   (F11). Expect target values to move sharply for high-RTO reps — that is the point.
6. Hinglish remark normalisation as a nightly batch. Raw remark always preserved and displayed.
7. XLSX export for ADMIN only, watermarked and logged.

## Rules
- No report computes its own arithmetic. All read certified views from `packages/metrics`.
- Every report takes a period parameter and works for any historical range.
- No report may display a metric absent from `docs/03-metric-dictionary.md`.
- Self-reported metrics (dials, connects, connectivity) must be visibly labelled as such in the UI.

## Exit criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | Report parity | Every artefact in `docs/04` exists and renders |
| 2 | Back-dating works | Run the August close pack in December; identical numbers |
| 3 | No orphan metrics | Automated check: every displayed metric key exists in the registry |
| 4 | Refresh under SLA | Matview refresh completes in under 60 s at current volume |
| 5 | Digests delivered | 5 consecutive days of scheduled sends, verified |
| 6 | **The retirement** | `MIS_Driven_Audit_Sheet-2025` formally decommissioned. No human prepares a report for one full month. |
