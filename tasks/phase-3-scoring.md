# Phase 3 — Scoring, Attribution & Lifecycle (Weeks 11–13)

## Goal
Money is calculated by the system, correctly, every time.

## Deliverables

### 1. Attribution ledger
Source rule table from `docs/03` §4.1. `company_base_value` looked up from `sku.shopify_base_price`
— never typed by a human. This is the fix for F7's 31% leakage.
`order_credit_split` handles `Riya / Divya` and `Riya / Shopify` cases; percentages sum to 100.

**Mandatory unit tests:**
- Shopify ₹500 → ₹2,000: company base 500, employee credit 1,500
- WA campaign ₹700 → ₹1,800: company base 700, employee credit 1,100
- Meta ads ₹1,450: company base 0, employee credit 1,450
- Split 60/40 across two reps sums exactly to the credited value with no rounding loss

### 2. Booked → Realised → Clawback
Driven by `order_status_event`. Delivered writes `REALISED_CREDIT`. RTO/RETURNED after delivery
writes `CLAWBACK`. **Test that realised can never exceed booked** (fixes F10).

### 3. Incentive engine
Slabs, delivery-quality multiplier, prepaid bonus, product SPIF, repeat bonus. All from tables,
versioned, admin-editable. Defaults in `docs/03` §6 are proposals — see open decision O-09.

### 4. Performance scoring (nightly)
Six components per `docs/03` §5, percentile-ranked, Bayesian shrinkage k=30, source-mix
neutralised. Writes `employee_score_daily`. **This score reports on reps. It does not assign leads.**

### 5. Repeat-purchase engine
On delivery: `customer.next_due_date = delivered_date + sku.usage_days - 5`.
On that date the customer enters the owning rep's worklist as a `DELIVERED_REPEAT` lead.
Highest-ROI automation in the build.

### 6. Follow-up automation
Due reminders · 48h untouched alert to admin · 72h auto-return to pool with an append-only
`lead_assignment` row of method `RECALL`.

## Exit criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | Every money path tested | 100% branch coverage on the attribution module |
| 2 | Realised credit <= booked credit **per order** (not per period — see metric dictionary section 6). Property test over generated order histories at ORDER grain| Property test over generated order histories |
| 3 | Clawback fires | Deliver then RTO an order; the **realised** ledger (`is_realised = true`) nets to zero for that order. The provisional `BOOKED_CREDIT` row stays: Booked Value is status-independent by definition (docs/03 §2), and rule 3 says nothing is ever paid on it. Netting ALL entries to zero would require erasing the booking. See D-139. |
| 4 | Incentive reconciles | One month computed by the system matches a manual calculation |
| 5 | Repeat-due fires | Deliver an order with usage_days=30; lead appears on day 25 in the owner's worklist |
| 6 | 72h recall | Assign a lead, no activity, advance the clock; lead returns to the pool |
