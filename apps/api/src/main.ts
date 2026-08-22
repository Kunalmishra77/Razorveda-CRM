import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import express from 'express';
import { AppModule } from './app.module.js';
import { requireKnownOrigin, securityHeaders } from './security/headers.js';
import { rateLimit } from './security/rate-limit.js';
import { MAX_UPLOAD_BYTES } from './security/upload-guard.js';

const PORT = Number(process.env['API_PORT'] ?? 3001);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
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
  if (!production) console.log('api      HSTS off and cookies not secure — NODE_ENV is not production');
}

void bootstrap();
