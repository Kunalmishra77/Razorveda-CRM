# Razorveda CRM & MIS Platform

Internal CRM and MIS automation for Razorveda — an Indian ayurvedic D2C brand shipping COD
pan-India with a 7-person tele-sales team.

## Getting started

1. Open this folder in VS Code.
2. Open Claude Code in the integrated terminal.
3. Open `prompts/00-kickoff.md`, copy the prompt inside the code block, and paste it as your first
   message.
4. Read what comes back. Argue with it. Then say "go".

## What is in here

```
CLAUDE.md            Standing context for Claude Code. Read first, every session.
prompts/             The kickoff prompt, one prompt per phase, and utility prompts.
docs/                The specification. Nine documents.
tasks/               Seven phase definitions with exit criteria.
db/                  schema.sql, rls-policies.sql, and seed CSVs.
fixtures/            Deliberately messy test files reproducing the client's real data defects.
design/              Clickable prototype + design tokens.
```

## Reading order for a human

1. `docs/00-product-brief.md` — what this is and who uses it
2. `docs/08-audit-findings.md` — every defect in the current system, measured
3. `design/prototype.html` — open in a browser, click through all six sections
4. `docs/03-metric-dictionary.md` — the definitions everything else depends on
5. `docs/09-decisions-log.md` — what is decided and what still needs your call

## Before Phase 0 starts

Ten open decisions are listed in `docs/09-decisions-log.md`. Items **O-01** (employee roster),
**O-02** (Shopify base prices) and **O-08** (working calendar) block Phase 0 directly — the seed
data currently contains best guesses derived from the client's spreadsheets, not confirmed values.

## Ground rules

- Nothing gets built until `docs/03-metric-dictionary.md` is signed off.
- AI never computes a number. All arithmetic is SQL over immutable facts.
- Employee isolation is enforced by Postgres RLS, not by application code.
- Incentive is earned on delivery, not booking.
- Leads are never assigned automatically.

## Reference documents

`docs/reference/` holds the two original planning documents this repo was built from. They are
background, not the working spec — the working spec is `docs/00` through `docs/10`.

- `blueprint-v1.md` — the original A-to-Z architecture review with the full audit
- `addendum-v2.md` — the revised operating model (manual assignment, handset dialling, two roles)

## RLS caveat — read before testing isolation

Postgres table **owners bypass RLS**. The migration user owns the tables; the application must never
connect as that user. Every isolation test must run as `app_role`:

```sql
SET ROLE app_role;
SET app.user_role = 'EMPLOYEE';
SET app.user_id   = '<employee uuid>';
SELECT count(*) FROM lead;                  -- only that rep's leads
SELECT count(*) FROM customer_identifier;   -- only their customers' phones
RESET ROLE;
```

Running the same check as the owner returns every row and looks like a failure — or worse, is run
without `SET ROLE`, returns the right number by accident, and everyone believes isolation works.
