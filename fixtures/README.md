# Test Fixtures

These files reproduce the **exact mess** found in the client's real workbooks. They are not clean
sample data — they are the test suite for the ingestion pipeline.

**Rule: write the normalisation tests from these files before writing the implementation.**
Every file here must parse correctly before any other Phase 2 work begins.

| File | Deliberate defects it tests |
|---|---|
| `shopify_orders_sample.csv` | Header variants (`Phone no`, `CustomerName`, `ProductDeatil`), partial-prepaid payment strings, upsell base-price lookup |
| `meta_ads_sample.csv` | Emoji in names, `+91` and `0` phone prefixes, duplicate leads inside one file |
| `wa_campaign_sample.csv` | Mojibake Devanagari, payment misspellings, ambiguous dates |
| `delivered_data_sample.csv` | Cross-file duplicates against Shopify, 49-variant dispositions, repeat-purchase seed data |
| `rto_sample.csv` | Order status events for existing orders, AWB numbers |
| `nc_refused_sample.csv` | Failed-delivery events, recovery lead creation |
| `corrupted_column_shift.csv` | **Column shift** — customer names inside `Order Status`, PIN codes inside `Client Category`. This file MUST be rejected as `SHIFTED`, not ingested. |
| `edge_cases.csv` | Invalid phones (`code`, blanks, 9 digits, 11 digits), value sanity failures, future dates, `.0` float phones |

## Expected outcomes

```
shopify_orders_sample.csv     10 rows →  9 valid,  1 warning (payment unparsed)
meta_ads_sample.csv           10 rows →  8 valid,  2 duplicate (in-file)
wa_campaign_sample.csv         8 rows →  7 valid,  1 warning (ambiguous date)
delivered_data_sample.csv     10 rows → 10 valid,  7 resolve to EXISTING customers
                              (overlap with shopify_orders_sample.csv, verified by count)
rto_sample.csv                 5 rows →  5 valid, all matched to existing orders
nc_refused_sample.csv          4 rows →  4 valid
corrupted_column_shift.csv     8 rows →  BATCH REJECTED, status = SHIFTED
edge_cases.csv                10 rows →  4 valid,  4 parked,  2 errors
```

Assert these counts in the test suite. If a count changes, either a bug was introduced or the
expectation needs updating — both are worth stopping for.


## Exact expectations for `edge_cases.csv`

Verified row by row. Any test written against this file must match these counts.

| Row name | Phone outcome | Row status | Why |
|---|---|---|---|
| Valid Customer One | `9876543210` | **VALID** | baseline |
| No Phone At All | — | **PARKED** | blank, un-keyable |
| Literal Text Phone | — | **PARKED** | literal string `code` |
| Float Phone | `9876543211` | **VALID** | `.0` suffix stripped |
| Nine Digit Phone | — | **PARKED** | 9 digits |
| Eleven Digit Zero | `9876543212` | **VALID** | leading `0` stripped |
| Landline Prefix | — | **PARKED** | starts with 5 |
| Insane Value | `9876543213` | **ERROR** | ₹98,400 on a ₹1,450 MRP SKU (>10×) |
| Future Date Row | `9876543214` | **ERROR** | order date in the future |
| Shared Alt Number | `9876543215` | **VALID + WARNING** | alt `9650121669` appears on unrelated customers |

**Totals: 4 VALID · 4 PARKED · 2 ERROR.**
