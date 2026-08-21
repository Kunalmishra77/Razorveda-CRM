import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { MetricsController } from './metrics.controller.js';

/**
 * Phase 0 stub. Modules mirror the domain (docs/01): auth, customers, leads,
 * orders, assignment, ingestion, reports, masters, audit — added in Phase 1.
 *
 * Nothing here touches the database yet. The request-scoped transaction that runs
 * SET LOCAL app.user_id / app.user_role is Phase 1 week 3, and no route may read a
 * customer-facing table before it exists (ADR-001).
 */
@Module({ controllers: [HealthController, MetricsController] })
export class AppModule {}
