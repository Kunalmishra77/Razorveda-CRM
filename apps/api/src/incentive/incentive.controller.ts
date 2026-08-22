import { Controller, Get, Inject, Param, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { IncentiveService } from './incentive.service.js';
import { IncentiveError } from './incentive.js';

/**
 * Incentive statements (docs/03 §6).
 *
 * ADMIN only for now. A rep seeing her own provisional figure would read it as a
 * promise — O-09 is unanswered, so no number here is the client's scheme yet, and
 * the flag on the response is not something a payslip UI can be trusted to
 * surface before that conversation has happened.
 */
@Controller('incentive')
@UseGuards(AdminGuard)
export class IncentiveController {
  constructor(@Inject(IncentiveService) private readonly incentive: IncentiveService) {}

  @Get(':employeeId')
  async statement(
    @Param('employeeId') employeeId: string,
    @Query('period') period: string | undefined,
    @Req() request: AuthedRequest,
  ) {
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      throw new BadRequestException('Give a period as YYYY-MM, e.g. period=2026-08.');
    }
    try {
      const statement = await this.incentive.statement(request.session!, employeeId, period);
      return {
        ok: true,
        ...statement,
        // Said out loud in the payload, not left for a reader to infer from a
        // boolean. O-09 is open and this figure cannot be paid on.
        ...(statement.provisional
          ? {
              warning:
                'PROVISIONAL. The slab and modifier values are the proposals in docs/03 §6, ' +
                'not the client’s confirmed scheme (O-09). Do not pay against this figure.',
            }
          : {}),
      };
    } catch (e) {
      if (e instanceof IncentiveError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
