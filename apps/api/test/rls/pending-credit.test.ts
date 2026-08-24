import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { SYSTEM_ACTOR_EMAIL } from '@razorveda/shared';
import { PendingCreditService } from '../../src/master/pending-credit.service.js';
import { MasterDataService } from '../../src/master/master-data.service.js';
import type { RlsSession } from '../../src/db/rls-context.js';

/**
 * COMPLETING CREDIT IS A MONEY PATH, SO EVERY GUARD ON IT GETS A TEST.
 *
 * D-124 lets a rep book an order when the base price is unconfirmed: the sale is
 * recorded, no ledger row is written, and she is told her credit will follow once
 * an admin confirms the price. Nothing made it follow until now.
 *
 * The dangerous version of this feature is not one that fails - it is one that
 * works slightly too well. Three ways it could:
 *
 *   it credits the 180,000-order historical import, which was never meant to pay
 *   anyone (the ingestion_batch_id guard);
 *
 *   it runs twice and pays twice;
 *
 *   it back-dates a realised entry into a month that has already been reported.
 *
 * Each has a test below. The happy path has one too, but it is the least
 * interesting thing here.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let session: RlsSession;
let service: PendingCreditService;
let master: MasterDataService;

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  service = new PendingCreditService(pool);
  master = new MasterDataService(pool);

  const { rows } = await pool.query<{ user_id: string; role: string }>(
    'SELECT user_id, role FROM auth_lookup($1)',
    [SYSTEM_ACTOR_EMAIL],
  );
  if (!rows[0]) throw new Error(`${SYSTEM_ACTOR_EMAIL} is not seeded — run npm run db:seed`);
  session = { userId: rows[0].user_id, role: rows[0].role as RlsSession['role'] };
});

// Nothing is torn down: attribution_ledger is append-only and refuses DELETE even
// for the owner, which is rule 2 working. See repeat-provisional.test.ts.
afterAll(async () => {
  await pool?.end();
});

interface Fixture {
  orderId: string;
  orderNumber: string;
}

/**
 * An order booked by a real rep against a SHOPIFY-source lead, with one
 * non-upsell line, and NO ledger entry — exactly the D-124 situation.
 */
