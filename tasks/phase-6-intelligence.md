# Phase 6 — Intelligence (Weeks 21–24)

Build in order. Stop after each for review.

## 1. Geography intelligence — highest business value
Razorveda ships pan-India on COD and currently cannot see which parts of the country are profitable.
- State and pincode RTO heatmap; rank the worst 100 pincodes
- Delivery TAT by state and courier
- Regional product affinity
- Output: a list of pincodes that should be prepaid-only. Worth lakhs per month.

## 2. RTO risk scoring
Features: prior RTO count · prepaid ratio · pincode band · order value · pre-dispatch contact ·
product line · courier.
**Start with logistic regression.** Do not reach for anything heavier until it underperforms.
Report lift against a held-out month, not training accuracy.

## 3. Pre-dispatch risk queue
Admin console screen listing high-risk orders awaiting dispatch, with a prepaid-conversion action.
The mechanism is already proven in the client's own data: full COD ~11% RTO, partial prepaid ~4%.

## 4. Cross-purchase matrix + next-best-product
Display only. Never an automatic action.

## 5. Objection intelligence
From normalised remarks: top reasons for non-purchase by product and by state. Which objection do
the best reps overcome that others don't. Completely invisible in a spreadsheet, and the data is
already sitting in four months of Hinglish remarks.

## 6. Forecasting
Pipeline-weighted with seasonality and RTO adjustment, replacing straight-line extrapolation (F16).
Plus a daily "will we hit target" signal so a shortfall is visible on the 12th, not the 31st.

## Optional, decide with the client
- Cloud dialler with number masking (open decision O-10) — the only control that removes the PII
  risk, and the only way dial/connect metrics ever become measured rather than self-reported
- Courier status API sync, replacing manual RTO/NDR uploads
- WhatsApp templated sending from the CRM

## Exit criteria
| # | Criterion |
|---|---|
| 1 | RTO model shows measurable lift over baseline on a held-out month |
| 2 | Prepaid-only pincode list produced and reviewed with the client |
| 3 | Forecast accuracy measured against actuals for one full month |
| 4 | Objection report produced and reviewed with the sales team |
