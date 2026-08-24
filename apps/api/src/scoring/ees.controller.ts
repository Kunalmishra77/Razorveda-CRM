import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { EesService } from './ees.service.js';
import { businessToday } from '@razorveda/shared';

/**
 * Employee Efficiency Score (docs/03 §5).
 *
 * ADMIN only. The score reports on people, and a rep seeing her own percentile
 * rank against unnamed colleagues invites exactly the conversation the client did
 * not ask for. Whether reps ever see it is a management decision, not a default.
 *
 * "Reports on reps. Does not assign leads." There is deliberately no endpoint
 * here that returns a ranked list for assignment purposes.
 */
@Controller('scoring')
@UseGuards(AdminGuard)
export class EesController {
  constructor(@Inject(EesService) private readonly ees: EesService) {}

  /** Runs the score for a date and writes `employee_score_daily`. Nightly in production. */
  @Post('run')
  async run(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = runSchema.safeParse(body ?? {});
    const date = parsed.success && parsed.data.scoreDate ? parsed.data.scoreDate : today();
    const result = await this.ees.run(request.session!, date);
    return {
      ok: true,
      ...result,
      // Said in the payload rather than left to a UI. The score is a ranking of
      // people and the caveats travel with it.
      caveats: [
        'Percentile ranks are within the active team, so they always spread across the range — a low rank does not by itself mean poor work.',
        'Small samples are pulled toward the team mean (k=30 leads), but that does not fully neutralise an extreme outlier. See D-157.',
      ],
    };
  }

  @Get()
  async read(
    @Query('date') date: string | undefined,
    @Req() request: AuthedRequest,
  ) {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('Give a date as YYYY-MM-DD, e.g. date=2026-08-31.');
    }
    return { ok: true, ...(await this.ees.run(request.session!, date)) };
  }
}

const runSchema = z.object({
  scoreDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const today = (): string => businessToday();
