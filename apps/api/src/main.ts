import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';

const PORT = Number(process.env['API_PORT'] ?? 3001);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Tokens live in HttpOnly cookies, never in a body the browser can read (docs/05).
  app.use(cookieParser());
  app.enableCors({ origin: process.env['WEB_ORIGIN'] ?? 'http://localhost:3000', credentials: true });
  app.enableShutdownHooks();
  await app.listen(PORT);
  console.log(`api      http://localhost:${PORT}/health`);
}

void bootstrap();
