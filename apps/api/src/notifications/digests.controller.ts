import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { DigestsService } from './digests.service.js';

/**
 * Running the scheduled digests (Phase 4 deliverable 3).
 *
 * ADMIN only, and exposed rather than purely cron-driven for the same reason the
 * repeat engine is: a scheduled job with no manual trigger is one that gets
 * debugged in production or not at all. An admin whose 07:30 run failed can run
 * the slot it missed instead of waiting a day.
 */
@Controller('digests')
@UseGuards(AdminGuard)
export class DigestsController {
  constructor(@Inject(DigestsService) private readonly digests: DigestsService) {}

  @Post('run')
  async run(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = runSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    const asOf = parsed.data.asOf ? new Date(parsed.data.asOf) : new Date();
    if (Number.isNaN(asOf.getTime())) throw new BadRequestException('asOf must be an ISO timestamp.');

    return { ok: true, ...(await this.digests.run(request.session!, asOf, parsed.data.kinds)) };
  }

  /** What was actually delivered — the evidence exit criterion 5 asks for. */
  @Get('sent')
  async sent(@Query('from') from: string | undefined, @Query('to') to: string | undefined,
             @Req() request: AuthedRequest) {
    return { ok: true, ...(await this.digests.history(request.session!, from, to)) };
  }
}

const runSchema = z.object({
  asOf: z.string().optional(),
  kinds: z.array(z.string().min(1)).optional(),
});
