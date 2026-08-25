# ONE IMAGE, ONE BUILD ARGUMENT, FOUR ROLES.
#
# `APP` selects what the container becomes: api, web, worker or migrate. There is
# a single final stage, so this builds correctly whether the caller names a
# target or not — which matters, because the two ways Coolify can build this
# repository disagree about that:
#
#   Docker Compose build pack — each service passes `args: APP: <role>`
#   Dockerfile build pack     — one application per role, `APP` set as a
#                               BUILD-time variable in the UI
#
# The earlier version used a stage per role and `--target`. That works for
# compose and depends, for the plain Dockerfile pack, on a "build stage target"
# field whose presence varies by Coolify version. A build argument is supported
# by every version of both, so this is the arrangement that cannot be got wrong.
#
# WHY ONE FILE AT ALL. This is an npm WORKSPACE: apps/api imports
# @razorveda/shared and @razorveda/metrics as workspace packages, so an image
# building one app has to reconstruct the whole dependency graph anyway.
#
# WHY tsx RATHER THAN A COMPILED dist/. The repo is ESM with
# `moduleResolution: "Bundler"`, which tsc cannot emit runnable output for
# without rewriting every import specifier — and everything here has always been
# run by tsx, including the migrations and the seeds. Compiling only the API
# would leave two execution paths that can diverge. At 2,000 rows a day the
# startup cost is irrelevant and the simplicity is worth more (CLAUDE.md rule 9).
# The web app is the exception: Next.js has a real production build, so it gets
# one — see the conditional RUN below.

# ─── base ───────────────────────────────────────────────────────────────────
FROM node:20-alpine AS base
# Asia/Kolkata everywhere. Postgres CURRENT_DATE, the cron schedules and
# businessToday() must all agree, and the container clock is where that starts.
RUN apk add --no-cache tzdata curl && \
    cp /usr/share/zoneinfo/Asia/Kolkata /etc/localtime && \
    echo "Asia/Kolkata" > /etc/timezone
ENV TZ=Asia/Kolkata
WORKDIR /app

# ─── deps ───────────────────────────────────────────────────────────────────
# Manifests only, so this layer stays cached until a dependency actually
# changes. Editing a controller must not trigger a fresh npm ci.
#
# devDependencies are installed ON PURPOSE, and `--include=dev` is not
# redundant. tsx runs the API and the worker; next builds the web app. If either
# is missing the container starts and immediately dies with "not found".
#
# npm omits devDependencies whenever NODE_ENV=production is set in the build
# environment, and a platform can set that without the Dockerfile asking for it —
# Coolify passes build-time variables straight through and warns about exactly
# this. `--include=dev` overrides NODE_ENV, so the image is correct no matter
# what the builder injects. NODE_ENV is set to production LATER, after the
# install, where it belongs.
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json         apps/api/
COPY apps/web/package.json         apps/web/
COPY apps/worker/package.json      apps/worker/
COPY packages/db/package.json      packages/db/
COPY packages/shared/package.json  packages/shared/
COPY packages/metrics/package.json packages/metrics/
RUN npm ci --include=dev --no-audit --no-fund

# ─── app ────────────────────────────────────────────────────────────────────
FROM deps AS app

# api | web | worker | migrate
ARG APP=api
ENV APP=${APP}

# NEXT_PUBLIC_API_URL IS A BUILD ARGUMENT, NOT A RUNTIME ONE, and this is the
# single most common way a Next deploy comes up broken. Next inlines every
# NEXT_PUBLIC_* value into the BROWSER bundle when it builds; supplying it only
# at runtime bakes in the default and leaves every rep's browser calling
# http://localhost:3001 from her own laptop. Nothing appears in any server log,
# because the request never reaches the server.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .

# Only the web app has a compile step. Guarded so an api or worker build does not
# spend two minutes producing a bundle it will never serve.
RUN if [ "$APP" = "web" ]; then npm run build -w @razorveda/web; fi

ENV NODE_ENV=production
EXPOSE 3000 3001

# One entrypoint, four behaviours. `migrate` runs to completion and exits — that
# is correct, and a platform that restarts it will simply re-run two idempotent
# steps.
CMD ["sh", "-c", "case \"$APP\" in \
  api)     exec npm run start -w @razorveda/api ;; \
  web)     exec npm run start -w @razorveda/web ;; \
  worker)  exec npm run start -w @razorveda/worker ;; \
  migrate) npm run db:migrate && npm run db:seed ;; \
  *)       echo \"APP must be one of: api, web, worker, migrate (got '$APP')\" >&2; exit 1 ;; \
esac"]
