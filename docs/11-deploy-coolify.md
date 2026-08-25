# Deploying to Coolify

Everything is done in the Coolify web UI. Nothing here needs PowerShell on your
laptop; the one command that has to run against the database runs in Coolify's
own Terminal.

There are two ways to deploy this repository. **This guide covers the Dockerfile
route**, which is the one being used: Postgres and Redis become *managed*
Coolify databases (so Coolify handles their backups), and the app becomes three
applications built from the same Dockerfile.

> The alternative is one **Docker Compose** resource pointed at
> `/docker-compose.prod.yml`, which brings up all six containers together. It is
> fewer steps but gives you no managed backups. Both are supported by the same
> Dockerfile — see §8.

---

## How the one Dockerfile makes four different containers

`APP` is a **build argument**. It decides what the container becomes:

| `APP` | What runs |
|---|---|
| `api` | NestJS API on port 3001 |
| `web` | Next.js on port 3000 |
| `worker` | BullMQ consumer, no port |
| `migrate` | Schema + master data, runs once and exits |

So you create four Coolify resources from the same repository, each with a
different `APP`. No "build stage target" field is required.

---

## Before you start

- A server connected to Coolify (**Servers** → status green)
- Two subdomains already pointing at that server's IP:
  - `crm.razorveda.com` → the web app
  - `api.razorveda.com` → the API
- The repository: `https://github.com/Kunalmishra77/Razorveda-CRM.git`

**DNS must resolve before you deploy.** Coolify cannot issue a TLS certificate
for a name that does not point at it, and without TLS the browser blocks every
call from the web app to the API.

---

## 1 · Postgres

**+ New Resource → Database → PostgreSQL 16**

| Field | Value |
|---|---|
| Name | `razorveda-postgres` |
| Database | `razorveda` |
| Username | `razorveda_migrator` |
| Password | `POSTGRES_PASSWORD` from your secrets |

Deploy it, then open it and copy the **internal** connection URL. It looks like:

```
postgresql://razorveda_migrator:<password>@razorveda-postgres:5432/razorveda
```

Use the internal hostname, not a public one. The database must not be reachable
from the internet — do **not** enable "Public Port".

> The username matters. `razorveda_migrator` **owns** the tables, and Postgres
> table owners bypass Row-Level Security (D-21). The API never connects as this
> role; the migration creates a second, non-owning role for it.

---

## 2 · Redis

**+ New Resource → Database → Redis 7**

| Field | Value |
|---|---|
| Name | `razorveda-redis` |

Deploy, and copy its internal URL — `redis://razorveda-redis:6379`.
Again: no public port.

---

## 3 · The migration

**+ New Resource → Application → Public Repository**

| Field | Value |
|---|---|
| Repository | `https://github.com/Kunalmishra77/Razorveda-CRM.git` |
| Branch | `main` |
| Build Pack | **Dockerfile** |
| Dockerfile Location | `/Dockerfile` |
| Name | `razorveda-migrate` |

**Environment Variables:**

```dotenv
APP=migrate
DATABASE_URL=postgresql://razorveda_migrator:<POSTGRES_PASSWORD>@razorveda-postgres:5432/razorveda
APP_DB_PASSWORD=<APP_DB_PASSWORD from your secrets>
TZ=Asia/Kolkata
```

Mark **`APP`** as a **Build Variable** (there is a toggle on the row). It is a
build argument, so a runtime-only value leaves the image defaulting to `api`.

Deploy it. It creates the schema, the RLS policies, the `razorveda_app` login
role, and loads the master data — 7 product lines, 20 SKUs, 9 sources, 25
dispositions, 80 aliases, 13 users — then **exits**.

Coolify will show it as stopped or unhealthy. **That is correct.** It is a job,
not a server. Turn off any auto-restart on this resource, and re-deploy it by
hand whenever a migration needs to run.

---

## 4 · The API

**+ New Resource → Application → Public Repository**, same repository and branch.

