# Phase 0 — Foundation (Weeks 1–2)

## Goal
Nothing is built until the ground is true. Masters, metrics and environment.

## Deliverables
1. **Monorepo scaffold** per CLAUDE.md §3. npm workspaces. No Turborepo/Nx.
2. **docker-compose.yml** — postgres:16, redis:7, minio, all with health checks.
3. **Database** — apply `db/schema.sql` then `db/rls-policies.sql`. Drizzle Kit configured so
   future changes are migrations; the checked-in SQL is authoritative for v1.
4. **Seed loader** — loads every CSV in `db/seed/` idempotently. Re-running must not duplicate.
   Must resolve `line_code` → `line_id` and `disposition_code` → `disposition_id`.
   Must create `app_user` rows with hashed passwords for every row in `employees.csv`.
5. **Working calendar** — generate 2026 with Sundays non-working by default. Flag O-08 as open.
6. **`packages/shared`** — Zod schema + TS type for every entity in `docs/02-data-model.md`.
   Enums exported as const objects, single source of truth for both api and web.
7. **`packages/metrics`** — a registry mirroring `docs/03-metric-dictionary.md` one-to-one, with the
   SQL for each certified view. **Include a test that FAILS if a metric exists in the doc but not
   in the registry, or vice versa.** This is what keeps the dictionary honest for two years.
8. **`npm run dev`** brings up api + web + worker + infra.
9. **README** a new developer can follow in under 15 minutes.

## Exit criteria — each must be provable by a command

| # | Criterion | Proof |
|---|---|---|
| 1 | Clean machine to running stack | `docker compose up -d && npm run db:migrate && npm run db:seed && npm run dev` |
| 2 | Seed is idempotent | Run `npm run db:seed` twice; row counts identical |
| 3 | Append-only enforced | `UPDATE activity SET remark_raw='x'` raises the CLAUDE.md rule-2 exception |
| 4 | RLS active | `SET ROLE app_role; SET app.user_id='<emp uuid>'; SET app.user_role='EMPLOYEE'; SELECT count(*) FROM lead;` returns only that rep's leads — and the same check on `customer_identifier` returns only their customers' phones. **Without `SET ROLE` this proves nothing** (D-21). |
| 5 | Metric registry matches the doc | `npm test -w packages/metrics` passes |
| 6 | Types shared | `apps/web` imports a Zod schema from `packages/shared` and typechecks |
| 7a | No raw GUC comparisons | `grep -c "app.user_id" db/rls-policies.sql` finds it only inside `current_user_id()` and comments. Every policy goes through `current_employee_id()` / `is_admin()` (N1). |
| 7 | Masters loaded | 7 product lines, 20 SKUs, 13 users, 9 sources, 19 dispositions, 64 aliases |

## Do not do in this phase
Any UI beyond a login page stub. Any ingestion logic. Any report.
