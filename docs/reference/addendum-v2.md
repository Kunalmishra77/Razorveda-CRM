# Razorveda CRM — Addendum v2
## Revised Operating Model, Full Report Catalogue, and Advanced Capability

**Supersedes:** Sections 7, 9.1, 9.2 and 12 of the v1 Blueprint
**Date:** 20 August 2026
**Company:** Razorveda · pan-India COD ayurvedic D2C

---

## Part 1 — What Changes From v1

Four decisions from you, and what each one means downstream.

| # | Your decision | What it changes | Honest consequence |
|---|---|---|---|
| 1 | **No auto-assignment.** Admin assigns from the panel. | The efficiency-weighted allocation engine is removed. Replaced by a bulk-assignment console: filter → tick → assign. | You keep full control. The trade-off is that lead distribution quality now depends on the admin's judgement, so the system's job becomes *making that judgement better* — see the Assignment Quality report in Part 3. |
| 2 | **Bulk select, not one at a time.** | Filter the pool, tick a block (or select-all-in-filter), pick a rep, assign. 60 leads in three clicks. | This is the single biggest time saving in the admin's day and it is easy to build. No downside. |
| 3 | **Reps dial from their own handset.** | No click-to-call, no telephony integration, no call recording, no auto-captured call duration. Reps must see the full number. | **This costs you the strongest data-protection control available.** Details and what replaces it in Part 2. It also means dial counts are self-reported, so "Total Dialling" becomes a claimed number rather than a measured one. |
| 4 | **Two roles only: Admin and Employee.** | No Team Lead tier, no separate executive view. All reports, MIS and analytics live inside the Admin role. | Simpler to build and to explain. One governance note in Part 2. |

---

## Part 2 — Answering "Admin ne leads upload kiya, phir kya hoga?"

The full sequence, start to finish. Nine steps, of which the admin touches three.

### Step 1 — Upload (admin, ~2 minutes)
Admin opens the Upload Centre. Nine boxes, one per channel: Shopify, Meta Ads, Website WhatsApp, Add to Cart, Website Call, WhatsApp Campaign, Delivered Customers, RTO, NC/Refused. Drag the day's file into the matching box. That is the entire manual action.

### Step 2 — Fingerprint (system, instant)
File is hashed. If the same file was uploaded before, it is **refused, not merged** — this is what stops the same Shopify export being counted twice. Raw file is copied to storage permanently, so any batch can be replayed later.

### Step 3 — Column mapping (system, instant)
Header row is hashed and matched against saved templates. On ~95% of days it is a direct hit — no AI runs at all. When a file's layout changes, the AI proposes a mapping with confidence scores, admin confirms once, and the template is saved forever.

### Step 4 — Cleaning (system, ~10 seconds)
Deterministic rules, no AI:
- Phone → 10-digit standard, +91/0/spaces stripped, invalid numbers parked
- Names → title case, emoji stripped (your data contains `Aditi ❤️` and `【G】【u】【p】【t】【a】❣️`)
- Encoding repaired (`à¤®à¥‹à¤¹à¤¨` → `मोहन`)
- Dates → single format
- Payment string → two numbers (`300 prepaid & 2200 cod` → prepaid 300, COD 2200)
- Disposition text → closed vocabulary via alias table
- Product text → SKU via exact match, then alias, then fuzzy
- **Column-shift check:** if more than 20% of a column fails its type test, the whole batch stops

### Step 5 — Identity (system, ~5 seconds)
Each row's mobile is matched against the customer master.
- **Match found** → existing customer. Order history, buyer stage, LTV, previous rep all pulled forward.
- **No match** → new customer created.
- **Close but not certain** (0.80–0.95 confidence) → sent to the review queue.

This is the step that eliminates the 39.3% cross-sheet duplication measured in your files.

### Step 6 — Validation (system, instant)
Mandatory fields, phone validity, pincode-vs-state agreement, value sanity, duplicate-order detection. Each row lands VALID, WARNING or ERROR.

