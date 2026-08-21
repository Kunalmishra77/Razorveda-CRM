import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withRlsContext } from '../db/rls-context.js';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { AssignmentService } from './assignment.service.js';
import { preAssignWarnings, suggestSplit, type PoolLead, type RepSnapshot } from './pre-assign-warnings.js';

/**
 * Lead Assignment — "the most important admin screen" (docs/07 §3).
 *
 * D-02 governs every line: nothing here moves a lead without an admin pressing
 * the button, and the Suggested Split is a proposal the admin applies, edits or
 * ignores.
 */

const assignSchema = z.object({
  toEmployeeId: z.string().uuid(),
  mode: z.enum(['IDS', 'FILTER']),
  leadIds: z.array(z.string().uuid()).optional(),
  excludeLeadIds: z.array(z.string().uuid()).optional(),
  filter: z
    .object({
      sourceId: z.string().uuid().optional(),
      state: z.string().optional(),
      minAgeHours: z.number().int().nonnegative().optional(),
    })
    .optional(),
  overrideReason: z.string().max(500).optional(),
});

@Controller('assignment')
@UseGuards(AdminGuard)
export class AssignmentController {
  constructor(
    @Inject(pgLib.Pool) private readonly pool: Pool,
    @Inject(AssignmentService) private readonly assignments: AssignmentService,
  ) {}

  /** The unassigned pool. Capped page size; the count covers the whole filter. */
  @Get('pool')
  async pool_(
    @Req() request: AuthedRequest,
    @Query('sourceId') sourceId?: string,
    @Query('state') state?: string,
    @Query('minAgeHours') minAgeHours?: string,
    @Query('limit') limit?: string,
  ) {
    const session = request.session!;
    const filter = {
      ...(sourceId ? { sourceId } : {}),
      ...(state ? { state } : {}),
      ...(minAgeHours ? { minAgeHours: Number(minAgeHours) } : {}),
    };
    const pageSize = Math.min(Number(limit ?? 25), 100);

    return withRlsContext(this.pool, session, async (client) => {
      const params: unknown[] = [];
      const clauses = ['l.assigned_to IS NULL', 'l.is_converted = false', 'l.closed_at IS NULL'];
      if (filter.sourceId) { params.push(filter.sourceId); clauses.push(`l.source_id = $${params.length}`); }
      if (filter.state) { params.push(filter.state); clauses.push(`c.state = $${params.length}`); }
      if (filter.minAgeHours !== undefined) {
        params.push(filter.minAgeHours);
        clauses.push(`l.received_at < now() - make_interval(hours => $${params.length}::int)`);
      }
      const where = clauses.join(' AND ');

      const { rows } = await client.query(
        `SELECT l.lead_id, c.customer_id, c.full_name, c.primary_phone, c.state,
                s.display_name AS source, l.product_interest, l.predicted_value,
                round(extract(epoch from now() - l.received_at) / 3600)::int AS age_hours,
                (l.valid_till IS NOT NULL AND l.valid_till < CURRENT_DATE) AS past_validity,
                c.owner_employee_id
           FROM lead l
           JOIN customer c ON c.customer_id = l.customer_id
           JOIN lead_source s ON s.source_id = l.source_id
          WHERE ${where}
          ORDER BY l.received_at ASC
          LIMIT ${pageSize}`,
        params,
      );

      const total = await this.assignments.countPool(session, filter);
      const { rows: reps } = await client.query(repQuery());
      return { ok: true, total, leads: rows, reps };
    });
  }

