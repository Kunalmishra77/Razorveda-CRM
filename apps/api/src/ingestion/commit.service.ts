import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * Commit and rollback (docs/06 stage 7).
 *
 * Two rules the rest of the file exists to serve:
 *
 *   1. ONE TRANSACTION. Staging becomes live, or nothing happens. A half-committed
 *      batch is worse than a failed one, because nobody knows which half.
 *
 *   2. LEADS LAND UNASSIGNED. Nothing here assigns anything (D-02). The pool is
 *      the absence of an assignment, so this simply leaves `assigned_to` null.
 */

export const ROLLBACK_WINDOW_DAYS = 7;

export interface CommitResult {
  readonly batchId: string;
  readonly customersCreated: number;
  /** Rows the resolver matched to a customer that already existed. */
  readonly customersMatched: number;
  /** Rows held back for an admin: an uncertain merge, or no usable key at all. */
  readonly rowsHeldForReview: number;
  readonly leadsCreated: number;
  readonly ordersCreated: number;
  readonly rowsSkipped: number;
}

export interface RollbackResult {
  readonly batchId: string;
  readonly leadsRemoved: number;
  readonly leadsClosed: number;
  readonly ordersCancelled: number;
  readonly ledgerReversals: number;
  /**
   * Customers this batch created that rollback deliberately KEEPS.
   *
   * Rollback neutralises, it does not delete: `order_status_event` and
   * `attribution_ledger` are append-only (CLAUDE.md rule 2), so undoing a batch
   * means writing compensating rows, not removing history. Customers go further —
   * one created by an import may since have been called, sold to, or merged, and
   * destroying that is worse than leaving a row with no live lead or order.
   *
   * So the number is reported rather than hidden. Before `customer.ingestion_batch_id`
   * these rows were not merely unremovable, they were unidentifiable, and the admin
   * was told a batch had been rolled back with no way to see what remained.
   */
  readonly customersKept: number;
}

export class CommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitError';
  }
}

export class CommitService {
  constructor(private readonly pool: Pool) {}

