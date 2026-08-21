# 01 — Architecture

## Layers

```
L6  PRESENTATION   Admin console · Employee portal · Scheduled digests
L5  INTELLIGENCE   Performance scoring · Repeat-due engine · RTO risk · Forecast
L4  SEMANTIC       Metric dictionary → certified views (docs/03)
L3  CORE DOMAIN    Customer 360 · Order ledger · Lead lifecycle · Activity · Attribution ledger
L2  INGESTION      Upload → fingerprint → map → normalise → resolve → validate → review → commit
L1  SOURCES        9 upload channels + manual entry
    CROSS-CUTTING  AuthN/AuthZ · RLS · audit trail · observability · backup
```

## Runtime

```
Cloudflare (WAF, rate limit)
        │
     Traefik ── TLS
        │
   ┌────┴─────┬──────────────┬───────────────┐
 Next.js   NestJS API     BullMQ workers   (all Docker)
   web       (REST)        ingestion
                           scoring
                           reports
        │            │            │
   ┌────┴────┬───────┴────┬───────┴────┐
 Postgres  Redis        MinIO      AI adapter
 16 + RLS  cache/queue  uploads    (Gemini Flash)
 matviews

Host: Mumbai VPS (8 vCPU / 16 GB / 200 GB NVMe), Coolify + Docker Compose
DR:   nightly pg_dump + continuous WAL archiving to separate-region object storage
```

## Monorepo

```
apps/api        NestJS. Modules mirror the domain: auth, customers, leads, orders,
                assignment, ingestion, reports, masters, audit.
apps/web        Next.js App Router. Route groups: (admin) and (employee).
apps/worker     BullMQ processors. Queues: ingestion, scoring, reports, notifications.
packages/db     schema.sql, rls-policies.sql, Drizzle config, seed loader.
packages/shared Zod schemas, types, enums, constants. Imported by api AND web.
packages/metrics Certified view SQL + the metric registry mirroring docs/03.
```

## Key architectural decisions

**ADR-001 — PostgreSQL Row-Level Security is the isolation mechanism.**
Employee data isolation is enforced in the database. The API sets `app.user_id` and `app.user_role`
per request via a transaction-scoped `SET LOCAL`. A forgotten `WHERE` clause returns zero rows
rather than another rep's data. This is the single most important choice in the stack.

**ADR-002 — Append-only for money and status.**
`order_status_event`, `activity`, `lead_assignment`, `attribution_ledger`, `audit_log` are
INSERT-only, enforced by a rule/trigger that raises on UPDATE and DELETE. Makes any historical
report reproducible.

**ADR-003 — Materialised views, not a warehouse.**
~2,000 rows/day ≈ 730K rows/year. Postgres handles this for a decade. Refresh `CONCURRENTLY` every
15 minutes plus a 00:05 previous-day close. Revisit only past 50M rows.

**ADR-004 — AI is off the critical path.**
Every AI call has a deterministic fallback. If the provider is down, ingestion still completes —
unseen headers just go to manual mapping. The AI adapter is provider-agnostic behind one interface.

**ADR-005 — Raw uploads are immutable and retained.**
Every uploaded file is stored byte-for-byte. Any batch can be replayed after a rule fix without
asking anyone to re-download anything.

**ADR-006 — No auto-assignment.**
Client decision. Leads land in a pool; admins distribute in bulk. The only automatic lead movement
is the 72-hour untouched recall.

## Explicitly rejected

Microservices · Kafka · Kubernetes · separate data warehouse · ClickHouse · GraphQL · a graph
database · an ORM abstraction over another ORM · Turborepo/Nx. All wrong at this scale; each adds
months of build and a permanent operations burden for no measurable benefit.

## Indexes that matter

| Index | Why |
|---|---|
| `customer(primary_phone)` unique btree | O(1) new-vs-existing check on every ingested row |
| `customer_identifier(type, value)` | Alt-number matching |
| `lead(assigned_to, next_followup_at) WHERE NOT is_converted` | Employee worklist — hottest query |
| `lead(source_id, received_at DESC) WHERE assigned_to IS NULL` | The unassigned pool |
| `order(delivered_date, source_id) WHERE current_status='DELIVERED'` | Realised revenue |
| `order_line(sku_id)` + `order(order_date)` | Product P&L |
| `activity(employee_id, occurred_at DESC)` BRIN | Time-series activity, tiny index |
| `sku USING gin (product_name gin_trgm_ops)` | Fuzzy product-name resolution. **pgvector removed (D-14)** — 20 SKUs need trigram similarity, not embeddings. |
