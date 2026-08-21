# Phase 1 — Core Platform (Weeks 3–6)

## Goal
A rep can work a full day in the system, and an admin can assign leads in bulk.

## Build order — do not reorder

### 1. Auth + RLS (week 3)
- Argon2id, JWT 15 min + rotating refresh, TOTP for ADMIN/OWNER
- Request-scoped transaction setting `app.user_id` and `app.user_role`
- Single active session per employee; shift-hours window; 10 min idle logout
- **Write the isolation tests from `docs/05` BEFORE any UI.** All eight must pass.

### 2. Customer golden record (week 3–4)
- CRUD + search (admin only)
- Identity resolution service: exact phone → `customer_identifier` → fuzzy (name ≥0.85 + pincode)
- Merge / unmerge with `merged_into` audit
- `customer_type` and `stage` derived by trigger, never settable via the API

### 3. Order ledger (week 4)
- Order + **order_line** (mandatory — product P&L comes from lines, see F8)
- `order_status_event` append-only, with a state machine guarding legal transitions
- `payment_mode` + `prepaid_amount` + `cod_amount` as separate fields (F5)
- `company_base_value` resolved from `sku.shopify_base_price`, never accepted from the client

### 4. Activity log (week 4)
- Append-only, disposition required, follow-up date required when the disposition demands it
- `remark_raw` stored verbatim, never auto-corrected

### 5. Admin shell + bulk assignment console (week 5)
Per `docs/07-ui-spec.md` §3:
- Unassigned pool with filters: source, state, product line, received/age
- Checkbox column, header select-all, **shift-click range selection**
- "Select all in filter" must select across pagination, not just the visible page
- Pre-assign warnings (overloaded rep, existing-customer ownership, rep on leave, ageing leads).
  Warnings never block; overrides are logged.
- Suggested Split panel — advisory only, one-click apply, never auto-assigns
- Every assignment writes an append-only `lead_assignment` row

### 6. Employee portal (week 6)
Per `docs/07-ui-spec.md` §4:
- My Day, Worklist (fixed priority order, not user-sortable), Lead Detail, Order Entry
- Lead Detail: full number, Copy button writing `pii_access_log`, Mark-dialled writing an activity
- Order Entry with live credit preview
- Manual lead entry for walk-in/phone-in leads

## Exit criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | Employee cannot read another's lead | All 8 tests in `docs/05` pass, including forged-id direct API calls |
| 2 | Bulk assign works at scale | Assign 200 leads in one action; 200 `lead_assignment` rows written; under 2 s |
| 3 | Shift-click range selection works | Manual check, documented |
| 4 | Disposition is mandatory | API rejects an activity with no disposition; UI blocks save |
| 5 | Credit calculated correctly | Shopify ₹3,000 order on a ₹899-base SKU → `company_base_value` 899, credit 2101 |
| 6 | Product P&L from lines | A 2-line order across Breast Care + Skinwise splits correctly in a test query |
| 7 | Pilot | One rep runs a full week in the CRM; her numbers reconcile to her sheet within 1% |

## Do not do in this phase
File ingestion. Reports. Scoring. Incentive.