### Step 7 — Review (admin, ~5 minutes)
Admin sees **only the exceptions** — typically 3–8% of rows. Clean rows are never displayed. Bulk-accept warnings, resolve genuine merges individually, park the un-keyable rows. On a 512-row day this is around 26 rows.

### Step 8 — Commit (admin, one click)
Everything writes in one transaction. **Leads land in the Unassigned Pool.** Nothing is assigned. The batch stays reversible for 7 days.

### Step 9 — Assignment (admin, ~3 minutes)
This is where you take over:

```
Open the pool  →  486 leads waiting
        ↓
Filter          Source = Shopify  ·  State = Maharashtra  ·  Received = today
        ↓        (or product interest, or "older than 24h")
Select          [Select all in filter]  or tick a block  or shift-click a range
        ↓
Choose rep      dropdown: Nikita / Divya / Riya / Akruti / Priti / Priyanka / Kajal
        ↓
Assign          one click → 62 leads move
```

Before the leads move, the system warns you about things you'd want to know:
- *Kajal already has 120 open leads* — she is overloaded
- *18 of these leads belong to customers Riya already owns*
- *Megha is on leave*
- *61 leads in the pool are older than 24 hours — assign these first*

You can override every warning. The override is logged.

There is also a **Suggested Split** panel: the system shows what a balanced distribution would look like based on current open workload and last month's yield per rep. One button applies it across the whole filtered pool. **It is advisory only** — it never assigns on its own, and you can edit or ignore it.

### Step 10 — It appears in the rep's portal (instant)
The rep gets a notification. The leads appear in her worklist, ordered by urgency: overdue follow-ups first, then due today, then repeat-purchase-due, then fresh, then ageing.

### The one automatic rule worth keeping
**Untouched leads come back.** Assigned and no activity for 48 hours → alert to admin. 72 hours → lead returns to the pool automatically.

This exists because of something measurable in your own data: the "Other User" block of **174 leads sat with a rep for the full validity window and produced zero orders**. In the current sheet that is a row of zeros nobody reads. Here it is an alert on day two.

---

### 2.1 The dialling decision — and what it actually costs

You want reps dialling from their own handsets and updating the portal, like the sheet. That is fine and it is how most Indian tele-sales teams run. But be clear about the trade:

**What you lose:**
- Reps must see the full mobile number. Masking becomes impossible.
- No call recording → no objective call-quality audit, no dispute resolution, no training material.
- No automatic call duration or connect detection → **"Total Dialling", "Num of Connect" and "Connectivity %" become self-reported numbers.** A rep who claims 40 dials and made 12 cannot be contradicted by the system.
- No automatic activity timestamp — the rep decides when to log.

That third point matters more than it looks. Connectivity % is one of your core MIS metrics today, and under this model it stays exactly as trustworthy as it is now, which is: not very.

**What still protects you:**

| Control | Effect |
|---|---|
| Rep sees only their own assigned leads | Enforced in the database, not the interface. A direct URL returns nothing. |
| No search across the customer base | She cannot look up a customer who was never assigned to her. |
| No export, no download, no print, no API | These buttons do not exist for the Employee role. |
| Max 50 rows per page, no bulk list view | Bulk copying becomes slow and manual. |
| Select-all-and-copy blocked on tables | Friction, not prevention — but it works against the casual case. |
| **Copy-number is a logged event** | Every copy writes a row with rep, lead, timestamp, IP. |
| **Velocity detection** | 4+ copies in 90 seconds → account auto-locked, admin alerted. A human working leads copies one number then talks for four minutes; machine-pace copying is a completely different signature. |
| Session watermark on every screen | Name, code, timestamp, IP behind every data view. A photographed screen leads back to one person. |
| One device, one session, shift-hours only | Login outside the shift or on a second device is blocked. |
| Nothing on their laptop | Today every rep holds a downloadable file with four months of customer PII. That ends on day one. |

