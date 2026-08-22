import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { SecurityConsoleService } from './console.service.js';
import { OffboardingService } from './offboarding.service.js';

/**
 * The admin security console (Phase 5 deliverables 5 and 6).
 *
 * ADMIN only. Everything here is either a record of who touched whose phone
 * number, or an action that removes someone's access.
 */
@Controller('security')
@UseGuards(AdminGuard)
export class SecurityController {
  constructor(
    @Inject(SecurityConsoleService) private readonly console: SecurityConsoleService,
    @Inject(OffboardingService) private readonly offboarding: OffboardingService,
  ) {}

  @Get('locked')
  async locked(@Req() request: AuthedRequest) {
    return { ok: true, accounts: await this.console.lockedAccounts(request.session!) };
  }

  /**
   * Unlock an account.
   *
   * This did not exist until now, while eight separate messages in the codebase
   * told users "an admin can unlock it". The velocity lock could put a rep out of
   * the system permanently with raw SQL as the only way back.
   */
  @Post('unlock')
  async unlock(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = unlockSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const result = await this.console.unlock(request.session!, parsed.data.userId, parsed.data.reason);
    if (!result.ok) {
      return { ok: false, message: `${result.employee} is not locked. Nothing to do.` };
    }
    const { ok: _ok, ...detail } = result;
    return { ok: true, ...detail };
  }

  @Get('access-log')
  async accessLog(@Query('from') from: string | undefined, @Query('to') to: string | undefined,
                  @Req() request: AuthedRequest) {
    const period = requirePeriod(from, to);
    return { ok: true, rows: await this.console.accessLog(request.session!, period.from, period.to) };
  }

  @Get('velocity-alerts')
  async velocityAlerts(@Req() request: AuthedRequest) {
    return { ok: true, alerts: await this.console.velocityAlerts(request.session!) };
  }

  @Get('sessions')
  async sessions(@Req() request: AuthedRequest) {
    const rows = await this.console.activeSessions(request.session!);
    // docs/05 requires one active session per EMPLOYEE. Surfaced as a finding
    // rather than left for an admin to spot in a column of numbers.
    const breaches = rows.filter((r) => r.role === 'EMPLOYEE' && r.sessions > 1);
    return {
      ok: true,
      rows,
      ...(breaches.length > 0
        ? {
            warning:
              `${breaches.length} employee(s) have more than one active session, which the ` +
              `single-session rule should make impossible: ${breaches.map((b) => b.email).join(', ')}.`,
          }
        : {}),
    };
  }

  @Get('audit')
  async audit(@Query('from') from: string | undefined, @Query('to') to: string | undefined,
              @Query('action') action: string | undefined, @Req() request: AuthedRequest) {
    const period = requirePeriod(from, to);
    return {
      ok: true,
      rows: await this.console.auditTrail(request.session!, period.from, period.to, action),
    };
  }

  @Get('offboard/preview')
  async offboardPreview(@Query('employeeId') employeeId: string | undefined,
                        @Req() request: AuthedRequest) {
    if (!employeeId) throw new BadRequestException('Give an employeeId.');
    return { ok: true, ...(await this.offboarding.preview(request.session!, employeeId)) };
  }

  @Post('offboard')
  async offboard(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = offboardSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return {
      ok: true,
      ...(await this.offboarding.offboard(
        request.session!, parsed.data.employeeId, parsed.data.handoverNote,
      )),
    };
  }
}

const unlockSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().min(10, 'Give a reason for the unlock — it goes on the audit trail.'),
});

const offboardSchema = z.object({
  employeeId: z.string().uuid(),
  handoverNote: z.string().min(10, 'Write a handover note — the next rep will read it.'),
});

function requirePeriod(from?: string, to?: string): { from: string; to: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !iso.test(from) || !to || !iso.test(to)) {
    throw new BadRequestException('Give a period as from=YYYY-MM-DD&to=YYYY-MM-DD.');
  }
  return { from, to };
}
