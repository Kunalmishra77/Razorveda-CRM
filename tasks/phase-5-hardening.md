# Phase 5 — Hardening (Weeks 18–20)

## Deliverables
1. Session watermarking on every data surface (name, emp code, timestamp, IP)
2. `pii_access_log` writes on every number view and copy
3. Copy-velocity detection: ≥4 events in 90 s → auto-lock + admin alert
4. Single-session enforcement, device binding, shift-hour login windows
5. Admin security console: access log, velocity alerts, active sessions, audit trail
6. Offboarding flow: revoke, bulk-return leads with handover note, preserve 30-day access history
7. Rate limiting, CSP, CSRF, upload content validation, dependency scanning in CI

## Self-directed security review
Try to break RLS. Specifically:
- Cross-employee reads via direct API calls with forged ids
- IDOR on every endpoint taking a lead/customer/order id
- Pagination abuse to exceed the 50-row cap
- Any route that returns another rep's data through a join
- Any export path reachable by the EMPLOYEE role

**Write a failing test for anything found before fixing it.** Report by severity.

## Backup and DR
Verify restore end to end on a scratch database. Document the exact commands in the README.
An untested backup is not a backup. Schedule the drill monthly from here on.

## Exit criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | Clean security review | All findings remediated with regression tests |
| 2 | Velocity lock works | 4 copies in 90 s → account locked, alert written |
| 3 | Restore drill passes | Full restore to a scratch DB, data verified, commands documented |
| 4 | RPO/RTO met | RPO ≤ 15 min, RTO ≤ 4 hours, measured not assumed |
| 5 | Users trained | Admin and rep runbooks written; sign-off from both groups |
