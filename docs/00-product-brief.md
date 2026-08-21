# 00 — Product Brief

## The company

**Razorveda** is an Indian ayurvedic D2C brand. Products ship COD across all of India. Sales come
from a 7-person tele-sales team managed by admins.

**Product lines:** Breast Care · Skinwise · Slimming Care · Intimate Care · Face Care · Hair Care ·
Customisation

## The people

| Role | Who | What they do in this system |
|---|---|---|
| **Owner** | Business owner | Sees everything. Only account that can add/remove admins, set targets, change incentive rules. |
| **Admin** | Sunita, Sonam, Sonia | Upload daily files. Review exceptions. Assign leads in bulk. Manage customers, orders, masters. Read all MIS. |
| **Employee** | Nikita, Divya, Riya Chauhan, Akruti, Priti, Priyanka, Kajal | Work their assigned leads. Dial from their own handset. Log outcomes. Create orders. See only their own numbers. |

There is no team lead tier and no separate executive portal. Two functional roles.

## The problem, in one paragraph

Leads arrive from nine channels. Admins paste them by hand into nine separate Google Sheets, one per
rep. Reps update their own sheet. An MIS team then rebuilds a company dashboard by pulling from all
nine files via IMPORTRANGE and 72 hardcoded cell references. The result: the same customer exists in
up to eight places, 10.9% of rows have no usable phone number, product revenue is wrong (Skinwise
reports ₹0 against ₹2.5L of actual sales), 31% of upsell commissions are miscalculated, order counts
are fractional, and every rep holds a downloadable copy of four months of customer PII on their own
laptop.

## What we are building

A single web application where:
- Admins upload nine files a day and review ~5% of rows as exceptions
- Leads land in an unassigned pool
- Admins distribute them in bulk: filter → tick → pick a rep → assign
- Reps work a prioritised worklist, dial from their handset, log outcomes and orders
- Every report the MIS team builds by hand is generated automatically on a schedule
- Every number resolves to one definition, in one place, reproducible for any past period

## Success looks like

| # | Criterion | Measure |
|---|---|---|
| 1 | Zero manual MIS preparation | No human prepares a report for one full month |
| 2 | Admin daily data workload | Under 25 minutes across all nine channels |
| 3 | Duplicate customer rate | Under 1% (from a measured 39.3% cross-sheet redundancy) |
| 4 | Un-keyable records | Under 1% (from 10.9%) |
| 5 | Attribution accuracy | 100% of eligible orders auto-split (from 69%) |
| 6 | Product P&L completeness | Every order line mapped to a line; Skinwise non-zero and correct |
| 7 | Order count integrity | Integer everywhere; no derived fractional counts |
| 8 | Report latency | Any management question answered within 15 minutes of data currency |
| 9 | Employee isolation | Verified by test — zero cross-rep leakage |
| 10 | Metric consistency | One definition per KPI; no two screens disagree |
| 11 | Auditability | Any historical number reproducible and traced to source rows |
| 12 | Recoverability | Monthly restore drill passes; RPO ≤ 15 min, RTO ≤ 4 hours |
| 13 | Adoption | 100% of orders and dispositions in the CRM; Sheets read-only |

## Deliberately out of scope

Auto-assignment engine · click-to-call / telephony / call recording · direct Shopify/Meta/WhatsApp
API integrations · team lead role · executive portal · native mobile apps · multi-tenancy ·
any export capability for the EMPLOYEE role.
