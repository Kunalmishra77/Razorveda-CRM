# 06 — Ingestion Specification

## The nine channels

| # | `lead_source.code` | Creates | Attribution | Validity |
|---|---|---|---|---|
| 1 | `SHOPIFY` | Customer + Order (base value set) | `UPSELL_DELTA` | 3 days |
| 2 | `META_ADS` | Lead | `FULL_CREDIT` | 7 days |
| 3 | `WEB_WHATSAPP` | Lead | `FULL_CREDIT` | 5 days |
| 4 | `ADD_TO_CART` | Lead + intent SKUs | `FULL_CREDIT` | 2 days |
| 5 | `WEB_CALL` | Lead | `FULL_CREDIT` | 1 day |
| 6 | `WA_CAMPAIGN` | Lead, sometimes Order | `UPSELL_DELTA` if order present | 7 days |
| 7 | `DELIVERED_REPEAT` | Repeat-purchase lead | `FULL_CREDIT` | 30 days |
| 8 | `RTO_RECOVERY` | Order status event + recovery lead | `FULL_CREDIT` | 15 days |
| 9 | `NC_REFUSED` | Order status event + recovery lead | `FULL_CREDIT` | 3 days |

## Seven stages

### 1. Upload & fingerprint
- Accept `.xlsx`, `.xls`, `.csv`. Max 20 MB.
- Compute SHA-256 of raw bytes. `ingestion_batch.file_hash` is UNIQUE.
- Duplicate hash → **refuse with a clear message**, do not merge. This is what stops daily Shopify
  exports being counted twice.
- Copy raw file to MinIO immutably. Never overwrite.

### 2. Column mapping
- Hash the sorted, trimmed, lowercased header row → `header_signature`.
- Look up `column_mapping_template(source_id, header_signature)`.
- **Hit** → apply, no AI. Expected on ~95% of days.
- **Miss** → send headers + 5 sample rows to the AI adapter. It returns
  `{ sourceHeader: targetField, confidence }` per column. Present to the admin for confirmation.
  On confirm, save the template with `confirmed_by`. Never auto-apply a mapping below 0.9 confidence.

### 3. Normalisation — pure functions, no I/O, no AI

Build these first, in `packages/shared/normalise/`, with tests written from `fixtures/` before the
implementation.

| Function | Rule |
|---|---|
| `normalisePhone(v)` | Strip non-digits. Drop trailing `.0`. Remove leading `91` if length 12, leading `0` if length 11. Valid only if length 10 and first digit ∈ {6,7,8,9}. Else `null` → row parked. |
| `normaliseName(v)` | Trim, collapse whitespace, strip emoji and decorative unicode (`【】`, `❣️`, `❤️`), title case. Never empty-string a row out of existence — keep `Unknown` and flag. |
| `repairEncoding(v)` | Detect Latin-1-read-as-UTF-8 mojibake (`à¤®à¥‹à¤¹à¤¨`) and re-decode. Preserve Devanagari. |
| `normaliseDate(v, sourceLocale)` | Handle Excel serials, `15-06-26`, `2026-12-06`, `06/12/2026`. Ambiguous DD-MM vs MM-DD resolved by the source's configured locale rule. Reject future dates beyond +1 day. |
| `parsePayment(v)` | Return `{ mode, prepaidAmount, codAmount }`. Handle `COD`, `prepaid`, `300 prepaid & 2200 cod`, `849 webpay & 1650 cod`, and misspellings `preapid`/`prepiad`/`preapaid`/`webpay`. Unparseable → flag as WARNING, do not guess. |
| `resolveDisposition(v)` | Lowercase, trim, look up `disposition_alias`. Miss → AI single-shot classify into the closed list → still unsure → `OTHER` + flag. |
| `resolveSku(text)` | Exact `sku_code` → exact `product_name` → `name_aliases` → `pg_trgm` similarity (accept ≥0.55, `similarity()` on normalised text) → human queue. **No pgvector (D-14)**; `name_embedding` does not exist. |

### 4. Identity resolution
```
exact match on customer.primary_phone                     → UPDATE existing
match on customer_identifier(type in MOBILE/ALT, value)   → UPDATE existing
fuzzy: name similarity ≥0.85 AND same pincode             → MERGE candidate (queue)
no match                                                  → CREATE new
```
Auto-merge above 0.95 confidence. 0.80–0.95 → review queue. Below → new record.
`customer_type` (NEW/EXISTING) is **derived here**, never read from the file.

### 5. Validation

Row-level:
- Mandatory fields per source
- Phone validity (else `ERROR`, parked)
- Pincode ↔ state consistency (`WARNING`)
- Value sanity: `final_value > 10 × sku.mrp` → `ERROR`
- Duplicate order: same customer + SKU + value within 48 h → `WARNING`
- Future dates → `ERROR`

Batch-level — **the column-shift detector**:
> If more than 20% of the non-null values in any mapped column fail that column's type check,
> mark the whole batch `SHIFTED` and stop before staging. Show the admin which column and a sample.

The batch, not the row. A shift is a property of the file, and importing the 80% that happened to
pass would scatter corruption through the customer master where it is far more expensive to find.

This is what would have caught finding F3 in April instead of never.

#### 5.1 Type contracts per target field (defect B10, decision O-12)

