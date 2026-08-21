# 03 — Metric Dictionary

**This is the single source of truth for every number in the system.**

Rules:
1. If a metric is not in this file, it does not exist and no screen may display it.
2. No report, no API endpoint and no component computes its own arithmetic. They read certified
   views from `packages/metrics`.
3. `packages/metrics` has a test that fails if this file and the registry drift apart.
4. Changing a definition is a change request with an effective date, not a code edit.

---

## 0. Section numbering is load-bearing

The parity parser derives section context from these headings. Numbers must be unique and
sequential. `packages/metrics` asserts this separately from parity — a duplicate number files a
metric under the wrong section and produces a mismatch that reads as "missing metric", sending the
next person to the wrong file. (defect N7)

Longer term: key sections off a stable slug and treat the digit as a display label only.

---

## 1. Activity metrics

| Metric | Formula | Grain | Note |
|---|---|---|---|
| **Total Dialling** | `COUNT(activity WHERE type='CALL')` | rep × day | **Self-reported** — reps dial from handsets. Label it as such in the UI. |
| **Num of Connect** | `COUNT(activity WHERE type='CALL' AND connected=true)` | rep × day | Self-reported |
| **Connectivity %** | `Num of Connect ÷ Total Dialling` | rep × day × source | Self-reported |
| **CD** (Connected Data) | `COUNT(DISTINCT lead_id WHERE ever_connected)` | rep × period | |
| **ND** (Not-connected Data) | `Assigned Leads − CD` | rep × period | |
| **Today's CD** | `COUNT(DISTINCT lead WHERE lead.first_connected_at::date = CURRENT_DATE)` | rep × day | Uses `lead.first_connected_at`, added for this metric. Do **not** use `first_contact_at` — contact ≠ connect. |
| **Fq** (Frequency) | `COUNT(activity) GROUP BY lead_id` | lead | Contact attempts on one lead |
| **Buyers Fq** | `COUNT(order WHERE status='DELIVERED') GROUP BY customer_id` | customer | Delivered orders only |
| **Follow-up SLA %** | `followups_actioned_on_time ÷ followups_due` | rep × day | |
| **Untouched Leads** | `COUNT(lead WHERE contact_attempts = 0 AND assigned_at < now() - interval '48 hours')` | rep | Column is `contact_attempts`, not `activity_count`. Most actionable operational number in the system. |

## 2. Data block metrics

Preserves the `Team Audit` model, auto-populated.

| Metric | Formula |
|---|---|
| **No of Data** | `COUNT(lead) WHERE ingestion_batch_id = X` |
| **Given Date** | `MIN(lead_assignment.assigned_at)` for the batch |
| **Data Valid Till** | `assigned_at + lead_source.validity_days` |
| **Order Target** | `No of Data × lead_source.expected_conversion_rate` — **fractional by design.** A target is an expectation, not a count. Do not round it and do not confuse it with Total Orders, which is always an integer. |
| **Till Achieve Order** | `COUNT(order WHERE lead.batch_id = X AND status='DELIVERED')` |
| **Conversion %** | `Till Achieve Order ÷ No of Data` |
| **Data Ageing** | `CURRENT_DATE − assigned_at` in days |

## 3. Revenue metrics — corrected

| Metric | Definition | Replaces |
|---|---|---|
| **Booked Value** | `SUM(order.final_value) WHERE order_date IN period`. Status-independent. **Provisional.** | Ambiguous "Booking" (F10) |
| **Realised Value** | `SUM(order.final_value) WHERE current_status='DELIVERED' AND delivered_date IN period`. **The only number that pays incentive.** | "Achieve Value" |
| **Total Orders** | `COUNT(DISTINCT order_id)`. Integer, always. | Fractional derived counts (F9) |
| **Product Line Revenue** | `SUM(order_line.line_value) GROUP BY sku.line_id`, restricted to delivered orders | Single product column (F8) |
| **AOV** | `Realised Value ÷ Delivered Orders` | Not tracked today |
| **RTO %** | `RTO Value ÷ (Delivered Value + RTO Value)` for orders **dispatched** in the period. One definition. | Two disagreeing values (F12) |
| **Prepaid Ratio** | `prepaid_amount ÷ final_value` | Unmeasurable today (F5) |
| **Value Balance** | `Target − Realised Value` | Unchanged — current formula is correct |
| **Per Day Req Delivery** | `Value Balance ÷ remaining_working_days` from `working_calendar` | Unchanged — correct |
| **Required Booking Value** | `Per Day Req Delivery ÷ (1 − rep_rolling_90d_RTO)` | Flat `× 1.15` (F11) |
| **Forecast** | `(open_pipeline × stage_probability) + (run_rate × remaining_days × seasonality_index)`, RTO-adjusted | Straight-line (F16) |