| Field | Value |
|---|---|
| Build Pack | **Dockerfile** |
| Dockerfile Location | `/Dockerfile` |
| Name | `razorveda-api` |
| Port | `3001` |
| Domain | `https://api.razorveda.com` |

**Environment Variables** — paste the whole block, substituting your secrets and
domains:

```dotenv
APP=api

NODE_ENV=production
TZ=Asia/Kolkata
API_PORT=3001

DATABASE_URL=postgresql://razorveda_migrator:<POSTGRES_PASSWORD>@razorveda-postgres:5432/razorveda
DATABASE_URL_APP=postgresql://razorveda_app:<APP_DB_PASSWORD>@razorveda-postgres:5432/razorveda
DATABASE_APP_ROLE=app_role
REDIS_URL=redis://razorveda-redis:6379

JWT_SECRET=<JWT_SECRET from your secrets>
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
SESSION_IDLE_TIMEOUT_MIN=10
OWNER_CLAIM_TOKEN=<OWNER_CLAIM_TOKEN from your secrets>

WEB_ORIGIN=https://crm.razorveda.com

S3_ENDPOINT=http://razorveda-minio:9000
S3_BUCKET=razorveda-uploads
S3_ACCESS_KEY=<S3_ACCESS_KEY>
S3_SECRET_KEY=<S3_SECRET_KEY>
S3_REGION=ap-south-1

AI_PROVIDER=gemini
AI_MODEL=gemini-2.0-flash
AI_MAPPING_MIN_CONFIDENCE=0.90
AI_API_KEY=

PII_COPY_VELOCITY_COUNT=4
PII_COPY_VELOCITY_WINDOW_SEC=90
UNTOUCHED_ALERT_HOURS=48
UNTOUCHED_RECALL_HOURS=72
EMPLOYEE_MAX_ROWS_PER_PAGE=50

SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
WHATSAPP_PROVIDER=
WHATSAPP_API_KEY=
```

Mark **`APP`** as a **Build Variable**.

`WEB_ORIGIN` must be the web domain **exactly** — `https`, no trailing slash. The
API only accepts and returns CORS headers for that one origin, so a mismatch
makes every sign-in fail with a CORS error in the browser console and nothing at
all in the server log.

### Two DATABASE URLs, on purpose

`DATABASE_URL` is the migration user. `DATABASE_URL_APP` is the API's, and it
connects as `razorveda_app` — a role that owns nothing, so Row-Level Security
actually applies to it. The API refuses to start if `DATABASE_URL_APP` is
missing, and says so in a full sentence.

---

## 5 · The worker

Same repo, **Dockerfile**, name `razorveda-worker`. **No domain, no port.**

```dotenv
APP=worker
NODE_ENV=production
TZ=Asia/Kolkata
DATABASE_URL_APP=postgresql://razorveda_app:<APP_DB_PASSWORD>@razorveda-postgres:5432/razorveda
DATABASE_APP_ROLE=app_role
REDIS_URL=redis://razorveda-redis:6379
S3_ENDPOINT=http://razorveda-minio:9000
S3_BUCKET=razorveda-uploads
S3_ACCESS_KEY=<S3_ACCESS_KEY>
S3_SECRET_KEY=<S3_SECRET_KEY>
```

Mark **`APP`** as a **Build Variable**.

---

## 6 · The web app

Same repo, **Dockerfile**, name `razorveda-web`.

| Field | Value |
|---|---|
| Port | `3000` |
| Domain | `https://crm.razorveda.com` |

```dotenv
APP=web
NEXT_PUBLIC_API_URL=https://api.razorveda.com
NODE_ENV=production
TZ=Asia/Kolkata
PORT=3000
```

### Mark BOTH `APP` and `NEXT_PUBLIC_API_URL` as Build Variables

This is the step that catches everybody.

