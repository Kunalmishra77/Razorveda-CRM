# 02 — Data Model

The authoritative DDL is `db/schema.sql`. This document explains the *why*, which the SQL cannot.

## Entity map

```
                      ┌──────────────┐
                      │   customer   │  surrogate UUID PK (D-01)
                      └──────┬───────┘
   ┌─────────────────────────┼─────────────────────────┐
   │                         │                         │
customer_identifier        lead                     "order"
 phone/alt/email      one per arrival           header + lines
 many → one           from a source                    │
                           │                     order_line ── sku ── product_line
              ┌────────────┼──────────┐                │
       lead_assignment  activity      │        order_status_event
        (append-only)  (append-only)  │          (append-only)
                                      │                │
                              attribution_ledger (append-only) ── money
```

## Why each unusual choice exists

**Surrogate `customer_id`, phone as a unique business key.**
10.9% of the client's historical rows have no valid phone (F2) and still need to exist. Alt numbers
are already in use. Families share numbers. People change numbers. A phone PK would orphan an entire
order history on a number change. `customer_identifier` holds many identifiers per customer with a
type and a confidence.

**`order_line` is mandatory.**
Product P&L is computed by joining `order_line → sku → product_line`. The client's current single
"Product" column is why Skinwise reports ₹0 against ₹2,51,698 of actual sales (F8). A multi-line
order must split across categories.

**`prepaid_amount` and `cod_amount` are two numeric columns.**
The client's `Payment Mode` is free text with 121 variants (F5). Prepaid ratio is the strongest RTO
predictor available and is currently unmeasurable. `prepaid_ratio` is a generated column so it can
never drift from its inputs.

**`company_base_value` lives on the order.**
Looked up from `sku.shopify_base_price` at ingest, never typed. 16 of 52 Shopify rows currently
credit the full order value to the rep because a human forgets the subtraction (F7).

**Append-only tables.**
`order_status_event`, `activity`, `lead_assignment`, `attribution_ledger`, `audit_log`,
`pii_access_log`. A trigger raises on UPDATE and DELETE. This is what makes a March report
reproducible in December, and what makes "achieved exceeds booked" (F10) structurally impossible.

**`disposition` + `disposition_alias`.**
One tab in the client's data has 49 spellings of ~12 outcomes (F4). A closed vocabulary with an
alias table both cleans the future and correctly imports the past.

**`lead.assigned_to` is nullable.**
`NULL` means the lead is in the unassigned pool. There is no separate pool table — the absence of an
assignment *is* the pool. Indexed with a partial index for fast pool queries.

**`customer.customer_type` and `stage` are derived.**
Never uploaded, never settable through the API. The client's current `Client Category` column
contains PIN codes on fourteen rows because it is hand-typed.

**`working_calendar`.**
Every "per day required" metric divides by remaining working days. That number must come from a
table, not from a hardcoded assumption about weekends.

## Naming conventions

- Tables singular: `customer`, not `customers`. `"order"` is quoted — it is a reserved word.
- Timestamps `*_at`, dates `*_date`, booleans `is_*` / `has_*` / `ever_*`.
- Money `numeric(12,2)`. Never float. Never integer paise.
- Enums in Postgres, mirrored as const objects in `packages/shared`.
