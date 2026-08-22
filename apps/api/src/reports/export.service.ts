import { Injectable, Inject, ForbiddenException } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool } from 'pg';
import ExcelJS from 'exceljs';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * XLSX export (Phase 4 deliverable 7): ADMIN only, watermarked, logged.
 *
 * All three conditions matter, and none of them is decoration.
 *
 * ADMIN ONLY — CLAUDE.md §7: "any export capability for the EMPLOYEE role" is on
 * the do-not-build list. Reps dial from their own handsets and full phone numbers
 * are visible to them (rule 8), so the protection against a rep walking out with
 * the customer list is that there is no button. This service refuses an EMPLOYEE
 * session outright rather than relying on a guard being remembered on every route.
 *
 * WATERMARKED — every sheet carries the exporting admin, the timestamp and the
 * export id, in the file itself. If a workbook turns up somewhere it should not
 * be, the question "who exported this?" has an answer that does not depend on
 * server logs still existing.
 *
 * LOGGED — an `audit_log` row per export, written BEFORE the bytes are produced.
 * An export that fails half way still leaves the record that it was attempted,
 * which is the direction that matters: the log must not be a list of successes.
 */

export interface ExportRequest {
  readonly reportKey: string;
  readonly title: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly period: { readonly from: string; readonly to: string };
  /** Notes rendered above the table — provisional-figure warnings live here. */
  readonly caveats?: readonly string[];
}

export interface ExportResult {
  readonly buffer: Buffer;
  readonly filename: string;
  readonly exportId: string;
}

@Injectable()
export class ExportService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  async toXlsx(session: RlsSession, request: ExportRequest): Promise<ExportResult> {
    if (session.role === 'EMPLOYEE') {
      // Stated plainly. A rep who meets this should understand it is a policy,
      // not a bug to be worked around by asking someone.
      throw new ForbiddenException(
        'Export is not available to the employee role. Ask an admin if you need this data.',
      );
    }

    const { exportId, actorName, at } = await this.record(session, request);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = `Razorveda CRM — exported by ${actorName}`;
    workbook.created = at;

    const sheet = workbook.addWorksheet(request.title.slice(0, 31));

    // ── the watermark block ──────────────────────────────────────────────────
    sheet.addRow([request.title]);
    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.addRow([`Period: ${request.period.from} to ${request.period.to}`]);
    sheet.addRow([`Exported by: ${actorName}`]);
    sheet.addRow([`Exported at: ${at.toISOString()}`]);
    sheet.addRow([`Export id: ${exportId}`]);
    sheet.addRow([
      'CONFIDENTIAL — Razorveda internal. This file is watermarked and its export is logged.',
    ]);
    for (const caveat of request.caveats ?? []) sheet.addRow([caveat]);
    sheet.addRow([]);

    // ── the table ────────────────────────────────────────────────────────────
    const headers = Object.keys(request.rows[0] ?? {});
    if (headers.length > 0) {
      const headerRow = sheet.addRow(headers.map(humanise));
      headerRow.font = { bold: true };
      for (const row of request.rows) sheet.addRow(headers.map((h) => cell(row[h])));

      sheet.columns.forEach((column) => {
        // Width from the longest value, capped. An unreadable column is the first
        // thing anyone notices and the easiest thing to get right.
        let longest = 12;
        column.eachCell?.({ includeEmpty: false }, (c) => {
          longest = Math.max(longest, String(c.value ?? '').length + 2);
        });
        column.width = Math.min(longest, 45);
      });
    } else {
      sheet.addRow(['No rows for this period.']);
    }

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      filename: `razorveda-${request.reportKey}-${request.period.from}-to-${request.period.to}.xlsx`,
      exportId,
    };
  }

  /**
   * Written before the file is built, deliberately.
   *
   * A log that only records completed exports cannot answer "what was attempted
   * and failed?", which is exactly the shape of an exfiltration attempt that hit
   * a timeout on a large range.
   */
  private async record(session: RlsSession, request: ExportRequest) {
    return withRlsContext(this.pool, session, async (client) => {
      const { rows: [row] } = await client.query<{ log_id: string; occurred_at: Date }>(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, after_json)
         VALUES ($1, $2::user_role, 'REPORT_EXPORTED', 'report', $3::jsonb)
      RETURNING log_id::text, occurred_at`,
        [
          session.userId,
          session.role,
          JSON.stringify({
            reportKey: request.reportKey,
            period: request.period,
            rowCount: request.rows.length,
          }),
        ],
      );

      // Direct read of app_user, which is admin-only under RLS — and the caller
      // is an admin, because an EMPLOYEE was refused before we got here. No
      // SECURITY DEFINER doorway is needed: the policy already permits this one.
      const { rows: [actor] } = await client.query<{ email: string }>(
        `SELECT email FROM app_user WHERE user_id = $1`,
        [session.userId],
      );

      return {
        // The audit log's own primary key IS the export id. A separate uuid
        // would be a second identifier for one event, and the pair could drift.
        exportId: row!.log_id,
        actorName: actor?.email ?? session.userId,
        at: row!.occurred_at,
      };
    });
  }
}

/** `realised_value` → `Realised Value`. */
function humanise(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\bpct\b/i, '%')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Money and counts arrive from Postgres as strings, deliberately — no float ever
 * touches a money value. They must reach the spreadsheet as NUMBERS, or every
 * total a human types in Excel silently returns zero.
 */
function cell(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}
