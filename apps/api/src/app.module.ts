import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import pg from 'pg';
import { HealthController } from './health.controller.js';
import { MetricsController } from './metrics.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { SessionGuard } from './auth/session.guard.js';
import { IngestionController } from './ingestion/ingestion.controller.js';
import { UploadService } from './ingestion/upload.service.js';
import { CommitService } from './ingestion/commit.service.js';
import { AssignmentController } from './assignment/assignment.controller.js';
import { AssignmentService } from './assignment/assignment.service.js';
import { ActivityService } from './activity/activity.service.js';
import { createAppPool } from './db/pool.js';
import { LocalFileStorage, type StorageAdapter } from './storage/storage.js';

/**
 * Modules mirror the domain (docs/01).
 *
 * SessionGuard is registered GLOBALLY. A route is protected unless it explicitly
 * opts out with @Public() — the opposite default would mean one forgotten
 * decorator silently exposes customer data, and forgetting is the failure mode
 * this whole codebase is built around.
 */
@Module({
  controllers: [
    HealthController,
    MetricsController,
    AuthController,
    IngestionController,
    AssignmentController,
  ],
  providers: [
    { provide: pg.Pool, useFactory: (): pg.Pool => createAppPool() },
    {
      provide: 'STORAGE',
      useFactory: (): StorageAdapter =>
        // MinIO on Coolify; the filesystem locally, for the same reason Postgres
        // runs from npm binaries rather than a container (D-79, D-95).
        new LocalFileStorage(process.env['UPLOAD_DIR'] ?? '.uploads'),
    },
    { provide: AuthService, useFactory: (pool: pg.Pool) => new AuthService(pool), inject: [pg.Pool] },
    {
      provide: UploadService,
      useFactory: (pool: pg.Pool, storage: StorageAdapter) => new UploadService(pool, storage),
      inject: [pg.Pool, 'STORAGE'],
    },
    { provide: CommitService, useFactory: (pool: pg.Pool) => new CommitService(pool), inject: [pg.Pool] },
    {
      provide: AssignmentService,
      useFactory: (pool: pg.Pool) => new AssignmentService(pool),
      inject: [pg.Pool],
    },
    { provide: ActivityService, useFactory: (pool: pg.Pool) => new ActivityService(pool), inject: [pg.Pool] },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
