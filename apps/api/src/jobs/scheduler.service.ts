import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { FollowupService } from '../leads/followup.service.js';
import { RepeatService } from '../leads/repeat.service.js';
import { DigestsService } from '../notifications/digests.service.js';
import { refreshMetrics } from './refresh-metrics.js';
import { resolveSystemActor } from './system-actor.js';

/**
 * THE AUTOMATION THAT WAS BUILT, TESTED, AND NEVER RAN.
 *
 * CLAUDE.md rule 6: "The only automatic movement is: untouched 48h -> alert,
 * untouched 72h -> return to pool." That rule was implemented in FollowupService,
 * covered by unit and live-RLS tests, and exposed on an endpoint - and nothing
 * ever called it. The only setInterval in the whole codebase was the rate
 * limiter's memory sweep. In production a lead would sit on one rep's list
 * indefinitely, the repeat queue would never materialise, the daily digests would
 * never be sent, and every materialised view would keep serving the day it was
 * created.
 *
 * Four things run here and all four DELEGATE. Not one business rule is
 * reimplemented in this file: the recall predicate, the repeat idempotency guards
 * and the digest drafting stay in the services that own them and are tested there.
 * This class decides only WHEN, and that nothing runs twice.
 *
 * WHY IT IS IN THE API AND NOT apps/worker.
 *
 * The declared home for background work is BullMQ on Redis. These four are not
 * queue-shaped - periodic maintenance, no payload, no fan-out, no retry semantics
 * worth the machinery. Putting them in the worker meant either duplicating the SQL
 * there (two sources of truth for rule 6) or inventing service-to-service auth so
 * the worker could ask the API to do it. It would also mean nobody could run them
 * without Redis, and a job that can only be exercised on a machine with Redis
 * running is a job nobody verifies.
 *
 * The job functions are plain and take a pool, so moving them to the worker later
 * is a change of caller and nothing else. Redis stays for genuine queue work.
 *
 * ON BY DEFAULT. A scheduler that has to be switched on is one that stays off,
 * which is the defect this class exists to fix. SCHEDULER_DISABLED=1 turns it off
 * for tests and CI - the live RLS suite has an untouched-recall test, and a real
 * recall firing underneath it would present as a flaky security test.
 */

/**
 * Advisory-lock keys. Arbitrary but FIXED: two processes must derive the same
 * number for the lock to mean anything.
 */
const LOCK_KEYS = {
  refreshMetrics: 8_310_001,
  recallUntouched: 8_310_002,
  materialiseRepeats: 8_310_003,
  digests: 8_310_004,
} as const;

/** IST. The client is in India and "9am" in the runbooks means 9am there. */
const TZ = 'Asia/Kolkata';

@Injectable()
export class SchedulerService {
  private readonly log = new Logger('Scheduler');
  private readonly disabled = process.env['SCHEDULER_DISABLED'] === '1';

  constructor(
    @Inject(pgLib.Pool) private readonly pool: Pool,
    @Inject(FollowupService) private readonly followups: FollowupService,
    @Inject(RepeatService) private readonly repeats: RepeatService,
    @Inject(DigestsService) private readonly digests: DigestsService,
  ) {
    this.log.log(
      this.disabled
        ? 'DISABLED (SCHEDULER_DISABLED=1) - no automatic lead movement, digests or view refresh'
        : `enabled (${TZ}): metrics/15min, recall hourly, repeats 06:30, digests 08:30`,
    );
  }

