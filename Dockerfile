# One Dockerfile, three targets: api, worker, web.
#
# WHY ONE FILE. This is an npm WORKSPACE. `apps/api` imports `@razorveda/shared`
# and `@razorveda/metrics` as workspace packages, so any image that builds only
# one app has to reconstruct the whole dependency graph anyway. One file with a
# shared `deps` stage installs once and each target copies what it needs.
#
# WHY tsx RATHER THAN A COMPILED dist/. The repo is ESM with
# `moduleResolution: "Bundler"`, which tsc cannot emit runnable output for
# without rewriting every import specifier — and everything in this project has
# always been run by tsx, including the migrations and the seeds. Compiling only
# the API would leave two execution paths that can diverge. At 2,000 rows a day
# the startup cost is irrelevant and the simplicity is worth more (CLAUDE.md
# rule 9). The WEB app is different: Next.js has a real production build and
# `next start` is meaningfully faster and lighter, so it gets one.

# ─── base ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
# Asia/Kolkata everywhere. Postgres CURRENT_DATE, the cron schedules and
# businessToday() must all agree, and the API container is where that starts.
RUN apk add --no-cache tzdata curl && \
    cp /usr/share/zoneinfo/Asia/Kolkata /etc/localtime && \
    echo "Asia/Kolkata" > /etc/timezone
ENV TZ=Asia/Kolkata
WORKDIR /app

# ─── deps ───────────────────────────────────────────────────────────────────
# Only the manifests, so this layer is cached until a dependency actually
# changes. Editing a controller must not trigger a fresh npm ci.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json      apps/api/
COPY apps/web/package.json      apps/web/
COPY apps/worker/package.json   apps/worker/
COPY packages/db/package.json   packages/db/
COPY packages/shared/package.json  packages/shared/
COPY packages/metrics/package.json packages/metrics/
RUN npm ci --no-audit --no-fund

# ─── source ─────────────────────────────────────────────────────────────────
FROM deps AS source
COPY . .

# ─── api ────────────────────────────────────────────────────────────────────
FROM source AS api
ENV NODE_ENV=production
EXPOSE 3001
# The health endpoint is unauthenticated on purpose so an orchestrator can use it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:3001/health || exit 1
CMD ["npm", "run", "start", "-w", "@razorveda/api"]

# ─── worker ─────────────────────────────────────────────────────────────────
FROM source AS worker
ENV NODE_ENV=production
# No port and no healthcheck: it is a BullMQ consumer, not a server. Its liveness
# shows up as queue depth, which the admin Today screen already surfaces.
CMD ["npm", "run", "start", "-w", "@razorveda/worker"]

# ─── web ────────────────────────────────────────────────────────────────────
# NEXT_PUBLIC_API_URL IS A BUILD ARGUMENT, NOT A RUNTIME VARIABLE, and getting
# this wrong is the single most common way a Next deploy comes up broken. Next
# inlines every NEXT_PUBLIC_* value into the client bundle at build time, so
# setting it only in Coolify's runtime environment leaves the browser calling
# http://localhost:3001 from your customer's laptop. Coolify passes build-time
# variables to the builder when they are marked as such — see the deploy guide.
FROM source AS web-build
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @razorveda/web

FROM web-build AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:3000/login || exit 1
CMD ["npm", "run", "start", "-w", "@razorveda/web"]

# ─── migrate ────────────────────────────────────────────────────────────────
# Run once per deploy, before the API starts. Creates the schema, the RLS
# policies and the razorveda_app login role, then loads the master data. Both
# steps are idempotent, so re-running on every deploy is safe and is what the
# compose file does.
FROM source AS migrate
ENV NODE_ENV=production
CMD ["sh", "-c", "npm run db:migrate && npm run db:seed"]