**The detector is only as deep as these contracts.** Without them it watches one column:
`Order Status` is an enum, so a customer name fails it loudly — but a PIN code dropped into a
free-text `Client Category` passes everything, and the shift goes unnoticed. That is precisely how
F3 survived for months.

| Contract | Rule | Applied to |
|---|---|---|
| `PHONE` | Passes `normalisePhone` — 10 digits starting 6-9 after prefix stripping | `primary_phone`, alt numbers |
| `PINCODE` | 6 digits, first digit **1-8**. A **9** prefix is the Army Postal Service — structurally valid, but flagged as a dispatch risk rather than a typo, because many couriers will not deliver to an APO address. A military family is still a customer. | `ship_pincode`, `customer.pincode` |
| `AWB` | Numeric, length **9-16** | `awb_number` |
| `ENUM` | Value present in the closed set, case-insensitive | `current_status`, `payment_mode`, disposition |
| `DATE` | Parses under the source's configured locale, and is not in the future | `order_date`, `delivered_date`, `rto_date` |
| `MONEY` | Decimal, at most 2dp, within optional bounds | `final_value`, `prepaid_amount`, `cod_amount` |
| `INTEGER` | Whole number within optional bounds | `quantity` |
| `FREE_TEXT` | **Cannot fail a type check.** Heuristic instead — see below. | names, addresses, categories, remarks |

**The free-text heuristic.** A free-text column is invisible to the ordinary check, so ask a
different question: *does this column suddenly look structured?* If more than **60%** of its
non-empty values parse as a PIN code, an AWB, a phone number or a bare number, flag it.
`Client Category` holding `247232` and `440023` is not a category — it is a PIN code column that
slid one place left.

The 60% threshold is deliberately looser than the 20% type threshold. A real category column
occasionally holds `2 Pack` or a size, and crying shift on a legitimate file costs an admin their
morning — an admin who learns to click through the warning has lost the whole control. The typed
and enum columns are the primary signal; the heuristic is the backstop for columns that would
otherwise be blind.

**Empty cells are never failures.** A sparse column is a completeness question, not a type
question; counting blanks as failures would reject every file with an optional column.

### 6. Exception review
- Admin sees **only** rows with status `WARNING`, `ERROR` or `DUPLICATE`. Clean rows are never
  rendered — that is the entire point.
- Bulk actions: accept all warnings, fix-and-retry, discard, park.
- Merge candidates show both records side by side with the fields that differ highlighted.
- Target: under 5 minutes on a 500-row day (~26 exception rows).

### 7. Commit
- Single transaction. Staging → live.
- Creates leads (unassigned), orders, order lines, status events.
- Recalculates `customer_type`, `buyer_stage`, `lifetime_orders`, `lifetime_value`, `next_due_date`.
- Writes `ingestion_batch.status='COMMITTED'`.
- **Leads land in the unassigned pool. Nothing is assigned.**
- Reversible via `ROLLBACK BATCH` for 7 days, using the append-only event log to restore state.

## Idempotency summary

| Level | Mechanism |
|---|---|
| File | SHA-256 unique constraint |
| Row | Natural key `(source_id, external_ref)` or `(phone, order_date, final_value)` |
| Batch | `ROLLBACK BATCH` within 7 days |
| Replay | Raw file retained; re-process after a rule fix without re-download |

## Where AI is allowed

| Use | Fallback if it fails |
|---|---|
| Column mapping on unseen headers | Admin maps manually once |
| Disposition free-text → closed list | Alias table only; miss → `OTHER`, flagged |
| Product text → SKU tie-break | Human resolution queue |
| Hinglish remark → English + intent tags (nightly, offline) | Raw remark retained and displayed |

**Forbidden:** computing any money figure, deciding assignment, calculating any score, changing an
order status, writing to the attribution ledger.


---

## Money column mapping — read this twice (defect B8)

There is a naming collision between the client's spreadsheets and our schema that will cause a
silent, expensive bug if it is missed.

| Client sheet column | What it actually contains | Maps to |
|---|---|---|
| `Total amount` / `Amount` | **The full order value.** What the customer pays. | `order.final_value` |
| `Final amount` | **NOT the order total.** It is the manually-typed employee credit — the upsell delta. | `order.legacy_credit_value` (reconciliation only) |

`order.final_value` is the total. The sheet's `Final amount` is the credit. **The words are
inverted.** A mapper that matches on the word "final" will corrupt every historical order.

### Rules

1. `final_value` = `Final amount` **only if** `Total amount` is absent. Otherwise
   `final_value = Total amount`, always. In `fixtures/shopify_orders_sample.csv` all ten rows have
   `Total amount` populated and `Final amount` blank, so `final_value` comes from `Total amount`.
2. `company_base_value` is **never** read from a file. It is looked up from
   `sku.shopify_base_price` for `UPSELL_DELTA` sources, else 0. This is the whole fix for the 31%
   attribution leakage in the client's current process.
3. `employee_credited_value = final_value - company_base_value`, computed, never imported.
4. `legacy_credit_value` exists only so the Phase 2 backfill can produce a reconciliation report
   showing where the client's manual figure disagreed with the computed one. It is never used in a
   metric, a score, or an incentive calculation. Expect roughly 31% of Shopify rows to disagree.
5. The column-mapping template must treat `Final amount` as an **explicitly blocked** target for
   `final_value`. Add it to the mapper's deny-list, not just its heuristics.