Next.js inlines every `NEXT_PUBLIC_*` value into the **browser** bundle when it
builds. If `NEXT_PUBLIC_API_URL` is only a runtime variable, the build bakes in
the default and every rep's browser tries to call `http://localhost:3001` — from
her own laptop. The screens load, every number is blank, and **nothing appears in
any server log**, because the request never reaches your server.

If you get this wrong, fixing the variable is not enough — you must **rebuild**.
A restart re-runs the same bundle.

---

## 7 · File storage (MinIO)

Uploads need somewhere to live. Either:

- **+ New Resource → Service → MinIO**, name it `razorveda-minio`, set its root
  user and password to your `S3_ACCESS_KEY` / `S3_SECRET_KEY`, no public port; or
- point `S3_ENDPOINT` at any S3-compatible bucket you already have, and set the
  keys and region to match.

Create the bucket named in `S3_BUCKET` (`razorveda-uploads`) before the first
file upload.

---

## 8 · Deploy order

1. `razorveda-postgres`
2. `razorveda-redis`
3. `razorveda-minio`
4. `razorveda-migrate` — wait for it to finish and exit
5. `razorveda-api` — log should end with `api  http://localhost:3001/health`
6. `razorveda-worker`
7. `razorveda-web`

First build takes roughly 5–10 minutes; later ones are faster because the
dependency layer is cached.

**Redeploying after a code change:** push to `main`, redeploy `razorveda-api`,
`razorveda-worker` and `razorveda-web`. Redeploy `razorveda-migrate` too when the
schema changed — it is idempotent, so running it when nothing changed is
harmless.

---

## 9 · First sign-in

Open `https://crm.razorveda.com`.

- The seeded accounts use the development password. **Change it before the team
  uses this.**
- The OWNER account is seeded **locked** on purpose — nobody has been nominated
  yet (O-07). It is claimed with `OWNER_CLAIM_TOKEN`.
- Admins need a 6-digit authenticator code, because `TOTP_DISABLED` is not set in
  production. Enrol from the prompt at login.

### Four variables that must stay unset

`TOTP_DISABLED`, `SHIFT_HOURS_DISABLED`, `RATE_LIMIT_DISABLED` and
`SCHEDULER_DISABLED` exist for local development. The API prints a warning line
at boot for each one that is on. **If you see those warnings in production logs,
something is set that should not be** — two-factor is off, or reps can sign in at
3am, or brute-force protection is disabled, or the metrics never refresh.

---

## 10 · Backups

Because Postgres is a *managed* Coolify database here, open it and turn on
**Scheduled Backups** — daily at minimum, with an S3 destination if you have one.

`npm run db:restore-drill` is what proves a backup is restorable. A backup nobody
has restored is a hope, not a backup.

---

## If something is wrong

| Symptom | Cause |
|---|---|
| Screens load, every number blank, or "Cannot reach the API" | `NEXT_PUBLIC_API_URL` was not a **Build Variable**. Fix the toggle and **rebuild** — restarting is not enough. |
| Sign-in fails, CORS error in the browser console | `WEB_ORIGIN` does not exactly match the web domain. Check trailing slash and `http` vs `https`. |
| A container runs migrations then stops | That is `razorveda-migrate`, and it is correct. It is a job. |
| Every app behaves like the API | `APP` was set as a runtime variable instead of a **Build Variable**, so the image kept its default. |
| `api` exits at boot | Read the log; it names the missing variable in a sentence. |
| `migrate` fails on `CREATE ROLE` | `APP_DB_PASSWORD` contains a character that broke the SQL literal. Use the generated value, or stick to letters, digits, `-` and `_`. |
| Reports show stale numbers | The scheduler is off. Check the API boot log for a `SCHEDULER_DISABLED` warning. |

---

## What has not been tested

The Dockerfile and the compose file were written against this repository but
**have not been built on this machine** — there is no Docker installed on the
development laptop, which uses an embedded Postgres instead. Coolify's first
build is therefore their first real test. If it fails, the build log will name
the step, and it will be a path or a dependency rather than a design problem.
