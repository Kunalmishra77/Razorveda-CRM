import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SchedulerService } from '../src/jobs/scheduler.service.js';

/**
 * ARE THE JOBS ACTUALLY WIRED, OR JUST WRITTEN?
 *
 * The defect this whole module exists to fix was automation that was built,
 * tested, and never called. It would be a poor outcome to replace it with
 * automation that is built, tested, decorated — and still never called, which is
 * exactly what happens if `ScheduleModule.forRoot()` is missing from AppModule.
 * The @Cron decorators are inert without it. Nothing throws. Nothing logs. The
 * jobs simply never fire, which is indistinguishable from the original bug.
 *
 * So this asserts both halves: the decorators carry real cron metadata, and the
 * module that activates them is imported.
 *
 * Needs no database and no Nest bootstrap — reading the decorator metadata is
 * enough, and keeps this in the fast suite where it belongs.
 */

const SCHEDULE_CRON_OPTIONS = 'SCHEDULE_CRON_OPTIONS';

/** The four jobs, and the schedule each is supposed to keep. */
const EXPECTED = [
  { method: 'refreshMetricsTick', cron: '*/15 * * * *', why: 'stale reports' },
  { method: 'recallTick', cron: '7 * * * *', why: 'CLAUDE.md rule 6, the 72h pool return' },
  { method: 'repeatsTick', cron: '30 6 * * *', why: 'the repeat queue, before the shift' },
  { method: 'digestsTick', cron: '30 8 * * *', why: 'the daily digests' },
] as const;

describe('scheduled jobs are registered', () => {
  for (const { method, cron, why } of EXPECTED) {
    it(`${method} is decorated to run at "${cron}" (${why})`, () => {
      const fn = (SchedulerService.prototype as unknown as Record<string, unknown>)[method];
      expect(typeof fn, `SchedulerService.${method} does not exist`).toBe('function');

      const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, fn as object) as
        | { name?: string; timeZone?: string }
        | undefined;

      expect(
        options,
        `${method} has no @Cron metadata, so it will never run. This is the same ` +
          'outcome as the original defect: the code exists and nothing calls it.',
      ).toBeTruthy();
      expect(options?.timeZone, 'the client is in India; a UTC schedule means digests at the wrong hour').toBe(
        'Asia/Kolkata',
      );
    });
  }

  it('the cron expression is the one written on the method, not a default', () => {
    // Guard against the metadata being present but empty — asserting only that
    // @Cron exists would pass for @Cron('* * * * * *'), which would run the pool
    // return every second.
    const fn = (SchedulerService.prototype as unknown as Record<string, unknown>)['recallTick'];
    const key = Reflect.getMetadataKeys(fn as object);
    expect(key).toContain(SCHEDULE_CRON_OPTIONS);
  });

  it('AppModule imports ScheduleModule.forRoot(), without which every @Cron is inert', () => {
    const module = readFileSync(fileURLToPath(new URL('../src/app.module.ts', import.meta.url)), 'utf8');

    expect(
      module,
      'ScheduleModule.forRoot() is missing from AppModule. Every @Cron above is then ' +
        'decoration: the timers are never created, nothing throws, and the 72h pool ' +
        'return silently stops happening again.',
    ).toContain('ScheduleModule.forRoot()');

    expect(module, 'SchedulerService is not provided, so it is never instantiated').toContain('SchedulerService');
  });

  it('SCHEDULER_DISABLED is read from the environment, so tests can turn it off', () => {
    // The live RLS suite starts a real API. A recall firing under it would present
    // as an intermittently failing security test, which is the worst kind.
    const source = readFileSync(fileURLToPath(new URL('../src/jobs/scheduler.service.ts', import.meta.url)), 'utf8');
    expect(source).toContain("process.env['SCHEDULER_DISABLED'] === '1'");

    // ...and it must default to ENABLED. A scheduler that needs switching on is one
    // that stays off in production, which is the bug, not the fix.
    expect(source).not.toContain("=== 'SCHEDULER_ENABLED'");
  });
});
