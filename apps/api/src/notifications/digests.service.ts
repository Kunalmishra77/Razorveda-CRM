import { Injectable, Inject } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { resolveTransport, type NotificationTransport } from './transport.js';

/**
 * Scheduled digests and alerts (Phase 4 deliverables 3 and 4).
 *
 * docs/04 Delivery:
 *   07:30  rep morning plan          each rep
 *   08:00  admin exception digest    admins
 *   21:00  management one-pager      owner
 *   Mon 09:00 weekly pack            admins
 *   1st of month  close pack         admins
 *
 * Plus the alerts in deliverable 4, of which the sharpest is "a rep with assigned
 * leads and zero dials by 14:00" — the one that catches a bad day while it can
 * still be fixed rather than reporting it at 21:00 when it cannot.
 *
 * IDEMPOTENCY IS ENFORCED BY THE DATABASE, NOT BY THIS CODE.
 *
 * `ux_outbox_slot` is unique on (kind, slot_key, recipient). A second run for the
 * same slot hits the constraint and is skipped. A scheduler that retries after a
 * crash therefore cannot send a rep two morning plans, and the guarantee does not
 * depend on anyone remembering to check first.
 *
 * `asOf` is a parameter rather than a clock read, so a missed 07:30 can be run
 * for the slot it missed — and so the whole thing is testable without waiting
 * until half past seven.
 */

export interface DigestRunResult {
  readonly asOf: string;
  readonly channel: string;
  readonly composed: number;
  readonly sent: number;
  readonly skippedAlreadySent: number;
  readonly failed: number;
  readonly items: readonly {
    kind: string;
    recipient: string;
    slotKey: string;
    status: string;
    reason?: string;
  }[];
}

interface Draft {
  readonly kind: string;
  readonly slotKey: string;
  readonly recipientId: string | null;
  readonly recipientAddress: string;
  readonly subject: string;
  readonly body: string;
}

