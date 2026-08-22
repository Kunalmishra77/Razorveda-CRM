import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

/**
 * THE SELF-DIRECTED SECURITY REVIEW (tasks/phase-5, exit criterion 1).
 *
 * "Try to break RLS. Write a failing test for anything found before fixing it."
 *
 * This attacks the running API as a real signed-in rep, using ids she has no
 * right to. It is deliberately NOT a unit test of the policies: the policies have
 * been tested since Phase 1 and passed while five separate write paths were
 * silently broken. What matters is whether the HTTP surface leaks, because that
 * is the surface an actual rep has.
 *
 * Every assertion is written from the attacker's point of view: "I am Nikita,
 * here is Divya's lead id, what do I get back?" A pass means the answer is
 * nothing, and — just as important — that it is indistinguishable from a lead
 * that does not exist. A 403 saying "that is not yours" confirms the record is
 * real, which is a smaller leak than the data but still a leak.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const API = process.env['API_URL'] ?? 'http://localhost:3001';
const DEV_PASSWORD = 'razorveda-dev-only';

let pool: pg.Pool;
let repA: Session;
let repB: Session;
let bLeadId: string;
let bOrderId: string;
let bCustomerId: string;

interface Session {
  readonly name: string;
  readonly cookie: string;
  readonly employeeId: string;
}

async function signIn(email: string, name: string, employeeId: string): Promise<Session> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: DEV_PASSWORD }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`could not sign in as ${email}: ${JSON.stringify(await res.json())}`);
  return { name, cookie, employeeId };
}

const as = (s: Session, path: string, method = 'GET', body?: unknown) =>
  fetch(`${API}${path}`, {
    method,
    headers: { cookie: s.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  // A reachable API is part of the fixture. Skipping when it is down would turn
  // "we never ran the security review" into "the security review passed".
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(`The API is not answering at ${API}. Start it before running the security review.`);
  }

  pool = new pg.Pool({ connectionString: DATABASE_URL });

  const { rows: reps } = await pool.query<{ email: string; full_name: string; employee_id: string }>(
    `SELECT u.email, e.full_name, e.employee_id
       FROM employee e JOIN app_user u ON u.user_id = e.user_id
      WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE' AND NOT u.is_locked
      ORDER BY e.emp_code LIMIT 2`,
  );
  if (reps.length < 2) throw new Error('need two active reps. Run db:seed && db:seed:dev.');

  repA = await signIn(reps[0]!.email, reps[0]!.full_name, reps[0]!.employee_id);
  repB = await signIn(reps[1]!.email, reps[1]!.full_name, reps[1]!.employee_id);

  // Give rep B something worth stealing: a lead, a customer, and an order.
  const { rows: [c] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (primary_phone, full_name) VALUES ('9000000042','Victim Customer')
     ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING customer_id`,
  );
  bCustomerId = c!.customer_id;

  const { rows: [l] } = await pool.query<{ lead_id: string }>(
    `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at, valid_till)
     SELECT $1, source_id, $2, now(), now(), (CURRENT_DATE + 30)
       FROM lead_source ORDER BY code LIMIT 1
     RETURNING lead_id`,
    [bCustomerId, repB.employeeId],
  );
  bLeadId = l!.lead_id;

  const { rows: [o] } = await pool.query<{ order_id: string }>(
    `INSERT INTO "order" (order_number, customer_id, lead_id, source_id, booked_by_employee_id,
                          order_date, final_value, company_base_value, payment_mode,
                          prepaid_amount, cod_amount, current_status)
     SELECT 'ADV-' || left($3::text, 8), $1, $3::uuid, source_id, $2, CURRENT_DATE, 5000, 0,
            'COD', 0, 5000, 'PENDING'
       FROM lead_source ORDER BY code LIMIT 1
     RETURNING order_id`,
    [bCustomerId, repB.employeeId, bLeadId],
  );
  bOrderId = o!.order_id;
  await pool.query(
    `INSERT INTO order_status_event (order_id, from_status, to_status, source)
     VALUES ($1, NULL, 'PENDING', 'TEST')`,
    [bOrderId],
  );
});

afterAll(async () => {
  await pool?.query(`UPDATE lead SET closed_at = now(), assigned_to = NULL WHERE lead_id = $1`, [bLeadId])
    .catch(() => undefined);
  await pool?.query(`UPDATE "order" SET current_status = 'CANCELLED' WHERE order_id = $1`, [bOrderId])
    .catch(() => undefined);
  await pool?.end();
});

/** A leak is any response that reveals the record exists or what is in it. */
const leaked = async (res: Response): Promise<boolean> => {
  if (res.status >= 400) return false;
  const text = await res.text();
  return text.includes('Victim Customer') || text.includes('9000000042') || text.includes('ADV-');
};