  async commit(session: RlsSession, batchId: string): Promise<CommitResult> {
    if (session.role !== 'ADMIN' && session.role !== 'OWNER') {
      throw new CommitError('Only an admin can commit a batch.');
    }

    return withRlsContext(this.pool, session, async (client) => {
      const batch = await this.loadBatch(client, batchId);

      if (batch.status === 'COMMITTED') {
        throw new CommitError(
          `Batch ${batchId.slice(0, 8)} was already committed. Roll it back first if you need to redo it.`,
        );
      }
      if (batch.status === 'ROLLED_BACK') {
        // Committing again would recreate every lead the rollback just closed,
        // and the customer aggregates would count the same orders twice. Upload
        // the file again instead — the duplicate index excludes rolled-back
        // batches precisely so that works.
        throw new CommitError(
          `Batch ${batchId.slice(0, 8)} was rolled back and cannot be committed again. ` +
            `Upload the file again if you need this data back.`,
        );
      }
      if (batch.status === 'SHIFTED') {
        throw new CommitError(
          `Batch ${batchId.slice(0, 8)} was rejected as column-shifted, so it cannot be committed. ` +
            `Fix the file and upload it again.`,
        );
      }

      // Only rows an admin has cleared. PARKED and unresolved ERROR rows stay in
      // staging: they are kept, not discarded (F2), and remain reviewable.
      const { rows: staged } = await client.query<StagedRow>(
        `SELECT staging_id, normalised_json, resolved_customer_id, resolved_action, validation_status
           FROM staging_row
          WHERE batch_id = $1 AND validation_status IN ('VALID','WARNING','DUPLICATE')
            -- A row the resolver could not settle is NOT committable. MERGE_CANDIDATE
            -- (0.80-0.95) is a judgement only an admin can make, and PARK has no
            -- usable key at all. Both are kept and stay reviewable (F2); committing
            -- them would either invent a duplicate customer or guess at a merge.
            AND resolved_action NOT IN ('MERGE_CANDIDATE','PARK')
          ORDER BY row_number`,
        [batchId],
      );

      let customersCreated = 0;
      let customersMatched = 0;

      // Held back above by the resolved_action filter. Reported so the admin is
      // told the number rather than discovering it by comparing counts.
      const { rows: [held] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM staging_row
          WHERE batch_id = $1 AND resolved_action IN ('MERGE_CANDIDATE','PARK')`,
        [batchId],
      );
      const rowsHeldForReview = Number(held?.n ?? '0');
      let leadsCreated = 0;
      let ordersCreated = 0;

      for (const row of staged) {
        const data = row.normalised_json ?? {};
        const phone = typeof data['phone'] === 'string' ? data['phone'] : null;

        const customerId = await this.upsertCustomer(client, row, data, phone, batchId);
        // Counted from what the RESOLVER decided, not from the row count. This
        // used to test for 'CREATE', a value nothing ever wrote, so every row
        // fell to the else branch... and before that the action was the literal
        // 'CREATE' for every row, so the admin was told a ten-row file created
        // ten customers when it had created three.
        if (row.resolved_action === 'UPDATE_EXISTING') customersMatched += 1;
        else customersCreated += 1;

        // Leads land UNASSIGNED. assigned_to and assigned_at stay null — the
        // absence of an assignment IS the pool (docs/02), and D-02 forbids any
        // automatic movement.
        const { rows: leadRows } = await client.query<{ lead_id: string }>(
          `INSERT INTO lead (customer_id, source_id, ingestion_batch_id, received_at,
                             valid_till, product_interest)
           SELECT $1, b.source_id, b.batch_id, now(),
                  (now() + make_interval(days => s.validity_days))::date, $3
             FROM ingestion_batch b JOIN lead_source s ON s.source_id = b.source_id
            WHERE b.batch_id = $2
        RETURNING lead_id`,
          [customerId, batchId, typeof data['productText'] === 'string' ? data['productText'] : null],
        );
        if (leadRows[0]) leadsCreated += 1;

        if (data['amount'] != null && String(data['amount']).trim() !== '') {
          const created = await this.createOrder(client, batchId, customerId, leadRows[0]?.lead_id ?? null, data);
          if (created) ordersCreated += 1;
        }

        await client.query(
          `UPDATE staging_row SET committed_entity_id = $2 WHERE staging_id = $1`,
          [row.staging_id, customerId],
        );
      }

      await this.recalculateCustomerAggregates(client, batchId);

      await client.query(
        `UPDATE ingestion_batch
            SET status = 'COMMITTED', committed_at = now(), rows_committed = $2
          WHERE batch_id = $1`,
        [batchId, staged.length],
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
         VALUES ($1,$2::user_role,'BATCH_COMMITTED','ingestion_batch',$3,$4::jsonb)`,
        [
          session.userId, session.role, batchId,
          JSON.stringify({ customersCreated, customersMatched, rowsHeldForReview, leadsCreated, ordersCreated }),
        ],
      );

      return {
        batchId,
        customersCreated,
        customersMatched,
        rowsHeldForReview,
        leadsCreated,
        ordersCreated,
        rowsSkipped: batch.row_count - staged.length,
      };
    });
  }

