# Razorveda CRM & MIS Platform

Internal CRM and MIS automation for Razorveda — an Indian ayurvedic D2C brand shipping COD
pan-India with a 7-person tele-sales team.

It replaces nine Google Sheets and a hand-built MIS pack. The CRM is the smaller half. The larger
half is that there is currently no single trustworthy definition of a customer, an order, or a
salesperson's number.

---

## Set up in 15 minutes

**Prerequisites:** Node 20+. **No Docker required.**

```bash
git clone <repo> && cd razorveda-crm
npm install                       # ~2 min; includes real PostgreSQL 16 binaries

npm run pg:start                  # starts Postgres 16 on 127.0.0.1:5433 from .pgdata
cp .env.example .env              # defaults already point at it
npm run db:migrate                # schema.sql + rls-policies.sql
npm run db:seed                   # masters, 13 users, 2026 working calendar
npm run db:seed:dev               # cross-rep fixture data (local only)

npm test                          # 308 unit tests
npm run test:rls                  # the 8 RLS isolation tests — needs the database
npm run dev                       # api :3001, web :3000, worker
```

`npm run pg:stop` when you are done; `npm run pg:destroy` wipes the cluster.

### Why there is no Docker here

Docker Desktop is not installed on the client's machine and will not be — it slows
the machine down, which is a fair reason. So local Postgres comes from real
PostgreSQL **16.14** binaries shipped as an npm package and run against a data
directory inside the repo (`.pgdata`, gitignored).

These are not an emulator and not `pg-mem`: RLS, `FORCE ROW LEVEL SECURITY`,
roles, triggers and `pgcrypto` all behave exactly as they do in production. That
matters more here than anywhere else — the one thing in this system that fails
silently is the one thing that must never be tested against a lookalike. The
version is pinned to 16 to match the Coolify target so dev and prod cannot drift.

Coolify still runs Docker in production. This only changes how a developer gets a
database on their own laptop.

Then open <http://localhost:3000>, and <http://localhost:3001/metrics/registry> to see the
certified metric layer.

### Two things that will confuse you if nobody warns you

**1. `db:seed` refuses to run on a database it does not recognise.**

```
REFUSING to run "seed".
  This database has no _local_dev_marker row, so it is not a known local-dev database.
```

That is working as designed (**D-40**). `npm run db:migrate` writes the marker when it builds a
database from empty, and `--fresh` writes it after dropping. Run migrate first.

The reason is worth knowing. The production database is reachable over Tailscale at
`127.0.0.1:55432` — **loopback**, so a host check cannot tell it apart from your local Postgres.
The marker can: production has tables and no marker, so it fails closed regardless of what
`DATABASE_URL` says. Both checks run; neither is sufficient alone.

This guards the realistic accident — a stray `DATABASE_URL` during a seed. It does not stop a
determined operator, and `migrate --fresh` has already dropped the schema by the time the marker
would matter. Do not treat it as more than it is.

**2. An RLS test that does not `SET ROLE app_role` first proves nothing.**

Postgres table owners **bypass RLS**. The migration user owns the tables, so a query run as the
migration user returns every row while looking like a passing test. Always:

```sql
SET ROLE app_role;
SET app.user_id   = '<an employee uuid>';
SET app.user_role = 'EMPLOYEE';
SELECT count(*) FROM lead;                 -- only that rep's leads
SELECT count(*) FROM customer_identifier;  -- only their customers' phones
RESET ROLE;
```

`app_role` owns nothing. `npm run db:migrate` fails if it ever does (**D-21**).

---

## Commands

| Command | What it does |
|---|---|
| `npm run pg:start` / `pg:stop` | Start / stop local PostgreSQL 16 (no Docker) |
| `npm run pg:destroy` | Wipe the cluster and start over |
| `npm run db:migrate` | Apply schema + RLS policies. Marks a database it creates from empty. |
| `npm run db:migrate -- --fresh` | Drop `public` first. Refuses on an unmarked, non-empty database. |
| `npm run db:seed` | Master data. Idempotent — run it twice; counts do not change. |
| `npm run db:seed -- --year 2027 --non-working 0,6 --holidays 2027-10-20` | Calendar for another year or weekend shape |
| `npm run db:seed:dev` | Cross-rep fixture data. Local only, never production. |
| `npm test` | Unit tests, all workspaces |
| `npm run test:rls` | The 8 isolation tests. Needs the database; **fails rather than skips** without one. |
| `npm run dev` | api + web + worker |
| `npm run typecheck` | All six workspaces |

Redis (worker queues) and MinIO (uploads) are still Docker services in
`docker-compose.yml` and are not needed until Phase 2.

### Seeded accounts

