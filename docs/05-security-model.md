# 05 — Security Model

## The honest starting position

Reps dial from their own handsets, so **they must see full phone numbers**. That removes the
strongest control available (never showing the number). What remains is **detection and
attribution**, not prevention. Build accordingly and describe it accurately in the UI — do not
claim protection the system does not provide.

Even so, this is a large improvement on today, where every rep holds a downloadable spreadsheet of
four months of customer PII on their own laptop.

## Controls to build

| Layer | Control |
|---|---|
| Network | Cloudflare WAF + rate limiting · TLS 1.3 only · HSTS · optional office-IP allowlist for admin routes |
| Identity | Argon2id · mandatory TOTP 2FA for ADMIN and OWNER · JWT 15 min + rotating refresh · single active session per employee · device fingerprint binding · shift-hours login window · 10 min idle logout |
| Authorisation | RBAC in the API **plus** Postgres RLS on every customer-facing table |
| Data at rest | Full-disk encryption · `pgcrypto` on phone and address columns · encrypted backups, keys held separately |
| Anti-exfiltration | No export endpoint for EMPLOYEE · no API tokens for EMPLOYEE · max 50 rows/page · no bulk list view · no cross-customer search · `user-select: none` on data tables · print CSS blocked |
| **Copy logging** | Every copy-number action writes `pii_access_log(employee_id, lead_id, action, ip, ts)` |
| **Velocity lock** | ≥4 copy events in 90 seconds → account auto-locked, admin alerted |
| Watermark | Per-session diagonal overlay on every data surface: name, employee code, timestamp, IP |
| Audit | Append-only `audit_log` with before/after JSON on every mutation, login, permission change and ledger adjustment |
| Backup / DR | Nightly `pg_dump` + continuous WAL archiving to a separate region. **Restore drill monthly.** RPO 15 min, RTO 4 hours |
| Application | Zod on every input · parameterised queries only · CSP · HttpOnly SameSite cookies · CSRF tokens · upload type/size/content validation · dependency scanning in CI |

## RLS pattern

Every request runs inside a transaction that sets the context first:

```sql
SET LOCAL app.user_id   = '<uuid>';
SET LOCAL app.user_role = 'EMPLOYEE';
```

Policy shape:

```sql
CREATE POLICY lead_isolation ON lead FOR ALL TO app_role
USING (
  current_setting('app.user_role', true) IN ('ADMIN','OWNER')
  OR assigned_to = current_employee_id()   -- NOT current_setting('app.user_id'); see note below
);
```

**`app.user_id` is an `app_user.user_id`. `lead.assigned_to` is an `employee.employee_id`.**
They are different UUIDs, joined by `employee.user_id`. Always go through the helpers:
`current_user_id()` reads the GUC, `current_employee_id()` resolves it to an employee,
`is_admin()` checks the role. Comparing the raw GUC to an `employee_id` fails closed and hides a
rep's own rows — it looks like working isolation and is not. (defect N1)

One exception: a policy **on the `employee` table itself** must use `current_user_id()`, never
`current_employee_id()`, because that function selects from `employee` and would recurse under
`FORCE ROW LEVEL SECURITY`.

For the authoritative list of protected tables, see the coverage table at the end of this document —
not the sentence that used to be here. Apply equivalent policies to `customer`, `order`, `order_line`, `activity`, `attribution_ledger`,
`lead_assignment`, `employee_score_daily`.

## Tests that must exist before any UI ships

1. Employee A calls `GET /leads/:id` with a lead id belonging to Employee B → 404, not 403.
   (404 avoids confirming the record exists.)
2. Employee A calls any list endpoint → only their own rows, verified by count against a seeded set.
3. Employee A attempts `GET /customers/search?phone=…` for an unassigned customer → empty.
4. Employee role has no route that returns more than 50 rows.
5. No export/download route resolves for the EMPLOYEE role.
6. `UPDATE` on any append-only table raises.
7. Copy-velocity: 4 events in 90 s locks the account and writes an alert.
8. A locked account cannot authenticate until an admin unlocks it.

## Offboarding

One action: revoke access, bulk-return open leads to the pool with a handover note, and preserve
the full access log of the last 30 days. Nothing was ever on the rep's device.

## Optional future controls (Phase 6, not now)

1. **Cloud dialler with number masking** (Exotel/Servetel/Knowlarity) — the only control that
   actually removes the risk. Also restores real dial counts, connectivity and call recording,
   which are self-reported under the current design.
2. **Partial masking with logged reveal** — `98••••6231` plus rate-limited one-tap reveal.
3. **Windows desktop shell** with OS-level screen-capture blocking. Only useful on company machines.

## Governance note

Three admins with identical, mutually unrevocable access and nobody above them is a gap. Implement
one `OWNER` account whose only extra powers are: managing admin accounts, setting targets, and
changing incentive rules. Day to day it behaves like an admin.


---

## RLS table coverage (corrected — defect B1)

Every table below carries an RLS policy **and** `FORCE ROW LEVEL SECURITY`. The three marked ADDED
were missing from the v1 draft of both this document and `db/rls-policies.sql`.

| Table | Employee can see |
|---|---|
| `lead` | only rows where `assigned_to = self` |
| `customer` | only customers with a lead assigned to self |
| **`customer_identifier`** | **ADDED** — only phones of customers assigned to self. *This is the phone-number table; leaving it open defeats every other control in this document.* |
| `order` | only orders booked by self |
| `order_line` | only lines of visible orders |
| **`order_status_event`** | **ADDED** — only events on visible orders |
| **`order_credit_split`** | **ADDED** — only own credit rows. Otherwise a rep can see who else is credited on an order. |
| `activity` | only own activity |
| `attribution_ledger` | SELECT own rows only; INSERT via service path only |
| `employee_score_daily` | own scores only |
| `lead_assignment` | own assignments only |

### The ownership trap (defect B3)
Postgres table owners **bypass RLS** unless `FORCE ROW LEVEL SECURITY` is set — and even with FORCE,
a test run as the owner proves nothing about what `app_role` can see.

1. The migration user owns the tables. The application must **never** connect as that user.
2. The app connects as `app_role`, which owns nothing.
3. Every isolation test must `SET ROLE app_role;` before asserting.
4. CI must fail if `DATABASE_URL` for the API resolves to a role that owns any table in `public`.