  /**
   * Runs `work` while holding a Postgres advisory lock, or skips this tick.
   *
   * WHY A LOCK AT ALL, when rule 9 says one API. Because "one API" is a deployment
   * fact, not a guarantee: a Coolify rolling restart runs two instances for a few
   * seconds, and that is long enough for two ticks to overlap. The recall UPDATE is
   * FOR UPDATE-guarded so it would not double-return a lead, but the digest job has
   * no such protection and would send every rep two copies of her morning plan.
   *
   * A SESSION-level lock on a dedicated client, not pg_advisory_xact_lock: these
   * jobs run several statements and are not one transaction. Released in `finally`,
   * so a job that throws does not hold the lock until the process dies.
   */
  private async exclusively(name: string, key: number, work: () => Promise<string>): Promise<void> {
    if (this.disabled) return;

    const client = await this.pool.connect();
    let held = false;
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      held = rows[0]?.locked === true;
      if (!held) {
        this.log.warn(`${name}: another instance holds the lock, skipping this tick`);
        return;
      }
      this.log.log(`${name}: ${await work()}`);
    } catch (e) {
      // NEVER RETHROW. An unhandled rejection inside a cron callback takes the
      // whole API process down, which turns "the digest failed" into "the CRM is
      // offline". Logged loudly; the next tick tries again.
      this.log.error(`${name} FAILED: ${(e as Error).message}`);
    } finally {
      if (held) await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
      client.release();
    }
  }

  /**
   * Every 15 minutes. A report fifteen minutes old is fine; one frozen at migrate
   * time is not, and CONCURRENTLY means readers are never blocked.
   */
  @Cron('*/15 * * * *', { name: 'refresh-metrics', timeZone: TZ })
  async refreshMetricsTick(): Promise<void> {
    await this.exclusively('refresh-metrics', LOCK_KEYS.refreshMetrics, async () => {
      const r = await refreshMetrics(this.pool);
      const blocking = r.refreshed.filter((v) => !v.concurrent).map((v) => v.view);
      return (
        `${r.refreshed.length} views in ${r.totalMs}ms` +
        (blocking.length ? ` (BLOCKING refresh, no unique index: ${blocking.join(', ')})` : '')
      );
    });
  }

  /**
   * Hourly. The threshold is 72 hours so the exact minute is irrelevant - but
   * hourly means a rep loses a lead at a predictable, explainable time rather than
   * whenever somebody happened to open a screen.
   */
  @Cron('7 * * * *', { name: 'recall-untouched', timeZone: TZ })
  async recallTick(): Promise<void> {
    await this.exclusively('recall-untouched', LOCK_KEYS.recallUntouched, async () => {
      const session = await resolveSystemActor(this.pool);
      const r = await this.followups.recallUntouched(session, new Date().toISOString());
      return r.recalled === 0 ? 'nothing past 72h' : `${r.recalled} lead(s) returned to the pool`;
    });
  }

  /**
   * 06:30 IST, before the shift starts. The repeat queue has to be on a rep's
   * worklist when she sits down, not appear halfway through her morning.
   */
  @Cron('30 6 * * *', { name: 'materialise-repeats', timeZone: TZ })
  async repeatsTick(): Promise<void> {
    await this.exclusively('materialise-repeats', LOCK_KEYS.materialiseRepeats, async () => {
      const session = await resolveSystemActor(this.pool);
      const asOf = new Date().toISOString().slice(0, 10);
      const r = await this.repeats.materialiseDue(session, asOf);
      return (
        `${r.leadsCreated} repeat lead(s) created, ${r.skippedAlreadyOpen} already open, ` +
        `${r.skippedNoOwner} without an owner`
      );
    });
  }

  /**
   * 08:30 IST - after the repeat queue exists, so the morning plan includes it.
   * Ordered by clock time rather than chained, which keeps each independently
   * runnable and re-runnable. That is also how they are tested.
   */
  @Cron('30 8 * * *', { name: 'digests', timeZone: TZ })
  async digestsTick(): Promise<void> {
    await this.exclusively('digests', LOCK_KEYS.digests, async () => {
      const session = await resolveSystemActor(this.pool);
      const r = await this.digests.run(session, new Date());
      return (
        `${r.composed} composed, ${r.sent} sent, ` +
        `${r.skippedAlreadySent} already sent, ${r.failed} failed`
      );
    });
  }
}