**Net position:** you move from "every rep permanently holds a copy of the customer base" to "a rep can slowly extract numbers one at a time and will be flagged within minutes if they try to go fast." That is a very large improvement, but it is *detection and attribution*, not prevention.

**If you want prevention later** — three options, in order of strength:
1. **Cloud dialler with number masking** (Exotel, Servetel, Knowlarity). Rep taps Call, both legs connect server-side, she never sees the number. Roughly ₹0.60–0.90/min plus rental. This also restores call recording, real dial counts, and real connectivity — the three metrics you lose above. **Strongly recommended for Phase 6.**
2. **Partial masking with logged reveal.** `98••••6231` with one-tap reveal, rate-limited and logged. She can still dial from her handset but cannot skim a page of numbers.
3. **Windows desktop shell** that blocks OS-level screen capture. Only useful if reps work from a company office on company machines.

### 2.2 One governance note on two roles

Three admins with identical, mutually unrevocable full access and nobody above them is a gap. Recommendation: keep exactly two *functional* roles as you asked, but make **one account the Owner** — yours or the director's — with the sole ability to add and remove admins, change targets, and adjust incentive rules. Day to day it behaves like an admin account. It just means one person can undo another's actions if needed.

---

## Part 3 — The Complete Report System

This is the heart of what you're asking for. Below is every report the MIS team builds by hand today, rebuilt as a scheduled output, plus the reports they cannot build at all.

### 3.1 Daily reports

| Report | Time | Who gets it | Contents | Replaces |
|---|---|---|---|---|
| **Rep Morning Plan** | 07:30 | Each rep | Gap to target, overdue follow-ups, repeat-due customers, fresh leads, yesterday's realised value | `PlaningSheet` |
| **Daily Lead Pool** | 08:00 | Admin | What arrived, what was assigned, what is unassigned, what is ageing past 24h | New |
| **Exception Digest** | 08:00 | Admin | Files not uploaded, unresolved duplicates, unmapped products, untouched leads, high-risk orders awaiting dispatch | New |
| **Employee Daily Performance** | 21:00 | Admin + owner | Per rep: leads assigned, dials, connects, connectivity %, CD/ND, orders booked, order value, orders delivered, RTO, follow-ups due vs done, untouched count | `Team Audit` tab |
| **Daily Sales Register** | 21:00 | Admin + owner | Every order booked today: customer, source, products, value, company base, employee credit, payment split, state, rep | Order sheets |
| **Daily Dispatch & Status** | 21:00 | Admin + ops | Dispatched, in transit, OFD, delivered, RTO, NDR — counts and value, ageing on anything stuck over 7 days | Manual chase |
| **Management One-Pager** | 21:00 | Owner | Revenue, orders, RTO%, conversion, top rep, top product, pace vs target | Verbal / WhatsApp |

**Employee Daily Performance — exact columns**

`Rep · Leads Assigned · Leads Touched · Untouched · Dials · Connects · Connectivity% · CD · ND · Orders Booked · Booked Value · Orders Delivered · Realised Value · RTO Count · RTO Value · Follow-ups Due · Follow-ups Done · SLA% · Avg Order Value · Credit Earned`

Two reps in your August data made zero dials on a day while holding 57 assigned leads between them. In the current sheet that is a row of zeros. Here it is an alert at 14:00 the same day.

### 3.2 Weekly reports — Monday 09:00

| Report | Answers |
|---|---|
| **Weekly Team Pack** | Week vs target, week-on-week movement per rep, best and worst days, pipeline entering next week |
| **Source Performance** | Which channel gave leads, which converted, value per lead, cost per delivered order where ad spend is entered |
| **Assignment Quality** | Which rep converts which kind of lead — the report that makes your manual assignment sharper each week |
| **Follow-up Hygiene** | Overdue follow-ups by rep and age, leads with zero activity, leads approaching validity expiry |
| **RTO Watch** | RTO by rep, product, state, payment mode, value band; worst pincodes of the week |
| **Data Quality Scorecard** | Duplicate rate, unmapped products, missing dispositions, rows parked as un-keyable |

