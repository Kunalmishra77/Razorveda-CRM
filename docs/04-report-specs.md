# 04 — Report Specifications

Every report here replaces something the MIS team builds by hand, or answers a question that is
currently unanswerable. All reports read certified views from `packages/metrics`. None computes its
own arithmetic. All are back-datable to any period.

---

## Daily

| Report | Time | Audience | Columns / contents | Replaces |
|---|---|---|---|---|
| **Rep Morning Plan** | 07:30 | Each rep | Gap to target · overdue follow-ups · repeat-due customers · fresh leads · yesterday's realised value | `PlaningSheet` |
| **Daily Lead Pool** | 08:00 | Admin | Arrived · assigned · still unassigned · ageing >24h, by source | New |
| **Exception Digest** | 08:00 | Admin | Files not uploaded · unresolved duplicates · unmapped products · untouched leads · high-risk orders awaiting dispatch | New |
| **Employee Daily Performance** | 21:00 | Admin, Owner | See columns below | `Team Audit` tab |
| **Daily Sales Register** | 21:00 | Admin, Owner | Every order today: customer · source · products · value · company base · employee credit · payment split · state · rep | Order sheets |
| **Daily Dispatch & Status** | 21:00 | Admin | Dispatched · in transit · OFD · delivered · RTO · NDR — counts and value; ageing on anything stuck >7 days | Manual chase |
| **Management One-Pager** | 21:00 | Owner | Revenue · orders · RTO% · conversion · top rep · top product · pace vs target | Verbal |

### Employee Daily Performance — exact columns
```
Rep · Leads Assigned · Leads Touched · Untouched · Dials* · Connects* · Connectivity%* ·
CD · ND · Orders Booked · Booked Value · Orders Delivered · Realised Value · RTO Count ·
RTO Value · Follow-ups Due · Follow-ups Done · SLA% · AOV · Credit Earned
```
`*` self-reported — reps dial from handsets. Mark these columns in the UI so nobody mistakes them
for measured values.

**Alert rule:** any rep with assigned leads and zero dials by 14:00 → alert to admin the same day.

---

## Weekly — Monday 09:00

| Report | Answers |
|---|---|
| **Weekly Team Pack** | Week vs target · WoW movement per rep · best/worst days · pipeline entering next week |
| **Source Performance** | Leads by channel · conversion · value per lead · cost per delivered order where spend entered |
| **Assignment Quality** | Which rep converts which kind of lead. **The report that makes manual assignment better each week.** Columns: Rep · Best source · Yield · Weakest source · Yield · Best product line · RTO |
| **Follow-up Hygiene** | Overdue follow-ups by rep and age · leads with zero activity · leads approaching validity expiry |
| **RTO Watch** | RTO by rep, product, state, payment mode, value band · worst pincodes of the week |
| **Data Quality Scorecard** | Duplicate rate · unmapped products · missing dispositions · rows parked un-keyable · exception rate per channel |

---

## Monthly — 1st of month, ready 09:00

**Month-close pack, in this order:**

1. **Target vs Achievement** — per rep and team: target · booked · realised · % · orders (integer) ·
   AOV · balance
2. **Incentive Statement** — per rep: realised credited value · slab · delivery-quality multiplier ·
   prepaid bonus · product SPIF · repeat bonus · clawbacks · net payable. Ready for approval.
3. **Product Line P&L** — all seven lines, allocated at `order_line` grain
4. **SKU Performance** — units · value · AOV · RTO% · repeat rate per SKU
5. **Source P&L** — leads · conversion · delivered value · value per lead · ROI where spend entered
6. **Geography Report** — state and top-100 pincode performance, RTO hotspots.
   *Critical for a pan-India COD business — currently unanswerable.*
7. **Customer Report** — new vs repeat · buyer stage movement · LTV by cohort · dormant list
8. **Operations Report** — dispatch TAT · courier comparison · NDR reasons · RTO recovery rate
9. **Next-Month Plan** — required run rate per rep · pipeline carried forward · repeat-due volume

---

## On demand

| Question | Report | Currently |
|---|---|---|
| How much of product X sold? | Product Line P&L → SKU drill | Half a day, and Skinwise returns ₹0 |
| How much did rep Y generate, and how much delivered? | Scoreboard → booked/realised/credited | Chase the rep for her sheet |
| Which lead source performed best? | Source Funnel by value per lead | Unanswerable |
| Which campaign had best ROI? | Campaign ROI | Unanswerable |
| Which customers are due for repeat? | Repeat-Due Queue (already in the rep's worklist) | Manual re-upload, mostly missed |
| Which state has worst RTO? | Geography Report → RTO hotspots | Unanswerable |
| Who has the highest conversion? | Scoreboard, source-normalised | A day of spreadsheet work |
| What happened last March? | Any report, back-dated | Whatever survives in old files |

---

## Delivery

| When | Who | Channel |
|---|---|---|
| 07:30 daily | Each rep | WhatsApp + email |
| 08:00 daily | Admins | Email |
| 21:00 daily | Owner | WhatsApp |
| Monday 09:00 | Owner + admins | Email |
| 1st of month | Owner + admins | Email |
| Real time | Relevant party | In-app + WhatsApp: target hit · RTO spike · ingestion failure · copy-velocity alert · rep inactive 2h in shift |

Reports nobody opens are reports nobody uses. Push is not optional.

## Implementation rules

- Materialised views: `mv_daily_employee_kpi`, `mv_product_revenue_daily`, `mv_source_funnel_daily`,
  `mv_rto_analysis`, `mv_repeat_due_queue`, `mv_geography_performance`
- Refresh `CONCURRENTLY` every 15 min, plus 00:05 previous-day close
- Every report takes a period parameter and works for any historical range
- Every report exports to XLSX **for ADMIN only**, watermarked and logged
- No report may display a metric absent from `docs/03-metric-dictionary.md`
