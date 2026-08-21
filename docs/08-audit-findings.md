# 08 — Audit Findings

Measured from the client's actual files: `MIS_Driven_Audit_Sheet-2025.xlsx` (3 tabs, 1,986 formula
cells) and `Riya_Chauhan.xlsx` (20 tabs, 2,159 populated rows). These are not estimates.

**Read this before writing code.** Every rule in this repo exists because of something below.

## Data integrity

| ID | Finding | Evidence | Design response |
|---|---|---|---|
| **F1** | No customer identity. Same person duplicated across tabs with divergent status. | 954 unique mobiles → 1,627 row-instances. Redundancy factor 1.71. 375 customers (39.3%) in >1 tab. One in 8 tabs. | `customer` golden record + `customer_identifier` + identity resolution at ingest |
| **F2** | 10.9% of rows are un-keyable — no valid 10-digit mobile. | 236 of 2,159 rows. One literally contains the text `code`. | Surrogate UUID PK; un-keyable rows parked, not discarded |
| **F3** | Column-shift corruption from copy-paste. | `Order Status` contains 40+ customer names. `Client Category` contains PIN codes (247232, 440023). `Data Resource` contains AWB numbers (9544610000000). | Column-shift detector: >20% type failure fails the whole batch |
| **F4** | Uncontrolled disposition vocabulary. | `updated user 18 aug`.status has **49 distinct values** for ~12 real outcomes: `ringing`/`rinigng`/`ring`/`ring cut`, `bsy call cut`/`bsy cal cut`, `not connect`/`not connected` | Closed `disposition` master + alias table + mandatory dropdown |
| **F5** | Payment split is free text. Prepaid ratio — the biggest RTO lever — is unmeasurable. | 121 distinct payment strings: `300 prepaid & 2200 cod`, `849 webpay & 1650 cod`, misspellings `preapid`, `prepiad`, `preapaid` | Parse into `prepaid_amount` + `cod_amount` + generated `prepaid_ratio` |
| **F6** | No schema contract between tabs. | `Number`/`Phone no`/`Phoneno`; `Customer name`/`CustomerName`/`Name`; `Product detail`/`ProductDeatil`; `Amount`/`Total amount`; `Agent`/`Caller name`/`CallerName`/`Agent Name`; `Category`/`Client Category` | Column mapping templates keyed on header signature |

## Financial and attribution

| ID | Finding | Evidence | Design response |
|---|---|---|---|
| **F7** | **Upsell attribution leaks 31%.** The Shopify rule is applied by hand, inconsistently. | 52 Shopify Upgrade rows with both amounts: 36 split correctly, **16 credit the full order value**. Implied base prices cluster tightly at ₹899 / ₹849 / ₹949. | `sku.shopify_base_price` lookup; `company_base_value` never typed by a human |
| **F8** | **Product P&L is wrong.** | Riya Apr–Aug: Breast Care ₹9,99,802 · **Skinwise ₹2,51,698 (116 orders)** · Slimming ₹1,46,144 · Intimate ₹1,03,083 · Face ₹27,399 · Customisation ₹26,600 · Hair ₹19,000. Company Achieve Report shows **Skin-wise = ₹0 for all 11 BDEs**. | `order_line` grain with `sku → product_line`. Multi-line orders split correctly. |
| **F9** | Order count is not countable. | Achieve Report shows 73.8, 84.8, 68.06, 5.22 orders. Volume is derived (value ÷ AOV), not counted. | `COUNT(DISTINCT order_id)` — integer, always |
| **F10** | Booked vs achieved internally inconsistent. | Nikita: booked ₹3,70,375 vs achieved ₹1,46,231 (60.5% gap). **Divya: booked ₹2,10,638 vs achieved ₹2,16,785 — achieved exceeds booked, which is impossible.** | One ledger produces both. Realised can never exceed booked. |
| **F11** | **RTO buffer is a hardcoded 15% ignoring actual RTO.** | `Required Booking = Per Day Req Delivery × 1.15` for every BDE, verified to 4 decimals, while actual RTO ranges 0%–41%. Kajal at 41% RTO is told to book ₹10,511/day; she needs ₹15,491. **Understated by 47%.** | `Required Booking = Per Day Req ÷ (1 − rep_90d_RTO)` |
| **F12** | Same metric disagrees between two tabs of the same MIS pack. | Nikita's RTO = 0.04 on `Team Audit`, 0.03 on `Achieve Report`. | Metric dictionary + certified views. One definition, computed once. |

## Process and governance

| ID | Finding | Evidence | Design response |
|---|---|---|---|
| **F13** | Roster drift — no employee master. | Brief names 7. `Achieve Report` has 11 (adds Puja Singh, Mala, Priyanka, Kajal). `Scoreboard` has 10 (adds Priyanka, Kajal; drops Mala, Puja). | `employee` master with status enum. Everything reads from it. |
| **F14** | Brittle dashboard wiring. | 9 `IMPORTRANGE` links + **72 hardcoded cross-sheet cell references** like `='Team Audit '!K132`. Fails silently on an inserted row. | Reports read tables and views, never cell addresses |
| **F15** | Employees hold the master copy of company data. | Riya's file: 4 months of customer PII including addresses and PIN codes, on her machine. | Server-side only. Nothing on the rep's device. |
| **F16** | Forecasting is straight-line extrapolation. | `Approx Guess Rest of Month = Per-day Avg × remaining days`. Verified: 13,293.69 × 12 = 1,59,524.30. No pipeline, no seasonality, no RTO subtraction. | Pipeline-weighted forecast with seasonality and RTO adjustment |

## Formulas reverse-engineered from the current MIS (verified exact)

```
Per Day Req Delivery      = Value Balance ÷ 12 remaining working days        ✓ correct, keep
Required Booking Value    = Per Day Req Delivery × 1.15                      ✗ replace (F11)
Approx Guess Rest of Month= Per Day Avg Value × 12                           ✗ replace (F16)
Per Day Avg Value         = Achieve Value ÷ 11 days elapsed                  ✓ correct, keep
Achieved Value %          = Achieve Value ÷ Target                           ✓ correct, keep
Total (projected)         = Achieve Value + Approx Guess                     ✗ inherits F16
```

## What is good and must survive migration

Three concepts in the current system are more sophisticated than most CRMs. Keep them as
first-class fields, not afterthoughts.

- **CD / ND** — Connected Data vs Not-connected Data, tracked separately from conversion.
- **Fq / Buyers Fq** — repeat-contact count and repeat-purchase count per customer.
- **Data Given Date / Data Valid Till** — leads have an explicit shelf life and are measured
  against it. Most CRMs never model lead decay at all.
