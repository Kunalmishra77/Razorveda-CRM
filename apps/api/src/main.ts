import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module.js';
import { requireKnownOrigin, securityHeaders } from './security/headers.js';
import { rateLimit } from './security/rate-limit.js';
import { MAX_UPLOAD_BYTES } from './security/upload-guard.js';

const PORT = Number(process.env['API_PORT'] ?? 3001);

async function bootstrap(): Promise<void> {
  /**
   * THE ADAPTER IS PASSED EXPLICITLY, and it has to be.
   *
   * `NestFactory.create(AppModule)` DISCOVERS the HTTP driver: @nestjs/core does a
   * bare `require('@nestjs/platform-express')`, which resolves from core's own
   * location. In an npm workspace that is the root `node_modules`, and npm hoists
   * core there while leaving platform-express under `apps/api/node_modules` — so
   * core cannot see it, and the process dies with "No driver (HTTP) has been
   * selected. ...please ensure to install @nestjs/platform-express", about a
   * package that is installed and importable.
   *
   * It appeared out of nowhere when @nestjs/schedule was added, because that
   * install reshuffled the hoist layout. A clean `npm ci` reproduced it exactly,
   * so it was not a stale-tree artifact and CI would have hit it too.
   *
   * Importing the adapter here makes resolution happen from apps/api, where it is
   * plainly visible, and removes the dependency on npm's hoisting decisions
   * entirely. Explicit beats discovered for something the process cannot start
   * without.
   */
  const app = await NestFactory.create(AppModule, new ExpressAdapter());
  const production = process.env['NODE_ENV'] === 'production';
  const webOrigin = process.env['WEB_ORIGIN'] ?? 'http://localhost:3000';

  // BODY LIMITS, PER ROUTE, AND THIS ONE WAS A REAL BUG.
  //
  // Express defaults to 100 kB. Ingestion sends the whole file as base64, which
  // adds a third — so uploads were capped at about 75 kB of CSV and returned a
  // bare 413. A single normal day is 2,000 rows at ~175 bytes, or ~350 kB before
  // encoding. The upload path could not have accepted one real day's file, and
  // the historical backfill is far larger again.
  //
  // The generous limit is scoped to the one route that needs it. A 25 MB body
  // limit everywhere would be a denial-of-service surface on every endpoint for
  // the benefit of one.
  app.use('/ingestion/upload', express.json({ limit: MAX_UPLOAD_BYTES + 1024 * 1024 }));
  app.use(express.json({ limit: '256kb' }));

  // Tokens live in HttpOnly cookies, never in a body the browser can read (docs/05).
  app.use(cookieParser());
  app.use(securityHeaders({ production }));
  app.use(rateLimit());
  app.use(requireKnownOrigin([webOrigin]));

  // Behind Coolify's reverse proxy every request arrives from the proxy's address.
  // Without this, req.ip is the proxy for everyone and one rep's burst rate-limits
  // the entire company.
  if (production) app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.enableCors({ origin: webOrigin, credentials: true });
  app.enableShutdownHooks();
  await app.listen(PORT);
  console.log(`api      http://localhost:${PORT}/health`);
  console.log(`api      security headers on, rate limiting on, origin locked to ${webOrigin}`);

  // Said out loud on every boot. A security control that can be switched off
  // silently is one nobody notices is off — and this is the one standing between
  // a leaked admin password and every phone number in the business.
  console.log(
    process.env['TOTP_DISABLED'] === '1'
      ? 'api      !! TWO-FACTOR IS OFF for admins (TOTP_DISABLED=1). Development only.'
      : 'api      two-factor required for admins and the owner',
  );
  if (process.env['SHIFT_HOURS_DISABLED'] === '1') {
    console.log('api      !! SHIFT HOURS ARE OFF for reps (SHIFT_HOURS_DISABLED=1). Development only.');
  }
  if (!production) console.log('api      HSTS off and cookies not secure — NODE_ENV is not production');
}

void bootstrap();