13 users — **1 OWNER, 3 ADMIN, 9 EMPLOYEE**. Password for all: `razorveda-dev-only`
(override with `SEED_DEFAULT_PASSWORD`). Local only; a real deployment provisions credentials out
of band.

The **OWNER account is seeded locked** with `locked_reason` naming **O-07**, because nobody has
nominated a person yet. Set the real email and unlock to claim it. This is deliberate, not a bug —
do not "fix" it by adding a forced-reset column (**D-41**).

---

## Layout

```
apps/api        NestJS. Modules mirror the domain: auth, customers, leads, orders,
                assignment, ingestion, reports, masters, audit.
apps/web        Next.js App Router. Route groups: (admin) and (employee).
apps/worker     BullMQ. Queues: ingestion, scoring, reports, notifications.
packages/db     schema, migrations, seed loader, working calendar, guards.
packages/shared Zod schemas, types, enums, crypto parameters. Imported by api AND web.
packages/metrics Certified metric registry + the parity guardrails.
docs/           The specification. docs/00 through docs/09 plus tasks/ are the working spec.
tasks/          Seven phase definitions with exit criteria.
fixtures/       Deliberately messy files reproducing the client's real data defects.
db/seed/        Master data as CSV. Change data here, never in code.
```

---

## The guardrails, and why they exist

Four tests exist to stop two sources of truth drifting apart. They are not ceremony — each one
replaced a defect that had already happened.

| Guardrail | Fails when |
|---|---|
| `packages/metrics` **registry parity** | A metric is in `docs/03` but not the registry, or the reverse. Both directions. |
| `packages/metrics` **section numbering** | `docs/03` has a duplicate or non-sequential section number — which would file a metric under the wrong section and report it as *missing*, sending you to the wrong file. |
| `packages/metrics` **legacy containment** | A `legacy` metric key is referenced outside the reconciliation module. |
| `packages/shared` **enum parity** | A Postgres enum in `db/schema.sql` has no TypeScript mirror, or values drift. |

Each one also **guards the guard** — it asserts that its own parser matched something. A parser
that silently matches nothing makes every assertion in the file pass vacuously, which is how this
kind of test rots without anyone noticing.

**If a guardrail fails, change the document and the code together. Never relax the assertion.**

---

## Rules you cannot break

Full list in `CLAUDE.md`. The ones that bite first:

1. **AI proposes, deterministic code disposes.** No LLM ever produces a money figure, a score, an
   assignment, or a ledger row.
2. **Append-only for money and status.** Corrections are new rows. `UPDATE` on `activity`,
   `order_status_event`, `lead_assignment`, `attribution_ledger`, `audit_log` or `pii_access_log`
   raises.
3. **Realised, not booked.** Credit is earned on delivery. The invariant is **per order**, not per
   period — realised legitimately *can* exceed booked within a month (**D-13**, docs/03 §7).
4. **RLS is the isolation mechanism**, not application `WHERE` clauses.
5. **Exact arithmetic, rounded once at render.** No metric consumes another metric's displayed
   form (**D-39**, docs/03 §9). Expect ±₹1 against the client's sheet and do not chase it.
6. **Money is `numeric(12,2)` and a decimal string in TypeScript.** Never a float.
7. **Every metric has exactly one definition**, in `docs/03`. If it is not there, it does not exist
   and no screen may display it.

---

## Reading order for a new developer

1. `CLAUDE.md` — standing context, including §7b, the corrections that cost two audit passes
2. `docs/00-product-brief.md` — what this is and who uses it
3. `docs/08-audit-findings.md` — every defect in the current system, measured
4. `design/prototype.html` — open in a browser
5. `docs/03-metric-dictionary.md` — the definitions everything else depends on
6. `docs/09-decisions-log.md` — what is decided, what is open, and why

---

## Open decisions

Tracked in `docs/09-decisions-log.md`. Blocking Phase 1 exit: **O-01** roster, **O-02** Shopify base
prices, **O-07** owner account. Also open: O-03, O-06, O-11, O-12, O-13, plus N9 and N10.

Seed data for unconfirmed items is **inferred, not confirmed** — Shopify base prices and SKU usage
days especially. Every per-day figure is marked provisional until the working calendar is signed off.

---

## Troubleshooting

**`seed` refuses to run** — see "Two things" above. Run `npm run db:migrate -- --fresh`.

**`TypeError: Cannot read properties of undefined (reading 'value')` from the API** — you ran `tsx`
from the repo root, so it found no `tsconfig.json` and emitted standard decorators instead of the
legacy ones NestJS needs. Use `npm run dev -w @razorveda/api`, which runs with `apps/api` as cwd.

**Worker exits immediately** — Redis is not up. `npm run infra:up`.

**RLS test returns every row** — you did not `SET ROLE app_role`. See above.