## 4. Attribution metrics

| Metric | Definition |
|---|---|
| **Company Base Value** | Order value committed before rep intervention. From `sku.shopify_base_price` for Shopify, from the imported campaign order value for WA_CAMPAIGN, else `0`. |
| **Employee Credited Value** | `order.final_value − company_base_value`, per the source rule below |
| **Upsell Index** | `Employee Credited Value ÷ Company Base Value` on upsell-eligible orders |
| **Realised Credited Value** | Employee Credited Value where `current_status='DELIVERED'`. **Incentive basis.** |
| **Clawback** | Credited value reversed when a delivered order flips to RTO/RETURNED |

### 4.1 Source attribution rule table

| `lead_source.code` | `attribution_rule` | Company base | Employee credit |
|---|---|---|---|
| `SHOPIFY` | `UPSELL_DELTA` | `sku.shopify_base_price` | `final − base` |
| `WA_CAMPAIGN` | `UPSELL_DELTA` (only if an order arrived with the lead) | imported order value | `final − base` |
| `META_ADS` | `FULL_CREDIT` | `0` | `final` |
| `WEB_WHATSAPP` | `FULL_CREDIT` | `0` | `final` |
| `WEB_CALL` | `FULL_CREDIT` | `0` | `final` |
| `ADD_TO_CART` | `FULL_CREDIT` | `0` | `final` |
| `DELIVERED_REPEAT` | `FULL_CREDIT` | `0` | `final` |
| `RTO_RECOVERY` | `FULL_CREDIT` | `0` | `final × employee_credit_percent` |
| `NC_REFUSED` | `FULL_CREDIT` | `0` | `final × employee_credit_percent` |

**Worked examples — implement both as unit tests:**
- Shopify order ₹500, rep upsells to ₹2,000 → company base **₹500**, employee credit **₹1,500**
- WA campaign order ₹700, rep upsells to ₹1,800 → company base **₹700**, employee credit **₹1,100**

**Split ownership:** the client's data contains `Riya Chauhan / Shopify` and `Riya / Divya` in the
caller column. Support an ordered list of `(employee_id, percent)` on the order; percentages must
sum to 100.

## 5. Performance score (EES)

Reports on reps. **Does not assign leads.**

| Component | Weight | Metric |
|---|---|---|
| Conversion Rate | 25% | Delivered orders ÷ leads assigned |
| Value per Lead | 25% | Realised value ÷ leads assigned |
| **Delivery Quality** | **20%** | `1 − RTO%` |
| Upsell Index | 15% | Credited ÷ base on eligible orders |
| Activity Discipline | 10% | Follow-up SLA + dial coverage + untouched rate |
| Data Hygiene | 5% | Dispositions filled, remarks present, no stale leads |

**Normalisation:** percentile-rank each component within the active team, then weight.

**Bayesian shrinkage:** `adjusted = (n × observed + k × team_mean) ÷ (n + k)` with `k = 30` leads.
A rep with 12 leads and one lucky order must not top the table.

**Source-mix neutralisation:** compute within source cohorts, then re-weight. Without this, the
score mostly measures the admin's assignment choices rather than the rep's work.

Refresh: nightly into `employee_score_daily`. Never edited by hand.

## 6. Incentive

```
Payable = Σ REALISED_CREDIT − Σ CLAWBACK, for period_key
```

