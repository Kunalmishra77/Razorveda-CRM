import { Body, Controller, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { RepeatService } from './repeat.service.js';

/**
 * Running the repeat-purchase engine (Phase 3 deliverable 5).
 *
 * Nightly in production. Exposed here because the nightly job needs a caller, an
 * admin needs a way to run it after fixing a `usage_days` value rather than
 * waiting until tomorrow, and a scheduled job with no manual trigger is one that
 * is debugged in production or not at all.
 *
 * ADMIN only. It creates work on other people's lists.
 */
@Controller('leads/repeat')
@UseGuards(AdminGuard)
export class RepeatController {
  constructor(@Inject(RepeatService) private readonly repeats: RepeatService) {}

  @Post('run')
  async run(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = runSchema.safeParse(body ?? {});
    // `asOf` exists so the engine can be run for a specific date — a job that
    // failed overnight is re-run for the day it missed, not for today, which
    // would silently skip everyone who was due in between.
    const asOf = parsed.success && parsed.data.asOf ? parsed.data.asOf : today();
    return { ok: true, ...(await this.repeats.materialiseDue(request.session!, asOf)) };
  }
}

const runSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const today = (): string => new Date().toISOString().slice(0, 10);
