import { Controller, Get, Inject, NotFoundException, Param, Query, Req } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext } from '../db/rls-context.js';
import type { AuthedRequest } from '../auth/session.guard.js';
import { ActivityService } from '../activity/activity.service.js';

/**
 * Customer 360 (docs/07 §3) — everything known about one person, in one place.
 *
 * NOT admin-guarded, deliberately. This is the screen a rep opens before she
 * dials: what has this customer bought, what went wrong last time, when is she
 * due to reorder. Locking it to admins would leave the rep calling blind, which
 * is the situation the nine spreadsheets created.
 *
 * RLS is what makes that safe. `customer_isolation` shows a rep only customers
 * she has an assigned lead for or owns outright, so "not admin-guarded" does not
 * mean "open" — it means the database decides, per row, rather than the route
 * deciding for everyone.
 *
 * OPENING THIS PAGE IS A PII EVENT.
 *
 * docs/05: "pii_access_log writes on every number view and copy." The profile
 * shows a full phone number, so fetching it IS a view, and it is logged as one.
 * Views never count toward the copy-velocity lock (D-191) — a rep reading her own
 * customers all morning is working, not harvesting — but the record exists, which
 * is the whole attribution model given that prevention is off the table.
 */
@Controller('customers')
export class CustomersController {
  constructor(
    @Inject(pgLib.Pool) private readonly pool: Pool,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /** Search by name or phone. RLS decides what comes back. */
  @Get()
  async search(@Query('q') q: string | undefined, @Req() request: AuthedRequest) {
    const term = (q ?? '').trim();

    /**
     * NO SEARCH TERM MEANS DIFFERENT THINGS TO DIFFERENT PEOPLE.
     *
     * The three-character minimum exists so nobody can pull the entire customer
     * base with an empty box. For an ADMIN that is exactly right — their scope is
     * every customer in the business.
     *
     * For a REP it made the screen lie. Her scope is already tiny and personal:
     * `customer_isolation` gives her only the customers she has a lead for or owns
     * after a delivery. Making her guess a name before she can see her own list
     * meant "My customers" opened on "No customers yet" for someone with twelve.
     *
     * So an empty term lists HER customers, capped, most useful first. An admin
     * with an empty term still gets the message.
     */
    if (term.length < 3) {
      if (request.session!.role !== 'EMPLOYEE') {
        return { ok: true, customers: [], message: 'Type at least three characters.' };
      }
      return withRlsContext(this.pool, request.session!, async (client) => {
        const { rows } = await client.query(
          `SELECT c.customer_id, c.full_name, c.primary_phone, c.city, c.state,
                  c.stage::text, c.lifetime_orders, c.lifetime_value::text, c.next_due_date,
                  c.do_not_call
             FROM customer c
            ORDER BY
              -- Anyone due to reorder first: that is a call she can make today.
              (c.next_due_date IS NOT NULL AND c.next_due_date <= CURRENT_DATE) DESC,
              c.lifetime_value DESC NULLS LAST,
              c.full_name
            LIMIT 50`,
        );
        return { ok: true, customers: rows, message: null };
      });
    }

    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows } = await client.query(
        // EXISTS rather than a JOIN + DISTINCT. The join multiplied a customer by
        // her identifiers, DISTINCT was papering over it, and DISTINCT then made
        // the ORDER BY illegal because `lifetime_value` is selected cast to text.
        // EXISTS removes all three problems and reads as what it means: "any of
        // her numbers matches".
        //
        // Alt numbers are searched too, which is the point — a customer who rings
        // in from her second phone is the same person (rule 4), and a search that
        // only looked at `primary_phone` would say she does not exist.
        `SELECT c.customer_id, c.full_name, c.primary_phone, c.city, c.state,
                c.stage::text, c.lifetime_orders, c.lifetime_value::text, c.next_due_date,
                c.do_not_call
           FROM customer c
          WHERE c.full_name ILIKE '%' || $1 || '%'
             OR c.primary_phone LIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM customer_identifier ci
                         WHERE ci.customer_id = c.customer_id
                           AND ci.value LIKE '%' || $1 || '%')
          ORDER BY c.lifetime_value DESC NULLS LAST
          LIMIT 25`,
        [term],
      );
      return { ok: true, customers: rows };
    });
  }

  @Get(':id')
  async profile(@Param('id') id: string, @Req() request: AuthedRequest) {
    const session = request.session!;

    const profile = await withRlsContext(this.pool, session, async (client) => {
      const { rows: [customer] } = await client.query(
        `SELECT c.customer_id, c.full_name, c.primary_phone, c.city, c.state, c.pincode,
                c.customer_type::text, c.stage::text, c.lifetime_orders,
                c.lifetime_value::text, c.rto_count, c.first_order_date, c.last_order_date,
                c.next_due_date, c.do_not_call, e.full_name AS owner
           FROM customer c
           LEFT JOIN employee e ON e.employee_id = c.owner_employee_id
          WHERE c.customer_id = $1`,
        [id],
      );

      // RLS returned nothing for a customer this caller has no lead on. 404, not
      // 403 — a "forbidden" would confirm the person exists and let a rep
      // enumerate the customer base one id at a time (D-188).
      if (!customer) return null;

      return {
        customer,
        identifiers: await rows(client,
          `SELECT type::text, value, is_primary, verified_at
             FROM customer_identifier WHERE customer_id = $1
            ORDER BY is_primary DESC, type`, [id]),

        // Every order, whatever its outcome. A rep about to call needs last
        // time's RTO in front of her more than she needs this month's revenue.
        orders: await rows(client,
          `SELECT o.order_number, o.order_date, o.current_status::text, o.final_value::text,
                  o.payment_mode::text, o.delivered_date, o.rto_date, o.awb_number,
                  s.code AS source, e.full_name AS rep,
                  string_agg(sk.product_name, ', ' ORDER BY sk.product_name) AS products
             FROM "order" o
             JOIN lead_source s ON s.source_id = o.source_id
             LEFT JOIN employee e ON e.employee_id = o.booked_by_employee_id
             LEFT JOIN order_line ol ON ol.order_id = o.order_id
             LEFT JOIN sku sk ON sk.sku_id = ol.sku_id
            WHERE o.customer_id = $1
            GROUP BY o.order_id, s.code, e.full_name
            ORDER BY o.order_date DESC`, [id]),

        // A customer can arrive many times from many sources (F1: one in eight
        // appeared in more than one tab). Showing every lead is what makes the
        // dedupe visible rather than merely correct.
        leads: await rows(client,
          `SELECT l.received_at, l.valid_till, l.is_converted, l.closed_at,
                  l.contact_attempts, s.code AS source, e.full_name AS assigned_to
             FROM lead l
             JOIN lead_source s ON s.source_id = l.source_id
             LEFT JOIN employee e ON e.employee_id = l.assigned_to
            WHERE l.customer_id = $1
            ORDER BY l.received_at DESC`, [id]),

        activity: await rows(client,
          `SELECT a.occurred_at, a.type::text, a.connected, a.remark_raw,
                  d.label AS disposition, e.full_name AS by_whom
             FROM activity a
             LEFT JOIN disposition d ON d.disposition_id = a.disposition_id
             LEFT JOIN employee e ON e.employee_id = a.employee_id
            WHERE a.customer_id = $1
            ORDER BY a.occurred_at DESC
            LIMIT 100`, [id]),
      };
    });

    if (!profile) throw new NotFoundException('That customer was not found.');

    // Logged AFTER the read succeeded. Logging first would record a view of a
    // customer RLS then refused to show, which turns the access log into a record
    // of attempts rather than of what was actually seen.
    await this.activity
      .logPiiAccess(session, null, 'VIEW', request.ip ?? null, id)
      .catch(() => undefined);

    return { ok: true, ...profile };
  }
}

const rows = async (client: PoolClient, sql: string, params: unknown[]) =>
  (await client.query(sql, params)).rows;