| Lever | Default | Effect |
|---|---|---|
| Base slab | ₹1L → 2%, ₹2L → 3%, ₹3L → 4% | On realised credited value |
| Delivery-quality multiplier | RTO <5% → ×1.15; 5–20% → ×1.00; >20% → ×0.75 | Prices in margin destruction |
| Prepaid bonus | Prepaid ratio >30% → +0.5% | Attacks the RTO root cause |
| Product SPIF | Configurable per line per quarter | e.g. Skinwise +1% |
| Repeat-customer bonus | Buyer Fq ≥ 3 → +₹100/order | Rewards LTV |

All slabs and modifiers live in tables, versioned, admin-editable. Never hardcoded.


---

## 7. Period basis — Booked vs Realised (defect B4, decision D-13)

The v1 draft asserted "Realised can never exceed Booked". **That is false at period grain and
correct at order grain.** An order booked 28 August and delivered 3 September is August booked and
September realised. Getting this wrong would have produced a property test that fails on correct data.

**The invariant is per order:**

```sql
-- MUST hold for every order, always:
realised_credited_value(order) <= booked_credited_value(order)
-- Equality when delivered in full; strictly less after a clawback; zero if RTO.
```

**Period reporting uses two bases and must always label which one is on screen:**

| Basis | Definition | Used for |
|---|---|---|
| **Cash basis** (default) | Realised keyed on `delivered_date` | Incentive, scoreboard, monthly achievement. This is when money actually arrives. |
| **Cohort basis** | Orders booked in period X, followed to their eventual outcome | Conversion quality, RTO% by booking month, "how good was August's pipeline really" |

**Incentive is paid on cash basis.** A rep is paid in the month the parcel delivers, not the month
she booked it. Simpler to explain, matches cash flow, and removes any need to reopen a closed month.

Every screen showing Booked next to Realised must carry the line:
*"Realised is delivered-in-period. Some of it was booked last month; some of this month's bookings
will realise next month."*

### What this means for finding F10
The v1 audit flagged Divya's ₹2,10,638 booked vs ₹2,16,785 achieved as "impossible". With the
period basis clarified, that gap is **most likely an ordinary cohort artefact** — July bookings
delivering in August — not proof of corruption. The real defect in the client's sheet is that it
never states which basis it uses, so nobody can tell an artefact from an error. Do not repeat that
claim to the client without this correction.


---

## 8. Working-day denominators (decision D-34, resolves O-08)

The client's sheet uses two different definitions of "day" in one table, and only one is
reproducible.

**FORWARD — verified.** `Per Day Req Delivery = Value Balance / 12` on the 17 Aug 2026 snapshot.
Working days 18–31 Aug with Sundays non-working is exactly 12. Nikita:
`153,769.39 / 12 = 12,814.11583`, matching the sheet to five decimals. Sundays-off is **confirmed by
the data, not assumed.**

**BACKWARD — not reproducible.** `Per Day Avg Value = Achieve Value / 11`. Working days 1–17 Aug
with Sundays off is **14**, not 11. No calendar rule produces 11. It is hand-typed.

This matters because the forecast is built on it:

```
Nikita, client's method:  146,230.61 / 11 = 13,293.69  ->  x12 = 1,59,524
Nikita, calendar method:  146,230.61 / 14 = 10,445.04  ->  x12 = 1,25,340
```

A **₹34,184 over-forecast on one rep.** The v1 audit called the forecasting "straight-line
extrapolation with no pipeline weighting" — true, but the larger error was simply a wrong divisor.

**RULE — both denominators read `working_calendar`. No hand-typed day counts anywhere.**

```
Per Day Req Delivery        = working days from tomorrow to month end
Per Day Avg Value           = working days from month start to today
Approx Guess Rest of Month  = Per Day Avg Value x remaining working days, then RTO-adjusted
```

Seed 2026 with Sundays non-working. Add an admin-toggleable holiday flag, **seeded EMPTY**, marked
provisional until the client confirms festival closures. Every screen showing a per-day figure
carries a "provisional calendar" marker until O-08 is signed off.

**PHASE 2 NOTE** — rebuilding Apr–Aug with the correct denominator produces **lower** per-day
averages and **lower** forecasts than the client's sheet. That is the fix working. Put it in the
variance report citing this section, and do not let anyone correct it back.