  /** Warnings BEFORE assigning. They never block; overrides are logged. */
  @Post('preview')
  async preview(
    @Body() body: { toEmployeeId: string; leadIds: string[] },
    @Req() request: AuthedRequest,
  ) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows: reps } = await client.query<RepRow>(repQuery());
      const rep = reps.find((r) => r.employee_id === body.toEmployeeId);
      if (!rep) return { ok: false, message: 'Choose a rep to assign to.' };

      const { rows: selected } = await client.query<PoolLeadRow>(
        `SELECT l.lead_id, l.customer_id,
                round(extract(epoch from now() - l.received_at) / 3600)::int AS age_hours,
                (l.valid_till IS NOT NULL AND l.valid_till < CURRENT_DATE) AS past_validity,
                c.owner_employee_id
           FROM lead l JOIN customer c ON c.customer_id = l.customer_id
          WHERE l.lead_id = ANY($1::uuid[])`,
        [body.leadIds ?? []],
      );

      const { rows: whole } = await client.query<PoolLeadRow>(
        `SELECT l.lead_id, l.customer_id,
                round(extract(epoch from now() - l.received_at) / 3600)::int AS age_hours,
                (l.valid_till IS NOT NULL AND l.valid_till < CURRENT_DATE) AS past_validity,
                c.owner_employee_id
           FROM lead l JOIN customer c ON c.customer_id = l.customer_id
          WHERE l.assigned_to IS NULL AND l.is_converted = false AND l.closed_at IS NULL`,
      );

      return {
        ok: true,
        warnings: preAssignWarnings(toSnapshot(rep), selected.map(toPoolLead), whole.map(toPoolLead)),
      };
    });
  }

  /** Advisory only. Never assigns (D-02). */
  @Get('suggested-split')
  async suggestedSplit(@Query('leadCount') leadCount: string, @Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows: reps } = await client.query<RepRow>(repQuery());
      return {
        ok: true,
        advisory: true,
        proposal: suggestSplit(reps.map(toSnapshot), Number(leadCount ?? 0)),
      };
    });
  }

  @Post('assign')
  async assign(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = assignSchema.safeParse(body);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message };
    const d = parsed.data;

    const result = await this.assignments.bulkAssign(request.session!, {
      request:
        d.mode === 'IDS'
          ? { mode: 'IDS', leadIds: d.leadIds ?? [] }
          : { mode: 'FILTER', excludeLeadIds: d.excludeLeadIds ?? [] },
      filter: d.filter ?? {},
      toEmployeeId: d.toEmployeeId,
      ...(d.overrideReason ? { overrideReason: d.overrideReason } : {}),
    });

    return { ok: true, ...result };
  }
}

interface RepRow {
  employee_id: string;
  full_name: string;
  status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'EXITED';
  wip_cap: number;
  open_leads: string;
  yield_per_lead: string;
}

interface PoolLeadRow {
  lead_id: string;
  customer_id: string;
  age_hours: number;
  past_validity: boolean;
  owner_employee_id: string | null;
}

/** Open workload and last month's yield — the two inputs the Split panel uses. */
const repQuery = (): string => `
  SELECT e.employee_id, e.full_name, e.status, e.wip_cap,
         (SELECT count(*) FROM lead l
           WHERE l.assigned_to = e.employee_id AND l.is_converted = false
             AND l.closed_at IS NULL)::text AS open_leads,
         coalesce((
           SELECT sum(o.final_value) / nullif(count(DISTINCT l2.lead_id), 0)
             FROM lead l2
             LEFT JOIN "order" o ON o.lead_id = l2.lead_id AND o.current_status = 'DELIVERED'
            WHERE l2.assigned_to = e.employee_id
              AND l2.assigned_at > now() - interval '30 days'
         ), 0)::text AS yield_per_lead
    FROM employee e
   WHERE e.status <> 'EXITED'
   ORDER BY e.emp_code`;

const toSnapshot = (r: RepRow): RepSnapshot => ({
  employeeId: r.employee_id,
  fullName: r.full_name,
  status: r.status,
  wipCap: r.wip_cap,
  openLeads: Number(r.open_leads),
  yieldPerLead: Number(r.yield_per_lead),
});

const toPoolLead = (r: PoolLeadRow): PoolLead => ({
  leadId: r.lead_id,
  customerId: r.customer_id,
  ageHours: r.age_hours,
  pastValidity: r.past_validity,
  ownedByEmployeeId: r.owner_employee_id,
});
