# Phase 2 — Ingestion Engine (Weeks 7–10)

## Goal
Admin uploads nine files and reviews ~5% of rows. Everything else is automatic.
**This is the phase that gets the team off Google Sheets.**

## Build order — do not reorder

### 1. Normalisation library FIRST (week 7)
`packages/shared/normalise/` — pure functions, no I/O, no AI.
Write tests from `fixtures/` **before** the implementation. Every fixture must parse correctly
before any other Phase 2 work begins. Functions and rules are specified in `docs/06` §3.

### 2. Batch model + fingerprinting (week 7)
- SHA-256 unique on `ingestion_batch.file_hash`
- Raw file to MinIO, immutable
- `ROLLBACK BATCH` restoring prior state from the append-only event log

### 3. Column mapping (week 8)
- Header signature hash → template lookup
- AI path only on a miss; never auto-apply below 0.9 confidence
- Template saved on admin confirmation with `confirmed_by`

### 4. Identity resolution (week 8)
Per `docs/06` §4. Auto-merge >0.95, queue 0.80–0.95, create below.

### 5. Validation + column-shift detector (week 9)
Per `docs/06` §5. `corrupted_column_shift.csv` **must** be rejected as `SHIFTED`.

### 6. Exception review UI (week 9)
Admin sees only exceptions. Clean rows never rendered. Bulk actions. Side-by-side merge view.

### 7. Commit + pool (week 9)
Single transaction. Leads land unassigned.

### 8. Historical backfill + reconciliation (week 10)
- Parse all nine client workbooks
- Per-file data-quality report: duplicate rate, invalid phones, column-shift ranges, disposition
  variants, unmapped products
- **Reconciliation report**: rebuild Apr–Aug MIS from the new DB, compare to the existing Achieve
  Report per rep, and *explain* each variance in writing. Skinwise moving from ₹0 to ~₹2.5L is the
  system working correctly, not a bug. Never quietly "fix" history — load it as it was, flag what
  was wrong, and let the report explain the difference.

## Exit criteria

| # | Criterion | Proof |
|---|---|---|
| 1 | Every fixture parses to spec | `npm test -w packages/shared` — counts match `fixtures/README.md` |
| 2 | Duplicate file refused | Upload the same file twice; second is rejected with a clear message |
| 3 | Column shift caught | `corrupted_column_shift.csv` → batch status `SHIFTED`, zero rows staged |
| 4 | Payment parsing | `300 prepaid & 2200 cod` → prepaid 300, cod 2200, mode PARTIAL_PREPAID |
| 5 | Disposition aliases | All 49 client variants map to the closed list |
| 6 | Dedupe | `delivered_data_sample.csv` resolves 7 rows to customers already created by the Shopify fixture |
| 7 | Rollback | Commit then roll back; all derived state restored |
| 8 | Admin day under 25 min | Timed run across all nine channels, under 5% exceptions |
| 9 | **Cutover** | Sheets read-only. Full team live. |
