import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const PORT = Number(process.env['API_PORT'] ?? 3001);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(PORT);
  console.log(`api      http://localhost:${PORT}/health`);
}

void bootstrap();