**Assignment Quality is the most valuable new report in the system for you specifically**, because you are the one assigning. Sample shape:

| Rep | Best on | Yield | Weakest on | Yield |
|---|---|---|---|---|
| Nikita | Shopify upsell | 74% | Meta ads | 4% |
| Divya | Delivered repeat | 19% | RTO recovery | 3% |
| Riya | Breast Care upsell | 2.34× upsell index | Low-value COD | 8% RTO |
| Akruti | WhatsApp campaign | 21% | Skinwise | 6% |

Once you can see this, giving Shopify batches to Nikita and high-value Breast Care to Riya stops being a hunch and becomes a decision. Your assignment gets better every month without the system ever taking the decision away from you.

### 3.3 Monthly reports — 1st of the month, ready by 09:00

**Month-close pack:**

1. **Target vs Achievement** — per rep and team, booked vs realised, integer order counts, AOV, balance
2. **Incentive Statement** — per rep: slab, delivery-quality multiplier, prepaid bonus, product SPIF, clawbacks, net payable, ready for approval
3. **Product Line P&L** — Breast Care, Skinwise, Slimming Care, Intimate Care, Face Care, Hair Care, Customisation
4. **SKU Performance** — units, value, AOV, RTO%, repeat rate per SKU
5. **Source P&L** — leads, conversion, delivered value, value per lead, ROI where spend is entered
6. **Geography Report** — state and top-100 pincode performance, RTO hotspots *(critical for a pan-India COD business)*
7. **Customer Report** — new vs repeat, buyer stage movement, LTV by cohort, dormant list
8. **Operations Report** — dispatch TAT, courier comparison, NDR reasons, RTO recovery rate
9. **Next-Month Plan** — required run rate per rep, pipeline carried forward, repeat-due volume

### 3.4 On demand — the questions management actually asks

| Question | Screen | Today |
|---|---|---|
| Product X ka kitna sale hua? | Product Line P&L → SKU drill | Half a day, and Skinwise returns ₹0 |
| Riya ne kitna revenue diya, kitna deliver hua? | Scoreboard → booked / realised / credited | Chase the rep for her sheet |
| Kaunsa lead source sabse achha chala? | Source Funnel by value per lead | Not answerable |
| Kis campaign ka ROI best raha? | Campaign ROI | Not answerable |
| Kaunse customers repeat ke liye due hain? | Repeat-Due Queue — already in the rep's worklist | Manual re-upload, mostly missed |
| Kis state me RTO sabse zyada hai? | Geography Report → RTO hotspots | Not answerable |
| Pichle March me kya hua tha? | Any report, back-dated | Whatever survives in old files |

---

## Part 4 — What the MIS Team Cannot Do Today, No Matter How Hard They Work

These are not "nice to have." They are capabilities that are structurally impossible in spreadsheets and become available the moment the data model exists. This is the part of the answer to *"company ko aur clearance kaise milegi."*

### 4.1 Pan-India geography intelligence
You ship all over India. Today you have no idea which parts of the country are profitable.

- **RTO heatmap by state and pincode.** Rank the worst 100 pincodes. Some pincodes will show 40%+ RTO on COD — those should be prepaid-only, full stop. This is a decision worth lakhs per month and it is currently invisible.
- **Delivery TAT by state and courier.** Which courier is fastest to the North-East, which is cheapest to Tamil Nadu.
- **Regional product affinity.** Skinwise sells differently in Kerala than in Punjab. Nobody knows this today.
- **Language routing.** Match rep language to customer state. Your data already shows "Language issues" as a disposition — that is a lost sale being recorded and then forgotten.

### 4.2 RTO prevention, before dispatch
Not RTO reporting — RTO *prevention*. A risk score on every order before it ships, built from the history you already have: prior RTO count, prepaid ratio, pincode band, order value, whether the customer was reached before dispatch, product line, courier.

