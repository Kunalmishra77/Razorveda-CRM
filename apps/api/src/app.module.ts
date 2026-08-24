import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
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
import { WorklistController } from './worklist/worklist.controller.js';
import { OrdersController } from './orders/orders.controller.js';
import { StatusService } from './orders/status.service.js';
import { RepeatService } from './leads/repeat.service.js';
import { RepeatController } from './leads/repeat.controller.js';
import { FollowupService } from './leads/followup.service.js';
import { FollowupController } from './leads/followup.controller.js';
import { IncentiveService } from './incentive/incentive.service.js';
import { IncentiveController } from './incentive/incentive.controller.js';
import { EesService } from './scoring/ees.service.js';
import { EesController } from './scoring/ees.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { ExportService } from './reports/export.service.js';
import { ClosePackService } from './reports/close-pack.service.js';
import { ReportsController } from './reports/reports.controller.js';
import { DigestsService } from './notifications/digests.service.js';
import { SchedulerService } from './jobs/scheduler.service.js';
import { DigestsController } from './notifications/digests.controller.js';
import { SecurityConsoleService } from './security/console.service.js';
import { OffboardingService } from './security/offboarding.service.js';
import { SecurityController } from './security/security.controller.js';
import { MasterDataService } from './master/master-data.service.js';
import { MasterDataController } from './master/master-data.controller.js';
import { CustomersController } from './customers/customers.controller.js';
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
  // Starts the cron timers. Without forRoot() the @Cron decorators are inert -
  // which is a quieter version of the exact defect SchedulerService exists to fix,
  // so there is a test asserting the jobs are registered.
  imports: [ScheduleModule.forRoot()],
  controllers: [
    HealthController,
    MetricsController,
    AuthController,
    IngestionController,
    AssignmentController,
    WorklistController,
    OrdersController,
    RepeatController,
    FollowupController,
    IncentiveController,
    EesController,
    ReportsController,
    DigestsController,
    SecurityController,
    MasterDataController,
    CustomersController,
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
    { provide: StatusService, useFactory: (pool: pg.Pool) => new StatusService(pool), inject: [pg.Pool] },
    { provide: RepeatService, useFactory: (pool: pg.Pool) => new RepeatService(pool), inject: [pg.Pool] },
    { provide: FollowupService, useFactory: (pool: pg.Pool) => new FollowupService(pool), inject: [pg.Pool] },
    { provide: IncentiveService, useFactory: (pool: pg.Pool) => new IncentiveService(pool), inject: [pg.Pool] },
    { provide: EesService, useFactory: (pool: pg.Pool) => new EesService(pool), inject: [pg.Pool] },
    { provide: ReportsService, useFactory: (pool: pg.Pool) => new ReportsService(pool), inject: [pg.Pool] },
    { provide: ExportService, useFactory: (pool: pg.Pool) => new ExportService(pool), inject: [pg.Pool] },
    { provide: DigestsService, useFactory: (pool: pg.Pool) => new DigestsService(pool), inject: [pg.Pool] },
    {
      provide: SchedulerService,
      useFactory: (
        pool: pg.Pool,
        followups: FollowupService,
        repeats: RepeatService,
        digests: DigestsService,
      ) => new SchedulerService(pool, followups, repeats, digests),
      inject: [pg.Pool, FollowupService, RepeatService, DigestsService],
    },
    { provide: SecurityConsoleService, useFactory: (pool: pg.Pool) => new SecurityConsoleService(pool), inject: [pg.Pool] },
    { provide: OffboardingService, useFactory: (pool: pg.Pool) => new OffboardingService(pool), inject: [pg.Pool] },
    { provide: MasterDataService, useFactory: (pool: pg.Pool) => new MasterDataService(pool), inject: [pg.Pool] },
    {
      provide: ClosePackService,
      useFactory: (pool: pg.Pool, incentive: IncentiveService, reports: ReportsService) =>
        new ClosePackService(pool, incentive, reports),
      inject: [pg.Pool, IncentiveService, ReportsService],
    },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
