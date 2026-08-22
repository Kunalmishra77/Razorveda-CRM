import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { z } from 'zod';
// Defined in Phase 0, imported by nothing until the cap was found missing.
import { EMPLOYEE_MAX_PAGE_SIZE } from '@razorveda/shared';
import { withRlsContext } from '../db/rls-context.js';
import type { AuthedRequest } from '../auth/session.guard.js';
import { ActivityService, ActivityValidationError } from '../activity/activity.service.js';
import { BAND_LABEL, BAND_ORDER, bandCounts, bandLeads, type WorklistLead } from './order-worklist.js';

/**
 * The employee portal (docs/07 §4).
 *
 * Every route here is scoped by RLS, not by a WHERE clause. A rep asking for
 * another rep's lead gets zero rows, and the controller turns that into 404 —
 * 403 would confirm the record exists (docs/05 test 1).
 */

const activitySchema = z.object({
  leadId: z.string().uuid(),
  type: z.enum(['CALL', 'WHATSAPP', 'SMS', 'NOTE']),
  dispositionId: z.string().uuid().nullable(),
  connected: z.boolean().optional(),
  remarkRaw: z.string().max(4000).optional(),
  followupAt: z.string().datetime().optional(),
});

@Controller()
export class WorklistController {
  constructor(
    @Inject(pgLib.Pool) private readonly pool: Pool,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /**
   * My Day + the worklist, in one call.
   *
   * The order is FIXED and not user-sortable (docs/07 §4). A rep who can sort by
   * value works the big tickets and lets follow-ups rot — which is how 174 client
   * leads sat untouched for a full validity window.
   */
  @Get('worklist')
  async worklist(@Req() request: AuthedRequest) {
    const session = request.session!;
    return withRlsContext(this.pool, session, async (client) => {
      // FILTERED AND CAPPED IN SQL. Both halves were missing, and it took real
      // volume to see it: with three seeded leads the query looked fine.
      //
      // At 14,381 open leads it returned ALL of them — every customer name and
      // full phone number a rep holds, in one GET, in ten seconds. The
      // copy-velocity lock stops four copies in ninety seconds; this handed over
      // fourteen thousand numbers in a single request, which makes the lock
      // decoration. docs/05 test 4 requires the 50-row cap and the test for it
      // PASSED — vacuously, because the fixture never had 51 rows.
      //
      // `EMPLOYEE_MAX_PAGE_SIZE` has existed in packages/shared since Phase 0 and
      // was imported by nothing.
      //
      // The ORDER BY mirrors the band priority in order-worklist.ts so the fifty
      // she gets are the fifty that matter. `bandLeads` still does the
      // authoritative banding on what comes back — SQL chooses the candidates, it
      // does not redefine the rule.
      const { rows } = await client.query<WorklistRow>(
        // THE FIFTY ARE CHOSEN BEFORE ANYTHING IS JOINED.
        //
        // Ordering and limiting in the same SELECT that joins `customer` makes
        // Postgres evaluate the join for all 14,000 leads and then throw away
        // 13,950 — and every one of those rows pays the customer RLS policy, which
        // is itself a subquery. Picking the lead ids first from `lead` alone, then
        // joining only those fifty, is the whole difference between 4.6 seconds
        // and a screen that feels instant.
        `WITH page AS (
           SELECT l.lead_id
             FROM lead l
             LEFT JOIN customer c2 ON c2.customer_id = l.customer_id
            WHERE NOT l.is_converted AND l.closed_at IS NULL
            ORDER BY
              CASE
                WHEN l.next_followup_at < CURRENT_DATE                       THEN 1
                WHEN l.next_followup_at::date = CURRENT_DATE                 THEN 2
                WHEN c2.next_due_date IS NOT NULL
                     AND c2.next_due_date <= CURRENT_DATE                    THEN 3
                WHEN l.assigned_at::date = CURRENT_DATE                      THEN 4
                ELSE 5
              END,
              coalesce(l.next_followup_at, l.assigned_at)
            LIMIT $1
         )
         SELECT l.lead_id, l.next_followup_at, c.next_due_date AS repeat_due_date,
                l.assigned_at, l.valid_till, l.is_converted, l.closed_at,
                c.full_name, c.primary_phone, c.state, c.lifetime_orders,
                s.display_name AS source, l.product_interest, l.contact_attempts,
                d.label AS disposition
           FROM page
           JOIN lead l ON l.lead_id = page.lead_id
           JOIN customer c ON c.customer_id = l.customer_id
           JOIN lead_source s ON s.source_id = l.source_id
           LEFT JOIN disposition d ON d.disposition_id = l.current_disposition_id`,
        [EMPLOYEE_MAX_PAGE_SIZE],
      );

      // The COUNTS are the true totals, not the counts of what was returned. A rep
      // holding 14,000 leads must see 14,000 — capping the page is a transport
      // decision, and hiding the number behind it would be a lie about her day.
      const { rows: [openTotal] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lead
          WHERE NOT is_converted AND closed_at IS NULL AND assigned_to = current_employee_id()`,
      );

      const banded = bandLeads(rows.map(toWorklistLead), new Date().toISOString());
      const counts = bandCounts(banded);
      const totalOpen = Number(openTotal?.n ?? '0');
      const byId = new Map(rows.map((r) => [r.lead_id, r]));

      // My Day (docs/07 §4). Dials and connects are SELF-REPORTED — reps dial from
      // their own handsets (D-03) — and the UI must say so, so the flag ships with
      // the number rather than being remembered.
      const { rows: [today] } = await client.query<{ dials: string; connects: string }>(
        `SELECT count(*) FILTER (WHERE type = 'CALL')::text AS dials,
                count(*) FILTER (WHERE type = 'CALL' AND connected)::text AS connects
           FROM activity
          WHERE employee_id = current_employee_id()
            -- Half-open range, not occurred_at::date = CURRENT_DATE. The cast
            -- makes the column unindexable and turned this into a scan of every
            -- activity row the rep has ever logged.
            AND occurred_at >= CURRENT_DATE
            AND occurred_at <  CURRENT_DATE + 1`,
      );

      const { rows: [targets] } = await client.query<{ monthly_target: string; realised: string }>(
        `SELECT e.monthly_target::text,
                coalesce((
                  SELECT sum(o.final_value) FROM "order" o
                   WHERE o.booked_by_employee_id = e.employee_id
                     AND o.current_status = 'DELIVERED'
                     -- Same reason: date_trunc() on the column defeats the partial
                     -- index on (delivered_date) WHERE current_status='DELIVERED'.
                     AND o.delivered_date >= date_trunc('month', CURRENT_DATE)::date
                     AND o.delivered_date <  (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
                ), 0)::text AS realised
           FROM employee e WHERE e.user_id = $1`,
        [session.userId],
      );

      return {
        ok: true,
        myDay: {
          // Realised, not booked. The only basis for score and incentive.
          monthlyTarget: targets?.monthly_target ?? '0',
          realisedThisMonth: targets?.realised ?? '0',
          dialsToday: Number(today?.dials ?? 0),
          connectsToday: Number(today?.connects ?? 0),
          selfReported: true,
        },
        counts,
        bands: BAND_ORDER.map((band) => ({ band, label: BAND_LABEL[band] })),
        leads: banded.map((b) => {
          const row = byId.get(b.lead.leadId)!;
          return {
            leadId: b.lead.leadId,
            band: b.band,
            bandLabel: BAND_LABEL[b.band],
            fullName: row.full_name,
            phone: row.primary_phone,
            source: row.source,
            interest: row.product_interest,
            state: row.state,
            attempts: row.contact_attempts,
            disposition: row.disposition,
            followupAt: row.next_followup_at,
            validTill: row.valid_till,
            lifetimeOrders: row.lifetime_orders,
          };
        }),
      };
    });
  }

  /** Lead detail, including the full mobile number (docs/07 §4). */
  @Get('leads/:id')
  async lead(@Param('id') leadId: string, @Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows } = await client.query(
        `SELECT l.lead_id, l.contact_attempts, l.ever_connected, l.next_followup_at,
                l.valid_till, l.closed_at, l.is_converted,
                c.customer_id, c.full_name, c.primary_phone, c.city, c.state, c.pincode,
                c.lifetime_orders, c.lifetime_value, c.stage, c.rto_count, c.do_not_call,
                s.display_name AS source, l.product_interest,
                d.label AS current_disposition
           FROM lead l
           JOIN customer c ON c.customer_id = l.customer_id
           JOIN lead_source s ON s.source_id = l.source_id
           LEFT JOIN disposition d ON d.disposition_id = l.current_disposition_id
          WHERE l.lead_id = $1`,
        [leadId],
      );

      const lead = rows[0];
      // RLS already returned nothing for another rep's lead. 404, never 403 —
      // 403 confirms the record exists (docs/05 test 1).
      if (!lead) throw new NotFoundException('That lead was not found.');

      const { rows: history } = await client.query(
        `SELECT a.occurred_at, a.type, a.connected, a.remark_raw, d.label AS disposition
           FROM activity a
           LEFT JOIN disposition d ON d.disposition_id = a.disposition_id
          WHERE a.lead_id = $1
          ORDER BY a.occurred_at DESC LIMIT 20`,
        [leadId],
      );

      const { rows: dispositions } = await client.query(
        `SELECT disposition_id, code, label, category, requires_followup_date, counts_as_connect
           FROM disposition ORDER BY sort_order`,
      );

      return { ok: true, lead, history, dispositions };
    });
  }

  /**
   * Log a contact attempt. Disposition mandatory, enforced server-side (D-77).
   *
   * STATUS CODES MATTER HERE, and they were wrong. This returned HTTP 201 Created
   * for every refusal — including "that lead was not found", which is what a rep
   * gets when she posts against a lead RLS will not show her. Found by the Phase 5
   * adversarial review: the security behaviour was correct (nothing was written,
   * nothing leaked) but any client trusting the status code would record a call
   * that does not exist. The web UI happened to check the body as well, so no
   * user ever saw it; a second client would not have been so lucky.
   *
   * The split is principled rather than uniform:
   *   400 — genuine field validation on a lead she owns. Carries `field` so the
   *         form can highlight it.
   *   404 — the lead is not visible to her. Same answer as GET /leads/:id, and
   *         deliberately indistinguishable from a lead that does not exist: a 403
   *         would confirm the record is real and let her enumerate ids.
   */
  @Post('activity')
  async logActivity(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = activitySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        ok: false,
        field: parsed.error.issues[0]?.path[0],
        message: parsed.error.issues[0]?.message,
      });
    }
    try {
      const result = await this.activity.log(request.session!, {
        leadId: parsed.data.leadId,
        type: parsed.data.type,
        dispositionId: parsed.data.dispositionId,
        remarkRaw: parsed.data.remarkRaw ?? null,
        followupAt: parsed.data.followupAt ?? null,
        connected: parsed.data.connected ?? null,
      });
      return { ok: true, ...result };
    } catch (e) {
      if (e instanceof ActivityValidationError) {
        // "not found" is an existence answer, not a field problem.
        if (e.field === 'leadId') throw new NotFoundException({ ok: false, message: e.message });
        throw new BadRequestException({ ok: false, field: e.field, message: e.message });
      }
      throw e;
    }
  }

  /**
   * Records that a rep revealed or copied a phone number (docs/05).
   *
   * Reps dial from their own handsets, so they must see the number — that removes
   * prevention and leaves detection and attribution. This row is the attribution.
   * The Phase 5 velocity lock reads it.
   */
  @Post('pii/copy')
  async logCopy(
    @Body() body: { leadId?: string; action?: 'VIEW' | 'COPY' },
    @Req() request: AuthedRequest,
  ) {
    if (!body?.leadId) throw new BadRequestException({ ok: false, message: 'No lead given.' });
    const result = await this.activity.logPiiAccess(
      request.session!,
      body.leadId,
      body.action === 'VIEW' ? 'VIEW' : 'COPY',
      request.ip ?? null,
    );

    // The rep is TOLD she has been locked, rather than discovering it as a
    // mysterious sign-out. She may have an innocent explanation, and the message
    // tells her the route to it exists.
    if (result.locked) {
      throw new ForbiddenException({
        ok: false,
        locked: true,
        message:
          'Your account has been locked: too many phone numbers were copied in a short time. ' +
          'Your admin has been notified and can unlock it. If this was not what it looked like, tell them what happened.',
      });
    }

    // `logged: false` means RLS did not show her that lead. Same 404 as everywhere
    // else, and deliberately indistinguishable from a lead that does not exist.
    if (!result.logged) throw new NotFoundException({ ok: false, message: 'That lead was not found.' });

    return { ok: true, recentCopies: result.recentCopies ?? 0 };
  }
}

interface WorklistRow {
  lead_id: string;
  next_followup_at: string | Date | null;
  repeat_due_date: string | Date | null;
  assigned_at: string | Date | null;
  valid_till: string | Date | null;
  is_converted: boolean;
  closed_at: string | Date | null;
  full_name: string | null;
  primary_phone: string | null;
  state: string | null;
  lifetime_orders: number;
  source: string;
  product_interest: string | null;
  contact_attempts: number;
  disposition: string | null;
}

/**
 * The boundary between the driver's types and the domain's.
 *
 * `pg` returns `timestamptz` and `date` columns as JS **Date objects**, not
 * strings. The worklist ordering is pure and typed on ISO strings — it was tested
 * with strings and worked perfectly — so the first real query crashed with
 * "iso.slice is not a function". The unit tests could not have caught it: the gap
 * was never in the logic, it was in the adapter that did not exist yet.
 *
 * Converting here keeps the domain functions pure and string-typed, rather than
 * teaching every one of them about a database driver.
 */
const iso = (v: string | Date | null): string | null => {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
};

const toWorklistLead = (r: WorklistRow): WorklistLead => ({
  leadId: r.lead_id,
  nextFollowupAt: iso(r.next_followup_at),
  repeatDueDate: iso(r.repeat_due_date),
  assignedAt: iso(r.assigned_at),
  validTill: iso(r.valid_till),
  isConverted: r.is_converted,
  closedAt: iso(r.closed_at),
});
