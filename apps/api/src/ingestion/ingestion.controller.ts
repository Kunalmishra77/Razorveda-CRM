import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  detectColumnShift, describeShift, isException, normaliseName, proposeMappingFromAliases,
  repairEncodingDetailed, validateRow,
  type ColumnCheck, type TargetField, type TypeContract,
} from '@razorveda/shared';
import { withRlsContext } from '../db/rls-context.js';
import { resolveIdentity, type Candidate, type MatchedOn } from '../customers/resolve-identity.js';
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
    // THE CERTIFIED MAPPER, not a second set of hardcoded header lookups.
    //
    // This function used to reach for columns by name itself — `at(row, 'Name')
    // ?? at(row, 'Customer name')` and so on. `proposeMappingFromAliases` existed
    // the whole time, with the B8 deny-list and eleven tests behind it, and was
    // never called by anything. Two mapping implementations, and the tested one
    // was the dead one.
    //
    // What the live one silently did NOT read: `Order id`, so every ingested
    // order fell back to `RV-<batch>-<customer>` and a repeat customer's SECOND
    // order in the same file hit ON CONFLICT DO NOTHING and vanished without a
    // message. `Final amount`, so `legacy_credit_value` was always null and the
    // reconciliation report docs/06 §4 promises had nothing to reconcile. And the
    // parsed payment mode, so every order committed as UNKNOWN.
    const proposal = proposeMappingFromAliases(headers);
    const columnOf = new Map<TargetField, number>();
    proposal.columns.forEach((c, i) => {
      if (c.targetField && !columnOf.has(c.targetField)) columnOf.set(c.targetField, i);
    });

    const field = (row: readonly string[], target: TargetField): string | undefined => {
      const i = columnOf.get(target);
      return i === undefined ? undefined : row[i];
    };

    return withRlsContext(this.pool, session!, async (client) => {
      let exceptions = 0;
      for (const [i, row] of rows.entries()) {
        // `final_value` comes from Total amount / Amount, and falls back to
        // `Final amount` ONLY when neither is present (docs/06 §Rules 1). The
        // words are inverted in the client's sheets: their "Final amount" is the
        // employee credit, not the order total, which is why it can never be the
        // first choice and why the mapper denies it the `final_value` target.
        const totalAmount = field(row, 'final_value');
        const legacyCredit = field(row, 'legacy_credit_value');

        const input = {
          date: field(row, 'order_date') ?? field(row, 'delivered_date'),
          name: field(row, 'full_name'),
          phone: field(row, 'primary_phone'),
          amount: totalAmount ?? legacyCredit,
          paymentMode: field(row, 'payment_mode_text'),
          pincode: field(row, 'pincode'),
          state: field(row, 'state'),
          productText: field(row, 'product_text'),
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

        // IDENTITY RESOLUTION — docs/06 §4, and CLAUDE.md rule 4.
        //
        // `resolved_action` used to be the literal 'CREATE' for every row, and
        // `resolveIdentity` — defined, tested, and the module this decision
        // belongs in — was called by nothing. Dedupe still half-worked, because
        // commit ends in ON CONFLICT (customer.primary_phone), so rows whose
        // PRIMARY phone already existed collapsed by accident of a unique index.
        //
        // What that missed is the entire point of rule 4: the mobile number is
        // the business key and phones live in `customer_identifier`, many to one.
        // A customer arriving on her ALT number matched nothing and became a
        // second customer. The admin also saw "CREATE" against a row that was
        // about to merge, so the exception review could not show the one thing
        // it exists to show.
        const resolution = resolveIdentity(
          { normalisedPhone: verdict.normalised.phone, name: cleanName || null, pincode: input.pincode ?? null },
          await this.findCandidates(client, verdict.normalised.phone, cleanName, input.pincode),
        );

        // An uncertain merge or an unkeyable row is an EXCEPTION even when every
        // field validated: the admin has a decision to make, and the whole point
        // of review is to surface exactly those. Without this the upload reported
        // a clean file and then quietly committed fewer rows than it staged.
        const needsResolution =
          resolution.action === 'MERGE_CANDIDATE' || resolution.action === 'PARK';
        if (isException(status) || needsResolution) exceptions += 1;

        await client.query(
          `INSERT INTO staging_row (batch_id, row_number, raw_json, normalised_json,
                                    validation_status, validation_errors, resolved_action,
                                    resolved_customer_id)
           VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::row_status,$6::jsonb,$7,$8)`,
          [
            batchId, i + 1,
            JSON.stringify(Object.fromEntries(headers.map((h, k) => [h, row[k] ?? '']))),
            JSON.stringify({
              name: cleanName, phone: verdict.normalised.phone, date: verdict.normalised.date,
              amount: input.amount, prepaidAmount: verdict.normalised.prepaidAmount,
              codAmount: verdict.normalised.codAmount,
              // The three that were being dropped between parsing and staging.
              paymentMode: verdict.normalised.paymentMode,
              externalRef: field(row, 'external_ref') ?? null,
              legacyCreditValue: totalAmount ? (legacyCredit ?? null) : null,
              pincode: input.pincode, state: input.state, city: field(row, 'city') ?? null,
              productText: input.productText,
              awbNumber: field(row, 'awb_number') ?? null,
              statusText: field(row, 'status_text') ?? null,
              remark: field(row, 'remark') ?? field(row, 'reason') ?? null,
              callerName: field(row, 'caller_name') ?? null,
            }),
            status, JSON.stringify(issues),
            resolution.action,
            'customerId' in resolution ? resolution.customerId : null,
          ],
        );
      }

      await client.query(`UPDATE ingestion_batch SET status = 'REVIEW' WHERE batch_id = $1`, [batchId]);
      return { rows: rows.length, exceptions, clean: rows.length - exceptions };
    });
  }
  /**
   * The SQL half of identity resolution.
   *
   * `resolve-identity.ts` deliberately does NOT compute name similarity — that is
   * pg_trgm's job (D-14), and reimplementing trigram scoring in TypeScript would
   * create a second source of truth for the most consequential number in dedupe.
   * So this gathers scored candidates and the pure function decides.
   *
   * Three ways in, in the order the resolver ranks them:
   *   PRIMARY_PHONE  the phone is a customer's own primary number
   *   IDENTIFIER     the phone is ANY number we hold for a customer, which is
   *                  what makes the mobile a business key rather than a column
   *                  (rule 4) — this is the arm that was missing entirely
   *   FUZZY          name similarity AND a matching pincode, never name alone
   */
  private async findCandidates(
    client: PoolClient,
    phone: string | null,
    name: string,
    pincode: string | undefined,
  ): Promise<Candidate[]> {
    const candidates: Candidate[] = [];

    if (phone) {
      const { rows } = await client.query<{ customer_id: string; matched_on: string }>(
        `SELECT customer_id, 'PRIMARY_PHONE' AS matched_on FROM customer WHERE primary_phone = $1
         UNION
         SELECT customer_id, 'IDENTIFIER'    AS matched_on FROM customer_identifier
          WHERE type IN ('MOBILE','ALT_MOBILE','WHATSAPP') AND value = $1`,
        [phone],
      );
      for (const r of rows) {
        candidates.push({ customerId: r.customer_id, matchedOn: r.matched_on as MatchedOn });
      }
    }

    // Fuzzy only when there is something to be fuzzy about. A blank name and a
    // pincode would otherwise match every customer in that pincode.
    if (name.trim() !== '' && pincode) {
      const { rows } = await client.query<{ customer_id: string; sim: number }>(
        `SELECT customer_id, similarity(full_name, $1) AS sim
           FROM customer
          WHERE full_name IS NOT NULL AND pincode = $2 AND full_name % $1
          ORDER BY sim DESC LIMIT 5`,
        [name, pincode],
      );
      for (const r of rows) {
        candidates.push({
          customerId: r.customer_id,
          matchedOn: 'FUZZY',
          nameSimilarity: Number(r.sim),
          pincodeMatches: true,
        });
      }
    }

    return candidates;
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
