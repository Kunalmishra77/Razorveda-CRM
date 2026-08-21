import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Phase 0 stub: declares the queues and proves Redis is reachable.
 *
 * Processors land in later phases (docs/01):
 *   ingestion     Phase 2 — upload, map, normalise, resolve, validate, commit
 *   scoring       Phase 3 — nightly employee_score_daily
 *   reports       Phase 4 — matview refresh and the scheduled digests
 *   notifications Phase 4 — WhatsApp and email delivery
 *
 * Nothing is scheduled yet. A worker that quietly started computing scores before
 * the attribution ledger exists would produce numbers nobody could reproduce.
 */
export const QUEUE_NAMES = ['ingestion', 'scoring', 'reports', 'notifications'] as const;

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

async function bootstrap(): Promise<void> {
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  connection.on('error', (e: Error) => {
    console.error(`worker   redis error: ${e.message}`);
  });

  await connection.ping();

  const queues = QUEUE_NAMES.map((name) => new Queue(name, { connection }));
  console.log(`worker   redis ok, queues registered: ${QUEUE_NAMES.join(', ')}`);
  console.log('worker   no processors yet — see tasks/phase-2-ingestion.md');

  const shutdown = async (): Promise<void> => {
    await Promise.all(queues.map((q) => q.close()));
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void bootstrap().catch((e: unknown) => {
  console.error(`worker failed to start: ${(e as Error).message}`);
  process.exitCode = 1;
});
