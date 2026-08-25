# Deploying to Coolify

Everything here is done in the Coolify web UI. There is exactly one step that
needs a terminal, it is Coolify's own built-in Terminal, and it is optional.

**What runs:** six containers on one server — Postgres, Redis, MinIO, the API,
the worker, and the Next.js web app — plus a migrate job that runs to completion
before the API starts. One of everything (CLAUDE.md rule 9).

---

## Before you start

You need:

- A server already connected to Coolify (**Servers** in the sidebar, status green)
- Two subdomains pointing at that server's IP, e.g.
  - `crm.razorveda.com` → the web app
  - `api.razorveda.com` → the API
- The repository URL: `https://github.com/Kunalmishra77/Razorveda-CRM.git`

Both DNS records must resolve **before** you deploy, or Coolify cannot issue TLS
certificates and the browser will refuse the API calls.

---

## 1 · Create the application

1. **Projects** → your project → **production** → **+ New Resource**
2. Choose **Docker Compose** (not "Nixpacks", not "Dockerfile" — this repo ships
   its own compose file describing all six services)
3. Choose **Public Repository** and paste:

   ```
   https://github.com/Kunalmishra77/Razorveda-CRM.git
   ```

4. **Check repository** → branch `master`
5. Set **Docker Compose Location** to:

   ```
   /docker-compose.prod.yml
   ```

   This matters. `docker-compose.yml` at the root is **local development
   infrastructure only** — it publishes Postgres on a host port, which must never
   happen on a server (D-17).

6. **Continue** / **Save**

---

## 2 · Environment variables

**Settings → Environment Variables** on the application.

Paste the block below into the bulk editor, then replace the two domains at the
bottom with yours. The secrets are already generated — they are random, unique to
this deployment, and there is no reason to change them.

```dotenv
POSTGRES_PASSWORD=<generated — see the values handed over separately>
APP_DB_PASSWORD=<generated>
JWT_SECRET=<generated, 64 characters>
OWNER_CLAIM_TOKEN=<generated>
S3_ACCESS_KEY=<generated>
S3_SECRET_KEY=<generated>

S3_BUCKET=razorveda-uploads
S3_REGION=ap-south-1

JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
SESSION_IDLE_TIMEOUT_MIN=10

PII_COPY_VELOCITY_COUNT=4
PII_COPY_VELOCITY_WINDOW_SEC=90
UNTOUCHED_ALERT_HOURS=48
UNTOUCHED_RECALL_HOURS=72
EMPLOYEE_MAX_ROWS_PER_PAGE=50

AI_PROVIDER=gemini
AI_MODEL=gemini-2.0-flash
AI_MAPPING_MIN_CONFIDENCE=0.90
AI_API_KEY=

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
WHATSAPP_PROVIDER=
WHATSAPP_API_KEY=

WEB_ORIGIN=https://crm.razorveda.com
NEXT_PUBLIC_API_URL=https://api.razorveda.com
```

### The one that catches everybody

`NEXT_PUBLIC_API_URL` must be marked **Build Variable** in Coolify (there is a
toggle on the variable row).

Next.js inlines every `NEXT_PUBLIC_*` value into the browser bundle **when it
builds**. If it is only a runtime variable, the build bakes in the default and
every rep's browser tries to call `http://localhost:3001` — from her own laptop.
Nothing appears in any server log, because the request never reaches the server.
The screens load and every number is missing.

`WEB_ORIGIN` is the mirror of it: the API only accepts and returns CORS headers
for that exact origin. **No trailing slash**, and `https` not `http`.

### What is deliberately not in the list

- `TOTP_DISABLED` — leave unset. Two-factor for admins stays ON in production.
- `SHIFT_HOURS_DISABLED` — leave unset. Reps sign in during their shift.
- `RATE_LIMIT_DISABLED` — leave unset. It is the brute-force protection.
- `SCHEDULER_DISABLED` — leave unset. The metrics refresh and the 72-hour recall
  need to run.

All four exist for local development and the API prints a warning line on boot
for each one that is on. If you see those warnings in the production logs,
something is set that should not be.

---

## 3 · Domains

**Settings → Domains**, per service:

| Service | Domain |
|---|---|
| `web` | `https://crm.razorveda.com` |
| `api` | `https://api.razorveda.com` |

Leave `postgres`, `redis`, `minio`, `migrate` and `worker` with **no domain**.
They are reachable only inside the compose network, which is the point — nothing
should be able to reach the database from the internet.

---

## 4 · Deploy

Press **Deploy**.

The first build takes roughly 5–10 minutes: it installs the workspace once and
then builds the Next.js app. Later deploys are faster because the dependency
layer is cached.

Watch the **Logs** tab. In order you should see:

1. `migrate` runs and exits — creates the schema, the RLS policies, the
   `razorveda_app` login role, then loads the master data (7 product lines,
   20 SKUs, 9 sources, 25 dispositions, 80 aliases, 13 users)
2. `api` starts and prints `api  http://localhost:3001/health`
3. `web` starts
4. `worker` starts

If `api` starts but immediately exits, read its log — it refuses to boot without
`DATABASE_URL_APP` and says so in a full sentence.

---

## 5 · First sign-in

Open `https://crm.razorveda.com`.

The seeded accounts all use the development password, which **must be changed
before the team uses this**. The OWNER account is seeded **locked** on purpose —
nobody has been nominated yet (O-07), and it is claimed with the
`OWNER_CLAIM_TOKEN` you set above.

Admins need a 6-digit authenticator code on first sign-in, because
`TOTP_DISABLED` is not set. Enrol from the prompt shown at login.

---

## 6 · Backups

**Databases** are not managed by Coolify here — Postgres is a service inside your
compose stack, so set up the backup yourself:

- Coolify → your server → **Scheduled Tasks**
- Command: `pg_dump -U razorveda_migrator razorveda | gzip > /backups/razorveda-$(date +\%F).sql.gz`
- Container: the `postgres` service
- Frequency: daily is the minimum for a business whose orders live here

`npm run db:restore-drill` exists and is what proves a backup is restorable. A
backup nobody has restored is a hope, not a backup.

---

## Redeploying after a code change

Push to `master` and press **Deploy** again, or turn on **Automatic Deployment**
in Coolify so a push deploys itself.

`migrate` re-runs every deploy. Both halves are idempotent — it creates what is
missing and upserts the master data — so a schema change lands automatically and
a deploy with no schema change costs a few seconds.

---

## If something is wrong

| Symptom | Cause |
|---|---|
| Screens load, every number is blank or "Cannot reach the API" | `NEXT_PUBLIC_API_URL` was not marked a **Build Variable**. Fix the toggle and **rebuild** — a restart is not enough, the value is baked into the bundle. |
| Sign-in fails with a CORS error in the browser console | `WEB_ORIGIN` does not exactly match the web domain. Check for a trailing slash or `http` vs `https`. |
| `api` exits on boot | Read the log. It names the missing variable. |
| `migrate` fails on `CREATE ROLE` | `APP_DB_PASSWORD` contains a character that broke the SQL literal. Use the generated value, or stick to letters, digits, `-` and `_`. |
| Everything works but reports are stale | The scheduler is off. Check the API boot log for a `SCHEDULER_DISABLED` warning. |

---

## A note on what has not been tested

The Dockerfile and this compose file were written against the repository but
**have not been built on this machine** — there is no Docker installed here
(the local stack uses an embedded Postgres instead). Coolify's first build is
therefore the first real test of them. If the build fails, the log will say which
step, and it will be a dependency or a path, not a design problem.
