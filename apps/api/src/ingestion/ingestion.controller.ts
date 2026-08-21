import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  detectColumnShift, describeShift, isException, normaliseName, repairEncodingDetailed,
  validateRow, type ColumnCheck, type TypeContract,
} from '@razorveda/shared';
import { withRlsContext } from '../db/rls-context.js';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { UploadService, DuplicateFileError } from './upload.service.js';
import { CommitService, CommitError } from './commit.service.js';

/**
 * Upload Centre and Exception Review (docs/07 modules 1 and 2).
 *
 * The endpoint an admin's whole day runs through. The promise it has to keep:
 * **clean rows are never returned.** `/exceptions` deliberately cannot fetch a
 * VALID row — that is what turns a 500-row file into a 26-row review.
 */

const uploadSchema = z.object({
  sourceCode: z.string().min(1),
  fileName: z.string().min(1),
  /** The file, base64. Real multipart handling lands with the upload widget. */
  contentBase64: z.string().min(1),
});

@Controller('ingestion')
@UseGuards(AdminGuard)
export class IngestionController {
  constructor(
    @Inject(pgLib.Pool) private readonly pool: Pool,
    @Inject(UploadService) private readonly uploads: UploadService,
    @Inject(CommitService) private readonly commits: CommitService,
  ) {}

  @Post('upload')
  async upload(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = uploadSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const session = request.session!;

    const bytes = new Uint8Array(Buffer.from(parsed.data.contentBase64, 'base64'));
    const text = Buffer.from(bytes).toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) {
      throw new BadRequestException('That file has a header but no rows. Check the export.');
    }

    const headers = (lines[0] as string).split(',').map((h) => h.trim());
    const rows = lines.slice(1).map((l) => l.split(','));

    const source = await this.loadSource(session, parsed.data.sourceCode);

    // The column-shift detector runs BEFORE anything is staged (docs/06 stage 5).
    // A shifted batch must not leave a single row behind.
    const shift = detectColumnShift(buildChecks(headers, rows), today());
    if (shift.shifted) {
      return {
        ok: false,
        status: 'SHIFTED',
        message: describeShift(shift),
        offenders: shift.offenders,
      };
    }