describe('the fixture is real, so a pass cannot be vacuous', () => {
  it('rep B can see her own lead — the thing A must not see', async () => {
    const res = await as(repB, `/leads/${bLeadId}`);
    expect(res.status).toBe(200);
    expect(await leaked(res)).toBe(true);
  });

  it('the two reps are different people', () => {
    expect(repA.employeeId).not.toBe(repB.employeeId);
  });
});

describe('IDOR — every endpoint that takes an id', () => {
  it('GET /leads/:id with another rep’s lead', async () => {
    const res = await as(repA, `/leads/${bLeadId}`);
    expect(await leaked(res)).toBe(false);
    // 404, not 403. A "forbidden" confirms the lead exists, which tells an
    // attacker which ids are real and is enough to enumerate the customer base.
    expect(res.status).toBe(404);
  });

  it('POST /orders/:id/status on another rep’s order', async () => {
    const res = await as(repA, `/orders/${bOrderId}/status`, 'POST', { to: 'CONFIRMED' });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // And it did not move. A refused request that still mutated would be worse
    // than one that returned the data.
    const { rows: [after] } = await pool.query<{ current_status: string }>(
      `SELECT current_status FROM "order" WHERE order_id = $1`,
      [bOrderId],
    );
    expect(after!.current_status).toBe('PENDING');
  });

  it('POST /orders booking against another rep’s lead', async () => {
    const { rows: [sku] } = await pool.query<{ sku_id: string }>(
      `SELECT sku_id FROM sku WHERE is_active ORDER BY sku_code LIMIT 1`,
    );
    const res = await as(repA, '/orders', 'POST', {
      leadId: bLeadId,
      lines: [{ skuId: sku!.sku_id, quantity: 1, unitPrice: '1000.00' }],
      prepaidAmount: '0',
      codAmount: '1000.00',
      upsellSkuIds: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Nothing was created against the victim's customer.
    const { rows: [count] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "order"
        WHERE customer_id = $1 AND booked_by_employee_id = $2`,
      [bCustomerId, repA.employeeId],
    );
    expect(count!.n).toBe('0');
  });

  it('POST /orders/preview against another rep’s lead', async () => {
    // The preview computes money. Leaking a credit split reveals the order value
    // even when the order itself stays hidden.
    const { rows: [sku] } = await pool.query<{ sku_id: string }>(
      `SELECT sku_id FROM sku WHERE is_active ORDER BY sku_code LIMIT 1`,
    );
    const res = await as(repA, '/orders/preview', 'POST', {
      leadId: bLeadId,
      lines: [{ skuId: sku!.sku_id, quantity: 1, unitPrice: '1000.00' }],
      prepaidAmount: '0',
      codAmount: '1000.00',
      upsellSkuIds: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('POST /activity logging against another rep’s lead', async () => {
    const res = await as(repA, '/activity', 'POST', {
      leadId: bLeadId,
      type: 'CALL',
      connected: true,
      remark: 'probing',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const { rows: [count] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM activity WHERE lead_id = $1 AND employee_id = $2`,
      [bLeadId, repA.employeeId],
    );
    expect(count!.n).toBe('0');
  });

  it('POST /pii/copy against another rep’s lead', async () => {
    // This one is doubly bad: it would both reveal the number and put the copy
    // event on the victim's record.
    const res = await as(repA, '/pii/copy', 'POST', { leadId: bLeadId, field: 'primary_phone' });
    expect(await leaked(res)).toBe(false);
  });
});

/**
 * SELF-DEALING — the class the first review missed entirely.
 *
 * Every attack above asks "can rep A reach rep B's data?", and RLS answered
 * correctly every time. None of them asked whether a rep may do something
 * illegitimate to her OWN data, which RLS cannot answer and was never meant to.
 *
 * She could. Book an order, then PENDING → CONFIRMED → PROCESSING → DISPATCHED →
 * OFD → DELIVERED in six requests, and the delivery realises her credit. No
 * admin, no courier, no parcel. Credit is earned on delivery (rule 3) and
 * delivery was self-service.
 */
describe('a rep cannot pay herself', () => {
  let ownOrderId: string;
  let ownLeadId: string;

  beforeAll(async () => {
    const { rows: [c] } = await pool.query<{ customer_id: string }>(
      `INSERT INTO customer (primary_phone, full_name) VALUES ('9000000043','Self Deal Probe')
       ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING customer_id`,
    );
    const { rows: [l] } = await pool.query<{ lead_id: string }>(
      `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at, valid_till)
       SELECT $1, source_id, $2, now(), now(), (CURRENT_DATE + 30)
         FROM lead_source ORDER BY code LIMIT 1
       RETURNING lead_id`,
      [c!.customer_id, repA.employeeId],
    );
    ownLeadId = l!.lead_id;

    const { rows: [o] } = await pool.query<{ order_id: string }>(
      `INSERT INTO "order" (order_number, customer_id, lead_id, source_id, booked_by_employee_id,
                            order_date, final_value, company_base_value, payment_mode,
                            prepaid_amount, cod_amount, current_status)
       SELECT 'SELF-' || left($3::text, 8), $1, $3::uuid, source_id, $2, CURRENT_DATE, 5000, 0,
              'COD', 0, 5000, 'PENDING'
         FROM lead_source ORDER BY code LIMIT 1
       RETURNING order_id`,
      [c!.customer_id, repA.employeeId, ownLeadId],
    );
    ownOrderId = o!.order_id;
    await pool.query(
      `INSERT INTO order_status_event (order_id, from_status, to_status, source)
       VALUES ($1, NULL, 'PENDING', 'TEST')`,
      [ownOrderId],
    );
    await pool.query(
      `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                       employee_credited_value, rule_applied, is_realised, period_key)
       VALUES ($1,$2,'BOOKED_CREDIT',0,5000,'TEST',false,to_char(CURRENT_DATE,'YYYY-MM'))`,
      [ownOrderId, repA.employeeId],
    );
  });

  it('she CAN confirm her own order — she spoke to the customer', async () => {
    // The line is not "reps cannot touch orders". She may record what she knows.
    const res = await as(repA, `/orders/${ownOrderId}/status`, 'POST', { to: 'CONFIRMED' });
    expect(res.status).toBeLessThan(400);
  });

  it('she CANNOT dispatch it — that is a warehouse fact', async () => {
    const res = await as(repA, `/orders/${ownOrderId}/status`, 'POST', { to: 'PROCESSING' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/only an admin/i);
    // The message explains the rule rather than just refusing, so a rep who hits
    // it understands it is policy and not a bug to be reported.
    expect(body.message).toMatch(/courier/i);
  });

  it('she CANNOT mark it delivered, which is the one that pays her', async () => {
    const res = await as(repA, `/orders/${ownOrderId}/status`, 'POST', { to: 'DELIVERED' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('and nothing realised — the ledger is untouched', async () => {
    const { rows: [led] } = await pool.query<{ realised: string }>(
      `SELECT coalesce(sum(employee_credited_value) FILTER (WHERE is_realised), 0)::text AS realised
         FROM attribution_ledger WHERE order_id = $1`,
      [ownOrderId],
    );
    expect(Number(led!.realised)).toBe(0);
  });

  it('she CAN cancel it — cancelling can only ever reduce what she earns', async () => {
    // Blocking this would make her chase an admin to record a customer's change
    // of mind, and there is no incentive to abuse a transition that pays nothing.
    const res = await as(repA, `/orders/${ownOrderId}/status`, 'POST', { to: 'CANCELLED' });
    expect(res.status).toBeLessThan(400);
  });
});

describe('pagination cannot be used to widen the blast radius', () => {
  it('a rep cannot exceed the 50-row cap by asking for more', async () => {
    const res = await as(repA, '/worklist?limit=5000');
    expect(res.status).toBeLessThan(500);
    if (res.ok) {
      const body = (await res.json()) as { leads?: unknown[]; items?: unknown[] };
      const rows = body.leads ?? body.items ?? [];
      expect(rows.length).toBeLessThanOrEqual(50);
    }
  });

  it('a negative or absurd limit does not error the server or return everything', async () => {
    for (const limit of ['-1', '0', 'abc', '99999999999999999999']) {
      const res = await as(repA, `/worklist?limit=${limit}`);
      expect(res.status, `limit=${limit}`).toBeLessThan(500);
      if (res.ok) {
        const body = (await res.json()) as { leads?: unknown[]; items?: unknown[] };
        expect((body.leads ?? body.items ?? []).length).toBeLessThanOrEqual(50);
      }
    }
  });

  it('the worklist never contains another rep’s customer', async () => {
    const res = await as(repA, '/worklist');
    expect(await leaked(res)).toBe(false);
  });
});

describe('no admin surface is reachable by a rep', () => {
  const adminRoutes: ReadonlyArray<readonly [string, string, unknown?]> = [
    ['/reports/employee-performance?from=2026-08-01&to=2026-08-31', 'GET'],
    ['/reports/employee-performance/export?from=2026-08-01&to=2026-08-31', 'GET'],
    ['/reports/close-pack/build?from=2026-08-01&to=2026-08-31', 'GET'],
    ['/assignment/pool', 'GET'],
    ['/assignment/assign', 'POST', { leadIds: [], toEmployeeId: null }],
    ['/ingestion/batches', 'GET'],
    ['/incentive/00000000-0000-0000-0000-000000000000?period=2026-08', 'GET'],
    ['/scoring', 'GET'],
    ['/scoring/run', 'POST', {}],
    ['/leads/followup/untouched', 'GET'],
    ['/leads/followup/recall', 'POST', {}],
    ['/leads/repeat/run', 'POST', {}],
    ['/digests/run', 'POST', {}],
    ['/digests/sent', 'GET'],
  ];

  for (const [path, method, body] of adminRoutes) {
    it(`${method} ${path.split('?')[0]}`, async () => {
      const res = await as(repA, path, method, body);
      // Any 4xx is acceptable. What is not acceptable is a 200 with data.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await leaked(res)).toBe(false);
    });
  }
});

describe('unauthenticated callers get nothing', () => {
  const publicOk = ['/health', '/metrics/registry'];

  it('the two public routes stay public and carry no business data', async () => {
    for (const path of publicOk) {
      const res = await fetch(`${API}${path}`);
      expect(res.status, path).toBe(200);
      expect(await leaked(res), path).toBe(false);
    }
  });

  it('everything else refuses without a session', async () => {
    for (const path of ['/worklist', `/leads/${bLeadId}`, '/orders/skus', '/digests/sent']) {
      const res = await fetch(`${API}${path}`);
      expect(res.status, path).toBeGreaterThanOrEqual(400);
    }
  });

  it('a forged session cookie is refused', async () => {
    // Not a real signature. If this ever returns 200, the token is not being
    // verified at all.
    const res = await fetch(`${API}/worklist`, {
      headers: { cookie: 'rv_access=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJBRE1JTiJ9.forged' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