High-risk orders queue up for a confirmation call or a prepaid conversion offer **before the parcel leaves**. Your data already proves the mechanism works: full COD RTOs at ~11%, partial prepaid at ~4%. Converting even a third of high-risk COD orders to ₹300 partial prepaid pays for the whole platform.

### 4.3 Repeat-purchase engine
Delivered date + the SKU's usage period − 5 days = the customer appears in the owning rep's worklist that morning. No upload, no list, no reminder.

Repeat buyers convert several times better than a cold Meta lead and cost nothing to acquire. Today this runs on someone remembering to re-upload "Delivered Customer Data." **This is the highest-ROI automation in the entire build.**

### 4.4 Customer LTV and cohort truth
- Which acquisition source produces customers who buy *three times*, not just once. A Meta lead that converts at ₹899 and never returns is worth less than a WhatsApp lead that converts at ₹1,200 and buys four times.
- Cohort retention by first-purchase month — is your product actually working for customers?
- **Cross-purchase matrix**: Mamo Firm Cream buyers take Mamo Firm Capsules 38% of the time. That drives a scripted bundle offer instead of a guess.

### 4.5 Objection intelligence from Hinglish remarks
You have four months of remarks like *"abhi product hai baad mei lungi"*, *"husband se puchna padega"*, *"amount issue h"*. Overnight, these get normalised and tagged into intent categories. Then you can answer:

- What is the #1 reason people don't buy, by product and by state?
- Which objection do your best reps overcome that others don't?
- Which product gets "price too high" most often — a pricing signal, not a sales signal

This is completely invisible in a spreadsheet and it is sitting in your data right now.

### 4.6 Fraud and leakage detection
- Orders booked and cancelled repeatedly by the same rep
- Disposition changed after the fact
- Customers marked "not interested" who then order through another rep
- Order values edited post-delivery
- The copy-velocity detection described in Part 2

### 4.7 Forecasting that isn't a straight line
Today: per-day average × days remaining. No pipeline, no seasonality, no RTO subtraction — which is why it over-forecasts every month.

Replacement: open pipeline × stage probability + run-rate × remaining days × seasonality, minus expected RTO. And a **daily "will we hit target" signal**, so a shortfall is visible on the 12th rather than the 31st.

### 4.8 Inventory and demand signal
Once SKU-level orders exist, you get a forward view of demand by SKU — which feeds production and purchase planning. You currently have no reliable SKU-level number at all, because product is a free-text column.

### 4.9 The strategic clarity, summarised

| Question the owner can't answer today | After |
|---|---|
| Which product line actually makes money? | Product P&L with correct allocation |
| Which state should we stop shipping COD to? | RTO heatmap by pincode |
| Which acquisition channel gives lifetime value, not just orders? | LTV by source cohort |
| What is a customer worth over 12 months? | Cohort LTV |
| Why do people say no? | Objection intelligence |
| Which rep is genuinely good vs holding good leads? | Source-normalised scoring |
| Are we going to hit target? | Daily forecast signal |
| What is our real margin after RTO? | Realised revenue net of RTO and shipping |

---

## Part 5 — Automation Ranked by Workload Removed

| # | Automation | Hours saved/month | Build effort | Phase |
|---|---|---|---|---|
| 1 | **All MIS report generation** | 60–80 | Medium | 4 |
| 2 | **Bulk lead assignment** | 20–25 | Low | 1 |
| 3 | **File ingestion + dedupe + cleaning** | 30–40 | Medium | 2 |
| 4 | **Repeat-purchase due queue** | 10–15 (+ large revenue gain) | Low | 3 |
| 5 | **Upsell credit calculation** | 8–10 (+ recovers 31% leakage) | Low | 3 |
| 6 | **Incentive computation** | 8–12 | Low | 3 |
| 7 | **Follow-up reminders + escalation** | 6–8 | Low | 3 |
| 8 | **Untouched-lead recall** | 4–6 | Low | 3 |
| 9 | **RTO/NDR recovery lead creation** | 6–8 | Low | 2 |
| 10 | **Scheduled digest delivery (WhatsApp/email)** | 10–12 | Low | 4 |
| 11 | **Product-to-SKU resolution** | 6–8 | Medium | 2 |
| 12 | **Hinglish remark normalisation** | — (new capability) | Medium | 4 |
| 13 | **RTO risk scoring** | — (margin, not hours) | High | 6 |
| 14 | **Courier status sync** (if API later allowed) | 10–15 | Medium | 6 |
| 15 | **WhatsApp templated send from CRM** | 8–10 | Medium | 6 |

