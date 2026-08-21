# 07 — UI Specification

Visual reference: `design/prototype.html`. Open it in a browser. Match the information architecture
and the density; you do not need to match the CSS exactly.

## 1. Shell

Left rail (dark) + top bar + workspace. Two route groups: `(admin)` and `(employee)`.
Design tokens in `design/design-tokens.md`. Numbers are always monospace with tabular figures —
this is an MIS tool and columns must align.

## 2. Admin console — modules

```
1  Upload Centre          9 channel drop boxes · batch history · rollback
2  Exception Review       mapping · duplicates · merge queue · column-shift alerts
3  Lead Assignment        unassigned pool · filter · bulk select · assign · transfer log
4  Employees              roster · targets · WIP · access · offboarding
5  Customer 360           search · history · merge · DNC · ownership
6  Orders & RTO           status · AWB · RTO/NDR console · pre-dispatch risk queue
7  Master Data            SKUs · lines · sources · dispositions · calendar · rules · slabs
8  Reports & MIS          full catalogue (docs/04)
9  Audit & Security       access log · velocity alerts · sessions · audit trail
```

## 3. Lead Assignment — the most important admin screen

```
┌─ Filters ──────────────────────────────────────────────────────┐
│ Source ▾   State ▾   Product line ▾   Received ▾                │
│ [Select all in filter] [Clear] [Select first 25]               │
└────────────────────────────────────────────────────────────────┘
┌─ Unassigned pool ──────────────────────────── 486 · 0 selected ─┐
│ ☐ Customer      Mobile       Source    Interest   State  Value │
│ ☐ Priyanshi…    8076845536   Shopify   Mamo Firm  UP     ₹3,000│
│ …                                                              │
└────────────────────────────────────────────────────────────────┘
  Assign to [ Nikita ▾ ]  [Assign selected]
```

Requirements:
- Checkbox column, header select-all, **shift-click range selection** (reps think in spreadsheet
  terms — this must feel familiar)
- "Select all in filter" selects across pagination, not just the visible page
- Warnings shown **before** assigning, never blocking:
  - `Kajal already has 120 open leads`
  - `18 of these belong to customers Riya already owns`
  - `Megha is on leave`
  - `61 leads in the pool are older than 24 hours`
- Overrides are permitted and logged
- **Suggested Split** side panel: proposed distribution from current open workload + last month's
  yield. One button applies it across the filtered pool. Advisory only — never assigns on its own.
- Every assignment writes an append-only `lead_assignment` row with method and reason

## 4. Employee portal

```
1  My Day          target vs realised · required run-rate · rank · today's plan
2  Worklist        priority queue (never a raw list)
3  Lead Detail     full number · copy · mark dialled · disposition · remark · follow-up
4  Order Entry     SKU picker · payment split · live credit preview
5  My Performance  own metrics only · score breakdown · incentive projection
```

**Worklist ordering is fixed and not user-sortable:**
```
1  Overdue follow-ups        (red)
2  Due today                 (amber)
3  Repeat-purchase due       (green — highest conversion)
4  Fresh assigned today      (neutral)
5  Ageing, validity expiring (grey)
```

**Lead Detail rules:**
- Full mobile shown. A `Copy` button that writes `pii_access_log`. A `Mark dialled` button that
  writes an activity row.
- Disposition is a **closed dropdown**. Save is blocked without one.
- If the disposition requires a follow-up date, save is blocked without the date.
- Remark field accepts Hinglish and stores it verbatim. Never auto-correct the rep's text.
- Customer 360 panel: previous orders, LTV, buyer stage, RTO history, last objection.

**Order Entry rules:**
- SKU picker with live pricing, multiple lines
- Prepaid and COD are **two separate numeric fields**, never one free-text field
- Live credit preview: `Order ₹2,000 · Company base ₹500 · Your credit ₹1,500 (realises on delivery)`
- The rep sees exactly how they are scored, as they sell

## 5. Copy and error states

- Active voice. `Save changes`, not `Submit`. The button that says `Assign` produces a toast that
  says `Assigned`.
- Errors state what happened and what to do: `File already uploaded on 19 Aug. Upload a different
  file or roll back batch B-19826-11.` Never `Something went wrong`.
- Empty states are invitations: `No leads assigned yet. Ask your admin to assign from the pool.`
- No blame, no apology, no vagueness.

## 6. Quality floor

Responsive to mobile · visible keyboard focus · `prefers-reduced-motion` respected · all data
tables keyboard-navigable · no colour-only status encoding (always pair with text or icon).
