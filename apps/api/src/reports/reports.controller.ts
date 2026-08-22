import { BadRequestException, Controller, Get, Inject, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { ReportsService, parsePeriod } from './reports.service.js';
import { ExportService } from './export.service.js';
import { ClosePackService } from './close-pack.service.js';

/**
 * The daily reports (docs/04) and their export.
 *
 * ADMIN-guarded as a whole. CLAUDE.md rule 7: "All reports live inside ADMIN."
 * The Rep Morning Plan is the one report a rep sees, and it is served by the
 * worklist rather than from here — mixing the two would put an admin guard one
 * refactor away from being the only thing separating a rep from the team's numbers.
 */
@Controller('reports')
@UseGuards(AdminGuard)
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(ExportService) private readonly exports: ExportService,
    @Inject(ClosePackService) private readonly closePack: ClosePackService,
  ) {}

  /**
   * The month-close pack — all nine sections in one call.
   *
   * Assembled together rather than fetched section by section: nine separate
   * requests could straddle a matview refresh and disagree with each other, which
   * is the "two reports, two answers" problem the whole system replaces.
   */
  @Get('close-pack/build')
  async build(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: AuthedRequest,
  ) {
    const period = parsePeriod(from, to);
    return { ok: true, ...(await this.closePack.build(request.session!, period)) };
  }

  @Get(':key')
  async run(
    @Param('key') key: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: AuthedRequest,
  ) {
    const period = parsePeriod(from, to);
    const data = await this.dispatch(key, request, period);
    return { ok: true, report: key, period, ...data };
  }

  @Get(':key/export')
  async exportXlsx(
    @Param('key') key: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Req() request: AuthedRequest,
    @Res() response: Response,
  ) {
    const period = parsePeriod(from, to);
    const data = await this.dispatch(key, request, period);
    const rows = Array.isArray(data.rows) ? data.rows : [];

    const result = await this.exports.toXlsx(request.session!, {
      reportKey: key,
      title: TITLES[key] ?? key,
      rows: rows as Record<string, unknown>[],
      period,
      // Spread rather than assigned: exactOptionalPropertyTypes distinguishes
      // "absent" from "present and undefined", and the export treats them the same.
      ...(data.caveats ? { caveats: data.caveats } : {}),
    });

    response
      .status(200)
      .setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('content-disposition', `attachment; filename="${result.filename}"`)
      // So a caller can tie the download to the audit row without parsing the file.
      .setHeader('x-export-id', result.exportId)
      .send(result.buffer);
  }

  private async dispatch(
    key: string,
    request: AuthedRequest,
    period: { from: string; to: string },
  ): Promise<{ rows?: unknown[]; caveats?: string[]; [k: string]: unknown }> {
    const session = request.session!;
    switch (key) {
      case 'employee-performance':
        return {
          rows: await this.reports.employeePerformance(session, period),
          // docs/04 requires self-reported metrics to be labelled wherever they
          // appear, and an exported spreadsheet is somewhere they appear.
          caveats: [
            'Dials, Connects and Connectivity % are SELF-REPORTED by the rep, not measured. Reps dial from their own handsets.',
          ],
        };
      case 'sales-register':
        return { rows: await this.reports.salesRegister(session, period) };
      case 'lead-pool': {
        const r = await this.reports.leadPool(session, period);
        return { rows: r.bySource, poolNow: r.poolNow };
      }
      case 'dispatch-status': {
        const r = await this.reports.dispatchStatus(session, period);
        return { rows: r.movement, stuck: r.stuck };
      }
      case 'weekly-team-pack':
        return { rows: await this.reports.weeklyTeamPack(session, period) };
      case 'source-performance':
        return { rows: await this.reports.sourcePerformance(session, period) };
      case 'assignment-quality':
        return {
          rows: await this.reports.assignmentQuality(session, period),
          caveats: [
            'Yield is realised value PER LEAD, not a conversion count. A rep who converts fewer leads at higher value is better at that source.',
          ],
        };
      case 'target-comparison': {
        const r = await this.reports.targetComparison(session, period);
        return { rows: r.rows, workingDays: r.workingDays, caveats: r.caveats };
      }
      case 'management-one-pager': {
        const r = await this.reports.managementOnePager(session, period);
        return { rows: [r.totals], topRep: r.topRep, topProduct: r.topProduct };
      }
      default:
        throw new BadRequestException(
          `No report called "${key}". Available: ${Object.keys(TITLES).join(', ')}.`,
        );
    }
  }
}

const TITLES: Readonly<Record<string, string>> = {
  'employee-performance': 'Employee Daily Performance',
  'sales-register': 'Daily Sales Register',
  'lead-pool': 'Daily Lead Pool',
  'dispatch-status': 'Daily Dispatch and Status',
  'management-one-pager': 'Management One-Pager',
  'weekly-team-pack': 'Weekly Team Pack',
  'source-performance': 'Source Performance',
  'assignment-quality': 'Assignment Quality',
  'target-comparison': 'RTO-Adjusted Target Comparison',
};