**Total recurring manual work removed: roughly 180–240 hours per month.** That is more than one full-time person's month, which is exactly the outcome you described — the MIS team stops producing reports and starts doing analysis.

---

## Part 6 — Revised Roadmap

Slightly shorter than v1, because the automated assignment engine and telephony integration both come out of the critical path.

| Phase | Weeks | Deliverable | Exit criteria |
|---|---|---|---|
| **0 — Foundation** | 1–2 | Metric dictionary signed. SKU master with Shopify base prices and usage days. Employee master. Source and disposition masters. Historical extract from 9 workbooks. | Signed dictionary; SKU master complete |
| **1 — Core platform** | 3–6 | Auth, 2 roles, RLS. Customer golden record. Order ledger with lines. Activity log. Admin console. Employee portal. **Bulk assignment console.** | One rep runs a full week in the CRM; numbers reconcile within 1% |
| **2 — Ingestion** | 7–10 | All 9 upload channels, fingerprinting, AI column mapping, cleaning, identity resolution, exception review, rollback. Historical backfill Apr–Aug. | Admin does a full day's upload in under 25 min; **Sheets frozen; whole team live** |
| **3 — Scoring & lifecycle** | 11–13 | Attribution ledger (booked/realised/clawback). Incentive engine. Performance scoring. Repeat-purchase engine. Follow-up automation and untouched-lead recall. | One month's incentive computed by the system and reconciled manually |
| **4 — MIS automation** | 14–17 | Full daily/weekly/monthly report suite. Scheduled digests. Alerting. Hinglish remark normalisation. Corrected RTO-adjusted targets. | **`MIS_Driven_Audit_Sheet-2025` retired. No human prepares a report for one month.** |
| **5 — Hardening** | 18–20 | Watermarking, copy-velocity detection, access logging, session controls. Pen test. DR drill. Training. | Clean pen test; successful restore drill |
| **6 — Intelligence** | 21–24 | RTO risk model. Geography heatmap. Cross-purchase engine. Campaign ROI. Pipeline forecast. *Optional: cloud dialler, courier sync, WhatsApp send.* | RTO model shows lift on a held-out month |

**24 weeks to full deployment. Off Google Sheets at Week 10.**

---

## Part 7 — Decisions Still Needed

| # | Decision | Blocks |
|---|---|---|
| 1 | Confirm the definitive employee roster. Brief says 7, Achieve Report has 11, Scoreboard has 10. | Targets, assignment, incentive |
| 2 | Approve **realised-basis** scoring — incentive on delivery, not booking, with automatic RTO clawback. | The most consequential rule in the system |
| 3 | Approve rep-specific RTO buffers replacing the flat 15%. Kajal's daily requirement moves ₹10,511 → ₹15,491. | Target-setting conversations |
| 4 | Confirm `usage_days` per SKU. | Repeat-purchase engine |
| 5 | Confirm Shopify base price per SKU (₹899 / ₹849 / ₹949 clusters observed). | Automatic upsell credit |
| 6 | Historical depth — Apr–Aug 2026 only, or the full archive back to Sept 2025? | Phase 0 effort, RTO model training data |
| 7 | Nominate the **Owner** account above the three admins. | Governance |
| 8 | Cloud dialler in Phase 6 — yes, no, or decide later? | Whether dial/connect metrics ever become real |

---

*Prototype v2 reflects every change in this addendum. Open the Admin portal → Lead assignment tab to see the bulk-assign flow, and Reports & MIS → Daily & monthly MIS for the full report system.*