async function bookedWithoutCredit(opts: {
  priceConfirmed: boolean;
  status?: string;
  viaIngestion?: boolean;
}): Promise<Fixture> {
  const { rows: [rep] } = await pool.query<{ employee_id: string }>(
    `SELECT e.employee_id FROM employee e JOIN app_user u ON u.user_id = e.user_id
      WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE' AND e.emp_code LIKE 'EMP-%'
      ORDER BY e.emp_code LIMIT 1`,
  );
  const { rows: [source] } = await pool.query<{ source_id: string }>(
    `SELECT source_id FROM lead_source WHERE code = 'SHOPIFY'`,
  );
  const { rows: [sku] } = await pool.query<{ sku_id: string }>(
    `SELECT sku_id FROM sku WHERE is_active ORDER BY sku_code LIMIT 1`,
  );
  if (!rep || !source || !sku) throw new Error('seed is incomplete — run db:seed and db:seed:dev');

  // The SKU's confirmation state is what decides whether attribution can run.
  await pool.query(
    `UPDATE sku SET shopify_base_price = 500, shopify_base_price_confirmed = $2 WHERE sku_id = $1`,
    [sku.sku_id, opts.priceConfirmed],
  );

  const { rows: [customer] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (full_name, primary_phone) VALUES ($1,$2) RETURNING customer_id`,
    [`Pending Credit Fixture`, `8${String(Date.now()).slice(-9)}`],
  );

  let batchId: string | null = null;
  if (opts.viaIngestion) {
    const { rows: [batch] } = await pool.query<{ batch_id: string }>(
      `INSERT INTO ingestion_batch (source_id, file_name, file_url, file_hash, uploaded_by, status)
       SELECT $1, 'fixture.csv', 'fixture://pending-credit-test', $2, u.user_id, 'COMMITTED'
         FROM app_user u WHERE u.email = $3 RETURNING batch_id`,
      [source.source_id, `f${String(Date.now())}`.padEnd(64, '0').slice(0, 64), SYSTEM_ACTOR_EMAIL],
    );
    batchId = batch!.batch_id;
  }

  const orderNumber = `PC-${String(Date.now()).slice(-10)}-${Math.floor(Number(String(Date.now()).slice(-4)))}`;
  const { rows: [order] } = await pool.query<{ order_id: string }>(
    `INSERT INTO "order" (order_number, customer_id, source_id, order_date, final_value,
                          booked_by_employee_id, current_status, ingestion_batch_id)
     VALUES ($1,$2,$3,CURRENT_DATE,1000,$4,$5::order_status,$6)
     RETURNING order_id`,
    [orderNumber, customer!.customer_id, source.source_id, rep.employee_id, opts.status ?? 'PENDING', batchId],
  );

  await pool.query(
    `INSERT INTO order_line (order_id, sku_id, quantity, unit_price, line_value, is_upsell)
     VALUES ($1,$2,1,1000,1000,false)`,
    [order!.order_id, sku.sku_id],
  );

  return { orderId: order!.order_id, orderNumber };
}

const ledgerFor = async (orderId: string) =>
  (
    await pool.query<{ entry_type: string; employee_credited_value: string; period_key: string; is_realised: boolean }>(
      `SELECT entry_type, employee_credited_value::text, period_key, is_realised
         FROM attribution_ledger WHERE order_id = $1 ORDER BY created_at`,
      [orderId],
    )
  ).rows;

describe('the guard that matters most', () => {
  it('NEVER credits an order that came from an ingestion batch', async () => {
    // The historical import is 180,000 orders. Crediting it would invent millions
    // of rupees of employee credit for sales no rep in this system ever made, in
    // an append-only table that cannot be cleaned up afterwards.
    const f = await bookedWithoutCredit({ priceConfirmed: true, viaIngestion: true });

    await service.complete(session);

    expect(
      await ledgerFor(f.orderId),
      'An imported order was credited. The backfill exists to reconstruct history, ' +
        'not to pay anyone for it (D-178).',
    ).toEqual([]);

    // And it is not even listed as waiting, so it cannot be completed by hand
    // either. Uncapped on purpose: "not in the first hundred" would satisfy this
    // assertion without the guard existing at all.
    const listed = await service.list(session, 100_000);
    expect(listed.some((o) => o.orderId === f.orderId)).toBe(false);
  });
});

describe('an order booked while the price was unconfirmed', () => {
  it('is listed as waiting, with the reason', async () => {
    const f = await bookedWithoutCredit({ priceConfirmed: false });

    // An explicit large limit, because `list()` now returns a capped PAGE by
    // default — oldest first, so an admin sees the reps who have waited longest.
    // This fixture is booked today and therefore last in that order.
    //
    // The cap is a transport decision and this test is about the RULE, so it asks
    // for everything on purpose rather than quietly passing because the dataset
    // happened to be small. Catching this change is exactly what the test is for.
    const listed = await service.list(session, 100_000);
    const mine = listed.find((o) => o.orderId === f.orderId);

    expect(mine, 'the order is not listed as waiting for credit').toBeTruthy();
    expect(mine!.blockedBy, 'no reason was given for why it is still waiting').toMatch(
      /unconfirmed|not.*confirmed|base price/i,
    );
  });

  it('gets no credit while the price is still unconfirmed', async () => {
    const f = await bookedWithoutCredit({ priceConfirmed: false });
    await service.complete(session);
    expect(
      await ledgerFor(f.orderId),
      'Credit was written from a price nobody has confirmed. Rule 1: never compute money from a guess.',
    ).toEqual([]);
  });

  it('is credited once the price is confirmed', async () => {
    const f = await bookedWithoutCredit({ priceConfirmed: true });

    const result = await service.complete(session);
    expect(result.completed).toBeGreaterThanOrEqual(1);

    const ledger = await ledgerFor(f.orderId);
    expect(ledger, 'the promised credit still did not follow').toHaveLength(1);
    expect(ledger[0]!.entry_type).toBe('BOOKED_CREDIT');

    // 1000 order, 500 committed by the company, so 500 is hers.
    expect(ledger[0]!.employee_credited_value).toBe('500.00');

    // BOOKED, not realised. Credit is earned on DELIVERY (rule 3) and this order
    // is still PENDING - writing a realised entry here would pay for a parcel
    // that has not moved.
    expect(ledger[0]!.is_realised).toBe(false);
  });

  it('writes company_base_value onto the order too, so the two agree', async () => {
    // The order's own column was left at its 0 default when credit was skipped. A
    // ledger saying 500 and an order saying 0 is two answers to one question.
    const f = await bookedWithoutCredit({ priceConfirmed: true });
    await service.complete(session);

    const { rows } = await pool.query<{ company_base_value: string }>(
      `SELECT company_base_value::text FROM "order" WHERE order_id = $1`,
      [f.orderId],
    );
    expect(rows[0]!.company_base_value).toBe('500.00');
  });
});

describe('running it twice', () => {
  it('does not pay anybody twice', async () => {
    // This runs automatically after every price upload, and an admin who uploads
    // the same file again must not double the ledger.
    const f = await bookedWithoutCredit({ priceConfirmed: true });

    await service.complete(session);
    const afterFirst = await ledgerFor(f.orderId);
    expect(afterFirst).toHaveLength(1);

    await service.complete(session);
    const afterSecond = await ledgerFor(f.orderId);

    expect(afterSecond, 'a second run wrote a second credit row for the same order').toHaveLength(1);
  });
});

describe('an order that was already delivered while its credit was pending', () => {
  it('is NOT credited silently — it is counted and named', async () => {
    // Writing only BOOKED_CREDIT would leave it provisional forever, because
    // status.service realises credit by copying the BOOKED row AT DELIVERY and
    // delivery has already happened. Writing a realised row instead would
    // back-date money into a month that may already have been reported and paid.
    //
    // Neither is an engineering decision, so it surfaces instead of guessing.
    const f = await bookedWithoutCredit({ priceConfirmed: true, status: 'DELIVERED' });

    const result = await service.complete(session);

    expect(await ledgerFor(f.orderId), 'a settled order was credited without a decision').toEqual([]);
    expect(
      result.needsDecision,
      'the delivered order was neither credited nor reported — it has silently vanished',
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('the period the completed credit lands in', () => {
  it('is the CURRENT month, not the month the order was booked', async () => {
    // Back-dating would change a period that may already have been reported, and
    // "a March report reproducible in December" is the guarantee append-only
    // exists to provide. The credit became knowable now.
    const f = await bookedWithoutCredit({ priceConfirmed: true });
    await service.complete(session);

    const ledger = await ledgerFor(f.orderId);
    const expected = new Date().toISOString().slice(0, 7);
    expect(ledger[0]!.period_key).toBe(expected);
  });
});

describe('changing a price later', () => {
  it('CANNOT reach back into credit that has already been earned', async () => {
    // The guarantee that makes repeated price uploads acceptable rather than
    // terrifying. The client's Shopify list changes often, so this will happen
    // regularly - and if it re-priced history, every upload would silently
    // rewrite what reps had already been credited.
    //
    // It holds because order.company_base_value and the ledger row are both
    // SNAPSHOTS taken at booking, and the ledger is append-only. This asserts it
    // rather than trusting it.
    const f = await bookedWithoutCredit({ priceConfirmed: true });
    await service.complete(session);

    const before = await ledgerFor(f.orderId);
    expect(before).toHaveLength(1);
    expect(before[0]!.employee_credited_value).toBe('500.00');

    // Now halve the committed value, which would double her credit on a NEW order.
    const { rows: [sku] } = await pool.query<{ sku_code: string }>(
      `SELECT sku_code FROM sku WHERE is_active ORDER BY sku_code LIMIT 1`,
    );
    const applied = await master.applyPriceUpload(
      session,
      [{ skuCode: sku!.sku_code, basePrice: '250' }],
      // A 50% cut on a confirmed price warns, so acknowledge it - which is the
      // real workflow, not a way around the check.
      true,
    );
    expect(applied.applied).toBe(1);

    const after = await ledgerFor(f.orderId);
    expect(
      after,
      'Re-pricing wrote a second ledger row for an order that was already credited.',
    ).toHaveLength(1);
    expect(
      after[0]!.employee_credited_value,
      'Re-pricing changed credit that had already been earned. A March payslip must not ' +
        'move because somebody uploaded a price list in December.',
    ).toBe('500.00');

    const { rows } = await pool.query<{ company_base_value: string }>(
      `SELECT company_base_value::text FROM "order" WHERE order_id = $1`,
      [f.orderId],
    );
    expect(rows[0]!.company_base_value, 'the snapshot on the order itself was rewritten').toBe('500.00');
  });

  it('applies to an order whose credit has NOT been computed yet', async () => {
    // The other half. A test that only proved nothing changed would be satisfied
    // by an upload that did nothing at all.
    //
    // AND IT MAKES A REAL RULE EXPLICIT: for an order still waiting, completion
    // uses the price as it stands WHEN THE CREDIT IS WORKED OUT, not as it stood
    // when the order was booked. There is no alternative - the booking wrote no
    // ledger row precisely because there was no confirmed price to record - and it
    // is the honest reading of D-124: the credit is computed when it first becomes
    // computable. Only orders already carrying a ledger row are frozen.
    const f = await bookedWithoutCredit({ priceConfirmed: true });

    const { rows: [sku] } = await pool.query<{ sku_code: string }>(
      `SELECT sku_code FROM sku WHERE is_active ORDER BY sku_code LIMIT 1`,
    );
    // 500 -> 250 is a 50% cut on a confirmed price, so it warns and is acknowledged.
    await master.applyPriceUpload(session, [{ skuCode: sku!.sku_code, basePrice: '250' }], true);

    await service.complete(session);

    const ledger = await ledgerFor(f.orderId);
    expect(ledger, 'the waiting order was never credited').toHaveLength(1);
    expect(
      ledger[0]!.employee_credited_value,
      'the newly uploaded price was not used — the upload changed nothing that matters',
    ).toBe('750.00');
  });
});