  /**
   * ROLLBACK BATCH — compensating, never destructive.
   *
   * The schema settles this rather than taste: `order_status_event` has no
   * ON DELETE CASCADE and its DELETE is trigger-blocked, so an order that has
   * any history PHYSICALLY CANNOT be deleted. Which is right — CLAUDE.md rule 2
   * says corrections are new rows, and a rollback is a correction.
   *
   * So: orders are CANCELLED with a new status event, credit is reversed with a
   * ledger ADJUSTMENT, and derived customer state is recomputed from what
   * remains. A March report stays reproducible in December, including the fact
   * that a batch was loaded and undone.
   *
   * Leads are CLOSED, not deleted — including untouched ones. A closed lead is
   * excluded from both the pool query and the worklist, so the pool returns to its
   * pre-batch state without app_role ever needing a DELETE privilege.
   */
  async rollback(session: RlsSession, batchId: string, reason: string): Promise<RollbackResult> {
    if (session.role !== 'ADMIN' && session.role !== 'OWNER') {
      throw new CommitError('Only an admin can roll back a batch.');
    }
    if (!reason.trim()) {
      throw new CommitError('Give a reason for the rollback — it goes on the audit trail.');
    }

    return withRlsContext(this.pool, session, async (client) => {
      const batch = await this.loadBatch(client, batchId);

      if (batch.status !== 'COMMITTED') {
        throw new CommitError(
          `Batch ${batchId.slice(0, 8)} is ${batch.status}, not COMMITTED, so there is nothing to roll back.`,
        );
      }

      const { rows: age } = await client.query<{ days: string }>(
        `SELECT extract(day from now() - committed_at)::text AS days
           FROM ingestion_batch WHERE batch_id = $1`,
        [batchId],
      );
      const days = Number(age[0]?.days ?? '0');
      if (days > ROLLBACK_WINDOW_DAYS) {
        throw new CommitError(
          `Batch ${batchId.slice(0, 8)} was committed ${days} days ago and the ${ROLLBACK_WINDOW_DAYS}-day ` +
            `rollback window has passed. Correct the affected records individually instead.`,
        );
      }

      // Orders first: CANCELLED is a legal transition from every pre-dispatch
      // state, and the state machine refuses it once a parcel has shipped — which
      // is correct. A dispatched order cannot be un-sent by an admin clicking undo.
      const { rows: cancellable } = await client.query<{ order_id: string; current_status: string }>(
        `SELECT order_id, current_status FROM "order"
          WHERE ingestion_batch_id = $1
            AND current_status IN ('PENDING','CONFIRMED','PROCESSING')`,
        [batchId],
      );

      for (const order of cancellable) {
        await client.query(
          `INSERT INTO order_status_event (order_id, from_status, to_status, source, ingestion_batch_id)
           VALUES ($1, $2::order_status, 'CANCELLED', 'ROLLBACK', $3)`,
          [order.order_id, order.current_status, batchId],
        );
        await client.query(
          `UPDATE "order" SET current_status = 'CANCELLED', updated_at = now() WHERE order_id = $1`,
          [order.order_id],
        );
      }

      const { rows: blocked } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "order"
          WHERE ingestion_batch_id = $1
            AND current_status NOT IN ('PENDING','CONFIRMED','PROCESSING','CANCELLED')`,
        [batchId],
      );
      if (Number(blocked[0]?.n ?? '0') > 0) {
        throw new CommitError(
          `${blocked[0]?.n} order(s) from this batch have already been dispatched or delivered, ` +
            `so the batch cannot be rolled back. A shipped parcel is not undone by an import. ` +
            `Correct those orders individually.`,
        );
      }

      // Reverse credit with a new ledger row. Never an UPDATE, never a DELETE.
      const { rows: reversals } = await client.query<{ entry_id: string }>(
        `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                         employee_credited_value, rule_applied, period_key, note)
         SELECT l.order_id, l.employee_id, 'ADJUSTMENT', -l.company_base_value,
                -l.employee_credited_value, 'BATCH_ROLLBACK', l.period_key, $2
           FROM attribution_ledger l
           JOIN "order" o ON o.order_id = l.order_id
          WHERE o.ingestion_batch_id = $1 AND l.entry_type <> 'ADJUSTMENT'
      RETURNING entry_id`,
        [batchId, `Rollback of batch ${batchId.slice(0, 8)}: ${reason}`],
      );

      // NOTHING IS DELETED — leads are closed, exactly like orders are cancelled.
      //
      // The first version deleted untouched leads on the grounds that they carry
      // no history and removing them is lossless. Running it produced
      // "permission denied for table lead": `rls-policies.sql` revokes DELETE on
      // ALL tables from app_role.
      //
      // That revoke is broader than its append-only justification, and the fix is
      // NOT to widen it. Closing achieves everything deleting would: a closed lead
      // is excluded from the pool query and from the worklist, so the pool returns
      // to its pre-batch state either way. Deleting would have bought tidier rows
      // at the cost of granting app_role a destructive privilege it has never
      // needed — and "the rollback needed it" is exactly how such a grant creeps in.
      const removed: readonly unknown[] = [];

      const { rows: closed } = await client.query<{ lead_id: string }>(
        `UPDATE lead SET closed_at = now(), close_reason = $2, next_followup_at = NULL,
                         updated_at = now()
           WHERE ingestion_batch_id = $1 AND closed_at IS NULL
       RETURNING lead_id`,
        [batchId, `Batch rolled back: ${reason}`],
      );

      await this.recalculateCustomerAggregates(client, batchId);

      await client.query(
        `UPDATE ingestion_batch SET status = 'ROLLED_BACK', rolled_back_at = now()
          WHERE batch_id = $1`,
        [batchId],
      );

      const { rows: [kept] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM customer WHERE ingestion_batch_id = $1`,
        [batchId],
      );
      const customersKept = Number(kept?.n ?? '0');

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
         VALUES ($1,$2::user_role,'BATCH_ROLLED_BACK','ingestion_batch',$3,$4::jsonb)`,
        [
          session.userId, session.role, batchId,
          JSON.stringify({
            reason,
            leadsRemoved: removed.length,
            leadsClosed: closed.length,
            ordersCancelled: cancellable.length,
            ledgerReversals: reversals.length,
            customersKept,
          }),
        ],
      );

      return {
        batchId,
        leadsRemoved: removed.length,
        leadsClosed: closed.length,
        ordersCancelled: cancellable.length,
        ledgerReversals: reversals.length,
        customersKept,
      };
    });
  }

  /**
   * Derived customer state is RECOMPUTED from the order table, never adjusted by
   * a delta.
   *
   * A delta is only correct if every previous delta was correct, and it drifts
   * silently the first time one is missed. Recomputation is idempotent, so commit
   * and rollback can share it and running it twice changes nothing.
   */
  private async recalculateCustomerAggregates(client: PoolClient, batchId: string): Promise<void> {
    await client.query(
      `WITH touched AS (
         SELECT DISTINCT c.customer_id
           FROM customer c
           JOIN lead l ON l.customer_id = c.customer_id
          WHERE l.ingestion_batch_id = $1
       ), totals AS (
         SELECT t.customer_id,
                count(*) FILTER (WHERE o.current_status = 'DELIVERED')            AS delivered,
                coalesce(sum(o.final_value) FILTER (WHERE o.current_status = 'DELIVERED'), 0) AS value,
                min(o.order_date) FILTER (WHERE o.current_status = 'DELIVERED')   AS first_order,
                max(o.order_date) FILTER (WHERE o.current_status = 'DELIVERED')   AS last_order,
                count(*) FILTER (WHERE o.current_status IN ('RTO','RETURNED'))    AS rtos
           FROM touched t
           LEFT JOIN "order" o ON o.customer_id = t.customer_id
          GROUP BY t.customer_id
       )
       UPDATE customer c
          SET lifetime_orders = totals.delivered,
              lifetime_value  = totals.value,
              first_order_date = totals.first_order,
              last_order_date  = totals.last_order,
              rto_count        = totals.rtos,
              -- Derived, never uploaded (docs/02). A customer with a delivered
              -- order is EXISTING whatever the file claimed.
              customer_type = CASE WHEN totals.delivered > 0 THEN 'EXISTING' ELSE 'NEW' END::customer_type,
              stage = CASE
                        WHEN totals.delivered = 0 THEN 'PROSPECT'
                        WHEN totals.delivered = 1 THEN 'FIRST'
                        WHEN totals.delivered = 2 THEN 'SECOND'
                        WHEN totals.delivered = 3 THEN 'THIRD'
                        ELSE 'REPEAT'
                      END::buyer_stage,
              updated_at = now()
         FROM totals
        WHERE c.customer_id = totals.customer_id`,
      [batchId],
    );
  }

  private async loadBatch(client: PoolClient, batchId: string): Promise<BatchRow> {
    const { rows } = await client.query<BatchRow>(
      `SELECT batch_id, source_id, status, row_count FROM ingestion_batch WHERE batch_id = $1`,
      [batchId],
    );
    const batch = rows[0];
    if (!batch) throw new CommitError(`No batch ${batchId}.`);
    return batch;
  }

  private async upsertCustomer(
    client: PoolClient,
    row: StagedRow,
    data: Record<string, unknown>,
    phone: string | null,
    batchId: string,
  ): Promise<string> {
    if (row.resolved_customer_id) return row.resolved_customer_id;

    const { rows } = await client.query<{ customer_id: string }>(
      `INSERT INTO customer (primary_phone, full_name, city, state, pincode, ingestion_batch_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (primary_phone) DO UPDATE SET full_name = coalesce(EXCLUDED.full_name, customer.full_name),
                                                 updated_at = now()
    RETURNING customer_id, (xmax = 0) AS inserted`,
      [
        phone,
        typeof data['name'] === 'string' ? data['name'] : null,
        typeof data['city'] === 'string' ? data['city'] : null,
        typeof data['state'] === 'string' ? data['state'] : null,
        typeof data['pincode'] === 'string' ? data['pincode'] : null,
        batchId,
      ],
    );
    const created = rows[0];
    if (!created) throw new CommitError('Failed to create a customer row.');

    if (phone) {
      await client.query(
        `INSERT INTO customer_identifier (customer_id, type, value, is_primary)
         VALUES ($1,'MOBILE',$2,true) ON CONFLICT DO NOTHING`,
        [created.customer_id, phone],
      );
    }
    return created.customer_id;
  }

  private async createOrder(
    client: PoolClient,
    batchId: string,
    customerId: string,
    leadId: string | null,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const amount = String(data['amount'] ?? '').trim();
    if (amount === '') return false;

    const externalRef =
      typeof data['externalRef'] === 'string' && data['externalRef'].trim() !== ''
        ? data['externalRef'].trim()
        : null;

    // The fallback used to be `RV-<batch>-<customer>`, which is not unique per
    // ORDER — it is unique per customer per batch. A repeat customer with two
    // orders in one file produced the same order_number twice, the second hit
    // ON CONFLICT DO NOTHING, and the row was dropped with no error and no
    // exception shown to the admin. Repeat buyers are a core concept here
    // (Buyer Fq, DELIVERED_REPEAT), so this lost exactly the rows that matter
    // most. The natural key from docs/06 §Idempotency is (phone, order_date,
    // final_value) — using it means a genuine re-upload of the same order still
    // collapses, while two DIFFERENT orders no longer collide.
    const naturalKey = createHash('sha256')
      .update(`${customerId}|${String(data['date'] ?? '')}|${amount}`)
      .digest('hex')
      .slice(0, 12);
    const orderNumber = externalRef ?? `RV-${batchId.slice(0, 8)}-${naturalKey}`;

    const { rows } = await client.query<{ order_id: string }>(
      `INSERT INTO "order" (order_number, customer_id, lead_id, source_id, order_date,
                            final_value, prepaid_amount, cod_amount, payment_mode,
                            ship_state, ship_pincode, ingestion_batch_id,
                            legacy_credit_value, current_status)
       SELECT $1,$2,$3, b.source_id, coalesce($4::date, CURRENT_DATE), $5, $6, $7,
              coalesce($8,'UNKNOWN')::payment_mode, $9, $10, $11, $12, 'PENDING'
         FROM ingestion_batch b WHERE b.batch_id = $11
       ON CONFLICT (order_number) DO NOTHING
    RETURNING order_id`,
      [
        orderNumber, customerId, leadId,
        typeof data['date'] === 'string' ? data['date'] : null,
        amount,
        String(data['prepaidAmount'] ?? '0'),
        String(data['codAmount'] ?? '0'),
        typeof data['paymentMode'] === 'string' ? data['paymentMode'] : null,
        typeof data['state'] === 'string' ? data['state'] : null,
        typeof data['pincode'] === 'string' ? data['pincode'] : null,
        batchId,
        // Reconciliation only. docs/06 §4: never used in a metric, a score or an
        // incentive — it exists so the backfill can show where the client's
        // manually typed credit disagreed with the computed one.
        typeof data['legacyCreditValue'] === 'string' && data['legacyCreditValue'].trim() !== ''
          ? data['legacyCreditValue']
          : null,
      ],
    );

    const order = rows[0];
    if (!order) return false;

    await client.query(
      `INSERT INTO order_status_event (order_id, from_status, to_status, source, ingestion_batch_id)
       VALUES ($1, NULL, 'PENDING', 'INGESTION', $2)`,
      [order.order_id, batchId],
    );
    return true;
  }
}

interface BatchRow {
  readonly batch_id: string;
  readonly source_id: string;
  readonly status: string;
  readonly row_count: number;
}

interface StagedRow {
  readonly staging_id: string;
  readonly normalised_json: Record<string, unknown> | null;
  readonly resolved_customer_id: string | null;
  readonly resolved_action: string | null;
  readonly validation_status: string;
}