    try {
      const batch = await this.uploads.upload(
        session,
        { sourceId: source.sourceId, fileName: parsed.data.fileName, bytes, headers },
        rows.length,
      );

      const summary = await this.stage(session, batch.batchId, headers, rows, source.dateLocale);
      return { ok: true, batchId: batch.batchId, ...summary };
    } catch (e) {
      if (e instanceof DuplicateFileError) {
        return { ok: false, status: 'DUPLICATE', message: e.message, batchId: e.existingBatchId };
      }
      throw e;
    }
  }

  /** Batch history for the Upload Centre. */
  @Get('batches')
  async batches(@Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows } = await client.query(
        `SELECT b.batch_id, b.file_name, b.status, b.row_count, b.rows_committed,
                b.created_at, b.committed_at, s.display_name AS source,
                (SELECT count(*) FROM staging_row r
                  WHERE r.batch_id = b.batch_id AND r.validation_status <> 'VALID') AS exceptions
           FROM ingestion_batch b JOIN lead_source s ON s.source_id = b.source_id
          ORDER BY b.created_at DESC LIMIT 50`,
      );
      return { ok: true, batches: rows };
    });
  }

  /**
   * ONLY exceptions. There is no parameter that returns a clean row.
   *
   * docs/06 stage 6: "Admin sees only rows with status WARNING, ERROR or
   * DUPLICATE. Clean rows are never rendered — that is the entire point."
   */
  @Get('batches/:id/exceptions')
  async exceptions(@Param('id') batchId: string, @Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows } = await client.query(
        `SELECT staging_id, row_number, validation_status, validation_errors, raw_json, normalised_json
           FROM staging_row
          WHERE batch_id = $1 AND validation_status <> 'VALID'
          ORDER BY row_number`,
        [batchId],
      );
      const { rows: counts } = await client.query<{ status: string; n: string }>(
        `SELECT validation_status AS status, count(*)::text AS n
           FROM staging_row WHERE batch_id = $1 GROUP BY validation_status`,
        [batchId],
      );
      return { ok: true, exceptions: rows, counts };
    });
  }

  /** Bulk-accept warnings, so 20 identical ambiguous dates are one click. */
  @Post('batches/:id/accept-warnings')
  async acceptWarnings(@Param('id') batchId: string, @Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE staging_row SET validation_status = 'VALID'
          WHERE batch_id = $1 AND validation_status = 'WARNING'`,
        [batchId],
      );
      return { ok: true, accepted: rowCount ?? 0 };
    });
  }

  @Post('batches/:id/commit')
  async commit(@Param('id') batchId: string, @Req() request: AuthedRequest) {
    try {
      return { ok: true, ...(await this.commits.commit(request.session!, batchId)) };
    } catch (e) {
      if (e instanceof CommitError) return { ok: false, message: e.message };
      throw e;
    }
  }

  @Post('batches/:id/rollback')
  async rollback(
    @Param('id') batchId: string,
    @Body() body: { reason?: string },
    @Req() request: AuthedRequest,
  ) {
    try {
      const result = await this.commits.rollback(
        request.session!,
        batchId,
        body?.reason ?? 'Rolled back from the Upload Centre',
      );
      return { ok: true, ...result };
    } catch (e) {
      if (e instanceof CommitError) return { ok: false, message: e.message };
      throw e;
    }
  }

  private async loadSource(
    session: AuthedRequest['session'],
    code: string,
  ): Promise<{ sourceId: string; dateLocale: 'DMY' | 'MDY' | 'YMD' }> {
    return withRlsContext(this.pool, session!, async (client) => {
      const { rows } = await client.query<{ source_id: string; date_locale: string }>(
        `SELECT source_id, date_locale FROM lead_source WHERE code = $1 AND is_active`,
        [code],
      );
      const source = rows[0];
      if (!source) throw new BadRequestException(`No active lead source called "${code}".`);
      return {
        sourceId: source.source_id,
        dateLocale: (source.date_locale as 'DMY' | 'MDY' | 'YMD') ?? 'DMY',
      };
    });
  }

  private async stage(
    session: AuthedRequest['session'],
    batchId: string,
    headers: readonly string[],
    rows: readonly string[][],
    dateLocale: 'DMY' | 'MDY' | 'YMD',
  ) {
    const index = (name: string): number =>
      headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

    const at = (row: readonly string[], name: string): string | undefined => {
      const i = index(name);
      return i === -1 ? undefined : row[i];
    };

    return withRlsContext(this.pool, session!, async (client) => {
      let exceptions = 0;
      for (const [i, row] of rows.entries()) {
        const input = {
          date: at(row, 'Date') ?? at(row, 'created_time'),
          name: at(row, 'Name') ?? at(row, 'Customer name') ?? at(row, 'CustomerName') ?? at(row, 'full_name'),
          phone: at(row, 'Number') ?? at(row, 'Phone no') ?? at(row, 'Phoneno') ?? at(row, 'phone_number'),
          amount: at(row, 'Amount') ?? at(row, 'Total amount'),
          paymentMode: at(row, 'Payment Mode') ?? at(row, 'PaymentMode'),
          pincode: at(row, 'Pincode'),
          state: at(row, 'State') ?? at(row, 'state'),
          productText: at(row, 'Product detail') ?? at(row, 'ProductDeatil') ?? at(row, 'Product'),
        };

        const verdict = validateRow(input, {
          requiredFields: ['phone'],
          dateLocale,
          todayIso: today(),
        });

        // The name is NORMALISED before staging, not stored raw. Skipping this
        // put `à¤®à¥‹à¤¹à¤¨` into the customer table verbatim — the
        // mojibake repair exists and simply was not being called, which is the
        // most ordinary way a correct function fails to help anyone.
        const repair = repairEncodingDetailed(input.name ?? '');
        const cleanName = normaliseName(input.name ?? '');
        const issues = repair.lossy
          ? [
              ...verdict.issues,
              {
                field: 'name',
                code: 'ENCODING_PARTIAL',
                severity: 'WARNING' as const,
                message:
                  `"${cleanName}" was recovered from mis-encoded text, but one or more ` +
                  `characters were destroyed before the file reached us and cannot be restored. ` +
                  `Check the spelling with the customer.`,
              },
            ]
          : verdict.issues;
        const status = repair.lossy && verdict.status === 'VALID' ? 'WARNING' : verdict.status;

        if (isException(status)) exceptions += 1;

        await client.query(
          `INSERT INTO staging_row (batch_id, row_number, raw_json, normalised_json,
                                    validation_status, validation_errors, resolved_action)
           VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::row_status,$6::jsonb,'CREATE')`,
          [
            batchId, i + 1,
            JSON.stringify(Object.fromEntries(headers.map((h, k) => [h, row[k] ?? '']))),
            JSON.stringify({
              name: cleanName, phone: verdict.normalised.phone, date: verdict.normalised.date,
              amount: input.amount, prepaidAmount: verdict.normalised.prepaidAmount,
              codAmount: verdict.normalised.codAmount, pincode: input.pincode,
              state: input.state, productText: input.productText,
            }),
            status, JSON.stringify(issues),
          ],
        );
      }

      await client.query(`UPDATE ingestion_batch SET status = 'REVIEW' WHERE batch_id = $1`, [batchId]);
      return { rows: rows.length, exceptions, clean: rows.length - exceptions };
    });
  }
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Type contracts per column (docs/06 §5.1, O-12). Anything unrecognised is
 * FREE_TEXT, which the heuristic still watches — so an unknown column is not a
 * blind spot.
 */
function buildChecks(headers: readonly string[], rows: readonly string[][]): ColumnCheck[] {
  const CONTRACTS: Record<string, TypeContract> = {
    date: { kind: 'DATE', locale: 'DMY' },
    created_time: { kind: 'DATE', locale: 'YMD' },
    number: { kind: 'PHONE' }, 'phone no': { kind: 'PHONE' }, phoneno: { kind: 'PHONE' },
    phone_number: { kind: 'PHONE' }, 'alt number': { kind: 'PHONE' },
    amount: { kind: 'MONEY', min: 1 }, 'total amount': { kind: 'MONEY', min: 1 },
    pincode: { kind: 'PINCODE' }, awb: { kind: 'AWB' },
  };

  return headers.map((header, i) => ({
    column: header,
    targetField: header,
    contract: CONTRACTS[header.toLowerCase()] ?? { kind: 'FREE_TEXT' },
    values: rows.map((r) => r[i] ?? ''),
  }));
}
