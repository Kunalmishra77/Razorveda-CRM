import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { UNTOUCHED_ALERT_HOURS, UNTOUCHED_RECALL_HOURS } from '@razorveda/shared';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { FollowupService } from './followup.service.js';

/**
 * Untouched-lead alert and recall (Phase 3 deliverable 6).
 *
 * The alert is a GET because it is a question about current state, not an event
 * that fires — see the note in followup.service.ts. The recall is a POST because
 * it takes leads off people's lists.
 *
 * Both ADMIN-only. A rep triggering the recall would be clearing her own list of
 * leads she had not worked, which is exactly backwards.
 */
@Controller('leads/followup')
@UseGuards(AdminGuard)
export class FollowupController {
  constructor(@Inject(FollowupService) private readonly followups: FollowupService) {}

  @Get('untouched')
  async untouched(@Query('asOf') asOf: string | undefined, @Req() request: AuthedRequest) {
    const at = parseAsOf(asOf);
    // CAPPED IN SQL, and the count comes from its own cheap query.
    //
    // This returned all 9,491 matching leads — every customer name and full phone
    // number among them — so a screen could show one number. Same defect as D-231.
    // Slicing in JavaScript would have fixed the payload and none of the cost:
    // the expensive part is the join into `customer`, which runs the isolation
    // policy per row (D-234). The LIMIT moves into the query, and the total is a
    // COUNT with no joins at all.
    const PAGE = 100;
    const [count, leads] = await Promise.all([
      this.followups.countUntouched(request.session!, at, UNTOUCHED_ALERT_HOURS),
      this.followups.findUntouched(request.session!, at, UNTOUCHED_ALERT_HOURS, PAGE),
    ]);

    return {
      ok: true,
      asOf: at,
      thresholdHours: UNTOUCHED_ALERT_HOURS,
      recallAtHours: UNTOUCHED_RECALL_HOURS,
      count,
      shown: leads.length,
      leads,
    };
  }

  @Post('recall')
  async recall(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = recallSchema.safeParse(body ?? {});
    // Same reasoning as the repeat engine: a job that failed overnight is re-run
    // for the moment it missed, not for now.
    const at = parseAsOf(parsed.success ? parsed.data.asOf : undefined);
    return { ok: true, ...(await this.followups.recallUntouched(request.session!, at, UNTOUCHED_RECALL_HOURS)) };
  }
}

const recallSchema = z.object({ asOf: z.string().datetime().optional() });

const parseAsOf = (value: string | undefined): string =>
  value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