@Injectable()
export class DigestsService {
  private readonly transport: NotificationTransport = resolveTransport();

  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /**
   * Composes and delivers everything due at `asOf`.
   *
   * `kinds` narrows the run — a scheduler firing at 07:30 asks only for the rep
   * plan rather than composing five digests and discarding four.
   */
  async run(session: RlsSession, asOf: Date, kinds?: readonly string[]): Promise<DigestRunResult> {
    return withRlsContext(this.pool, session, async (client) => {
      const wanted = (kind: string): boolean => !kinds || kinds.includes(kind);
      const drafts: Draft[] = [];

      if (wanted('rep_morning_plan')) drafts.push(...(await this.repMorningPlans(client, asOf)));
      if (wanted('admin_exception_digest')) drafts.push(...(await this.exceptionDigest(client, asOf)));
      if (wanted('management_one_pager')) drafts.push(...(await this.managementOnePager(client, asOf)));
      if (wanted('zero_dials_alert')) drafts.push(...(await this.zeroDialsAlert(client, asOf)));

      const items: Array<DigestRunResult['items'][number]> = [];
      let sent = 0;
      let skipped = 0;
      let failed = 0;

      for (const draft of drafts) {
        // INSERT first. If the slot is taken the database refuses and we never
        // touch the transport, which is what makes a retry safe.
        const { rows: [row] } = await client.query<{ notification_id: string }>(
          `INSERT INTO notification_outbox
             (kind, slot_key, recipient_id, channel, subject, body, status)
           VALUES ($1,$2,$3,$4::notification_channel,$5,$6,'PENDING')
           ON CONFLICT DO NOTHING
        RETURNING notification_id`,
          [draft.kind, draft.slotKey, draft.recipientId, this.transport.channel, draft.subject, draft.body],
        );

        if (!row) {
          skipped += 1;
          items.push({ kind: draft.kind, recipient: draft.recipientAddress, slotKey: draft.slotKey, status: 'ALREADY_SENT' });
          continue;
        }

        const result = await this.transport.send({
          to: draft.recipientAddress,
          subject: draft.subject,
          body: draft.body,
        });

        await client.query(
          `UPDATE notification_outbox
              SET status = $2::notification_status, failure_reason = $3,
                  sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE NULL END
            WHERE notification_id = $1`,
          [row.notification_id, result.ok ? 'SENT' : 'FAILED', result.reason ?? null],
        );

        if (result.ok) sent += 1;
        else failed += 1;
        items.push({
          kind: draft.kind,
          recipient: draft.recipientAddress,
          slotKey: draft.slotKey,
          status: result.ok ? 'SENT' : 'FAILED',
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }

      return {
        asOf: asOf.toISOString(),
        channel: this.transport.channel,
        composed: drafts.length,
        sent,
        skippedAlreadySent: skipped,
        failed,
        items,
      };
    });
  }

  /**
   * 07:30 — one per rep. "Gap to target · overdue follow-ups · repeat-due
   * customers · fresh leads · yesterday's realised value" (docs/04).
   *
   * Written as something a person reads before their first call, not as a data
   * dump. The order is the order she should work in.
   */
  private async repMorningPlans(client: PoolClient, asOf: Date): Promise<Draft[]> {
    const day = iso(asOf);
    const { rows } = await client.query<{
      user_id: string; email: string; full_name: string; monthly_target: string;
      realised_mtd: string; fresh_leads: string; overdue: string; repeat_due: string;
      realised_yesterday: string;
    }>(
      `SELECT u.user_id, u.email, e.full_name, coalesce(e.monthly_target, 0)::text AS monthly_target,
              coalesce((SELECT sum(k.realised_value) FROM v_daily_employee_kpi k
                         WHERE k.employee_id = e.employee_id
                           AND k.kpi_date >= date_trunc('month', $1::date)::date
                           AND k.kpi_date <= $1::date), 0)::text AS realised_mtd,
              coalesce((SELECT sum(k.realised_value) FROM v_daily_employee_kpi k
                         WHERE k.employee_id = e.employee_id
                           AND k.kpi_date = $1::date - 1), 0)::text AS realised_yesterday,
              (SELECT count(*) FROM lead l
                WHERE l.assigned_to = e.employee_id AND NOT l.is_converted
                  AND l.closed_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.lead_id = l.lead_id))::text
                AS fresh_leads,
              (SELECT count(*) FROM lead l
                WHERE l.assigned_to = e.employee_id AND NOT l.is_converted
                  AND l.closed_at IS NULL
                  AND l.next_followup_at IS NOT NULL
                  AND l.next_followup_at < $1::date)::text AS overdue,
              (SELECT count(*) FROM v_repeat_due_queue q
                WHERE q.owner_employee_id = e.employee_id
                  AND q.next_due_date <= $1::date + 7)::text AS repeat_due
         FROM employee e
         JOIN app_user u ON u.user_id = e.user_id
        WHERE e.status = 'ACTIVE' AND u.role = 'EMPLOYEE'
        ORDER BY e.emp_code`,
      [day],
    );

    return rows.map((r) => {
      const gap = Number(r.monthly_target) - Number(r.realised_mtd);
      const lines = [
        `Good morning ${r.full_name}.`,
        '',
        `Yesterday you delivered ₹${fmt(r.realised_yesterday)}.`,
        `This month: ₹${fmt(r.realised_mtd)} of ₹${fmt(r.monthly_target)}` +
          (gap > 0 ? ` — ₹${fmt(String(gap))} to go.` : ' — target met.'),
        '',
        'Today, in this order:',
        `  ${r.overdue} follow-up(s) already overdue`,
        `  ${r.repeat_due} customer(s) due to reorder within a week`,
        `  ${r.fresh_leads} lead(s) you have not called at all`,
        '',
        // Named because it is the one thing that costs her leads silently.
        'A lead with no contact 72 hours after assignment returns to the pool.',
      ];
      return {
        kind: 'rep_morning_plan',
        slotKey: day,
        recipientId: r.user_id,
        recipientAddress: r.email,
        subject: `Your plan for ${day}`,
        body: lines.join('\n'),
      };
    });
  }

  /** 08:00 — admin exception digest. What needs a human today. */
  private async exceptionDigest(client: PoolClient, asOf: Date): Promise<Draft[]> {
    const day = iso(asOf);
    const { rows: [counts] } = await client.query<{
      untouched: string; unassigned: string; exceptions: string; unconfirmed_prices: string;
      stuck: string;
    }>(
      `SELECT (SELECT count(*) FROM lead l
                WHERE l.assigned_to IS NOT NULL AND l.assigned_at < now() - interval '48 hours'
                  AND NOT l.is_converted AND l.closed_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM activity a
                                   WHERE a.lead_id = l.lead_id AND a.occurred_at >= l.assigned_at))::text
                AS untouched,
              (SELECT count(*) FROM lead
                WHERE assigned_to IS NULL AND NOT is_converted AND closed_at IS NULL)::text
                AS unassigned,
              (SELECT count(*) FROM staging_row s JOIN ingestion_batch b ON b.batch_id = s.batch_id
                WHERE b.status = 'REVIEW' AND s.validation_status <> 'VALID')::text AS exceptions,
              (SELECT count(*) FROM sku WHERE is_active AND NOT shopify_base_price_confirmed)::text
                AS unconfirmed_prices,
              (SELECT count(*) FROM "order" o
                WHERE o.current_status NOT IN ('DELIVERED','RTO','RETURNED','CANCELLED')
                  AND o.updated_at < now() - interval '7 days')::text AS stuck`,
    );

    const body = [
      `Exceptions for ${day}.`,
      '',
      `  ${counts?.untouched ?? 0} assigned lead(s) untouched for over 48 hours (they return to the pool at 72)`,
      `  ${counts?.unassigned ?? 0} lead(s) sitting unassigned in the pool`,
      `  ${counts?.exceptions ?? 0} staged row(s) awaiting review in an open batch`,
      `  ${counts?.unconfirmed_prices ?? 0} active SKU(s) with no confirmed Shopify base price`,
      `  ${counts?.stuck ?? 0} order(s) with no movement for over 7 days`,
      '',
      // The one that quietly costs reps money, so it is spelled out.
      'A SKU with no confirmed base price cannot have its credit calculated. Orders on it book normally, but the rep earns nothing until the price is confirmed in Master Data.',
    ].join('\n');

    return this.toAdmins(client, {
      kind: 'admin_exception_digest',
      slotKey: day,
      subject: `Exceptions — ${day}`,
      body,
    });
  }

  /** 21:00 — the owner's one-pager. */
  private async managementOnePager(client: PoolClient, asOf: Date): Promise<Draft[]> {
    const day = iso(asOf);
    const { rows: [t] } = await client.query<{
      realised: string; orders: string; rto_pct: string; top_rep: string | null;
    }>(
      `SELECT coalesce(sum(k.realised_value), 0)::text  AS realised,
              coalesce(sum(k.orders_delivered), 0)::text AS orders,
              CASE WHEN sum(k.orders_delivered) + sum(k.rto_count) > 0
                   THEN round(sum(k.rto_count)::numeric
                              / (sum(k.orders_delivered) + sum(k.rto_count)), 4)::text
                   ELSE '—' END                          AS rto_pct,
              (SELECT e.full_name FROM v_daily_employee_kpi k2
                 JOIN employee e ON e.employee_id = k2.employee_id
                WHERE k2.kpi_date = $1::date
                GROUP BY e.full_name ORDER BY sum(k2.realised_value) DESC NULLS LAST LIMIT 1)
                                                         AS top_rep
         FROM v_daily_employee_kpi k
        WHERE k.kpi_date = $1::date`,
      [day],
    );

    const body = [
      `${day}`,
      '',
      `  Realised      ₹${fmt(t?.realised ?? '0')}`,
      `  Delivered     ${t?.orders ?? 0} order(s)`,
      `  RTO           ${t?.rto_pct ?? '—'}`,
      `  Top rep       ${t?.top_rep ?? '—'}`,
    ].join('\n');

    return this.toRole(client, 'OWNER', {
      kind: 'management_one_pager',
      slotKey: day,
      subject: `Razorveda — ${day}`,
      body,
    });
  }

  /**
   * Deliverable 4: a rep with assigned leads and zero dials by 14:00.
   *
   * The sharpest alert in the set, because it is the only one that arrives while
   * the day can still be saved. The 21:00 report tells an admin what happened;
   * this tells them what is happening.
   */
  private async zeroDialsAlert(client: PoolClient, asOf: Date): Promise<Draft[]> {
    const day = iso(asOf);
    if (asOf.getHours() < 14) return [];

    const { rows } = await client.query<{ full_name: string; leads: string }>(
      `SELECT e.full_name, count(*)::text AS leads
         FROM lead l JOIN employee e ON e.employee_id = l.assigned_to
        WHERE l.assigned_to IS NOT NULL AND NOT l.is_converted AND l.closed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM activity a
             WHERE a.employee_id = e.employee_id
               AND a.type = 'CALL' AND a.occurred_at::date = $1::date)
        GROUP BY e.full_name ORDER BY count(*) DESC`,
      [day],
    );
    if (rows.length === 0) return [];

    const body = [
      `It is past 14:00 on ${day} and these reps have assigned leads but no calls recorded today:`,
      '',
      ...rows.map((r) => `  ${r.full_name} — ${r.leads} open lead(s)`),
      '',
      'Dials are self-reported, so this means nothing has been LOGGED. She may have been calling without recording it, which is its own problem.',
    ].join('\n');

    return this.toAdmins(client, {
      kind: 'zero_dials_alert',
      slotKey: day,
      subject: `No calls logged by 14:00 — ${day}`,
      body,
    });
  }

  /**
   * What was sent, and when — the evidence exit criterion 5 asks for.
   *
   * Grouped by kind and day so "five consecutive days of scheduled sends" is a
   * thing you can read, rather than a claim someone has to take on trust.
   */
  async history(session: RlsSession, from?: string, to?: string) {
    return withRlsContext(this.pool, session, async (client) => {
      const { rows } = await client.query(
        `SELECT kind, slot_key,
                count(*)::int                                    AS recipients,
                count(*) FILTER (WHERE status = 'SENT')::int     AS sent,
                count(*) FILTER (WHERE status = 'FAILED')::int   AS failed,
                min(channel::text)                               AS channel,
                max(sent_at)                                     AS last_sent_at
           FROM notification_outbox
          WHERE ($1::text IS NULL OR slot_key >= $1)
            AND ($2::text IS NULL OR slot_key <= $2)
          GROUP BY kind, slot_key
          ORDER BY slot_key DESC, kind`,
        [from ?? null, to ?? null],
      );

      // Named explicitly rather than left for a reader to work out from the
      // channel column: a run against FILE reached a directory, not a person.
      const onlyFile = rows.length > 0 && rows.every((r) => r.channel === 'FILE');
      return {
        rows,
        ...(onlyFile
          ? {
              warning:
                'Every delivery in this range used the FILE transport. The messages were written to disk and reached nobody. Criterion 5 is not satisfied by these.',
            }
          : {}),
      };
    });
  }

  private async toAdmins(
    client: PoolClient,
    d: { kind: string; slotKey: string; subject: string; body: string },
  ): Promise<Draft[]> {
    return this.toRole(client, 'ADMIN', d);
  }

  private async toRole(
    client: PoolClient,
    role: 'ADMIN' | 'OWNER',
    d: { kind: string; slotKey: string; subject: string; body: string },
  ): Promise<Draft[]> {
    const { rows } = await client.query<{ user_id: string; email: string }>(
      `SELECT user_id, email FROM app_user WHERE role = $1::user_role AND NOT is_locked ORDER BY email`,
      [role],
    );
    return rows.map((r) => ({
      ...d,
      recipientId: r.user_id,
      recipientAddress: r.email,
    }));
  }
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Indian digit grouping, because every figure in this business is read in lakhs. */
const fmt = (value: string): string =>
  Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
