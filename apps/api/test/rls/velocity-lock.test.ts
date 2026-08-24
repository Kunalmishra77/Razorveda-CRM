import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { PII_COPY_VELOCITY_COUNT } from '@razorveda/shared';

/**
 * PHASE 5 CRITERION 2 — the copy-velocity lock, end to end.
 *
 * This exists because the unit tests passed while the control was INERT.
 *
 * `evaluateVelocity` was correct and thirteen tests proved it. The lock still
 * never fired, because `pii_access_log` is read-admin-only by design and the
 * check runs as the REP: the query returned zero rows, the evaluator was handed
 * an empty list, and it correctly concluded there was nothing to see. Nothing
 * errored. The control was installed, tested, and dead.
 *
 * Eighth instance of RLS returning nothing and the caller reading it as a fact
 * about the business rather than about its own permissions — and the sharpest,
 * because the comment above the pii_access_log policy explicitly warned that an
 * admin-only INSERT "would have silently disabled the copy-velocity lock". It was
 * right about the mechanism and wrong about which half.
 *
 * So the guard is here, against a live database, exercising the whole path.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const API = process.env['API_URL'] ?? 'http://localhost:3001';

let pool: pg.Pool;
let rep: { email: string; userId: string; employeeId: string; fullName: string };
let cookie: string;
let leadId: string;

const login = async () => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: rep.email, password: 'razorveda-dev-only' }),
  });
  return {
    body: (await res.json()) as { ok: boolean; message?: string },
    cookie: (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; '),
  };
};

const copy = (action: 'COPY' | 'VIEW' = 'COPY') =>
  fetch(`${API}/pii/copy`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ leadId, action }),
  });

beforeAll(async () => {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set. These tests require a live database.');
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`The API is not answering at ${API}.`);

  pool = new pg.Pool({ connectionString: DATABASE_URL });

  // A rep with a CLEAN ninety-second window. `pii_access_log` is append-only, so
  // copies left by an earlier run — or by the previous run of this very file —
  // cannot be deleted or backdated. Picking a rep who has none is the only way to
  // start from a known state, and it is what makes the file re-runnable.
  const { rows: [r] } = await pool.query<{
    email: string; user_id: string; employee_id: string; full_name: string;
  }>(
    `SELECT u.email, u.user_id, e.employee_id, e.full_name
       FROM employee e JOIN app_user u ON u.user_id = e.user_id
      WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM pii_access_log p
           WHERE p.employee_id = e.employee_id
             AND p.occurred_at >= now() - interval '120 seconds')
      AND e.emp_code LIKE 'EMP-%'
      ORDER BY e.emp_code LIMIT 1`,
  );
  if (!r) {
    throw new Error(
      'Every active rep has copied a phone number in the last two minutes, so no clean ' +
        'window is available. Wait 120 seconds and re-run — pii_access_log is append-only ' +
        'and cannot be cleared to make this convenient.',
    );
  }
  rep = { email: r.email, userId: r.user_id, employeeId: r.employee_id, fullName: r.full_name };

  // Start from a clean slate: this rep may have been locked by an earlier run.
  await pool.query(`UPDATE app_user SET is_locked = false, locked_reason = NULL WHERE user_id = $1`, [
    rep.userId,
  ]);

  const { rows: [c] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (primary_phone, full_name) VALUES ('9000000055','Velocity Probe')
     ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING customer_id`,
  );
  const { rows: [l] } = await pool.query<{ lead_id: string }>(
    `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at, valid_till)
     SELECT $1, source_id, $2, now(), now(), (CURRENT_DATE + 30)
       FROM lead_source ORDER BY code LIMIT 1
     RETURNING lead_id`,
    [c!.customer_id, rep.employeeId],
  );
  leadId = l!.lead_id;

  cookie = (await login()).cookie;
  if (!cookie) throw new Error('could not sign the rep in');
});

afterAll(async () => {
  // Leave the account usable for the next run and for a human poking at the app.
  await pool?.query(`UPDATE app_user SET is_locked = false, locked_reason = NULL WHERE user_id = $1`, [
    rep.userId,
  ]).catch(() => undefined);
  await pool?.query(`UPDATE lead SET closed_at = now(), assigned_to = NULL WHERE lead_id = $1`, [leadId])
    .catch(() => undefined);
  await pool?.end();
});

const isLocked = async (): Promise<boolean> => {
  const { rows: [u] } = await pool.query<{ is_locked: boolean }>(
    `SELECT is_locked FROM app_user WHERE user_id = $1`,
    [rep.userId],
  );
  return u!.is_locked;
};

describe('the lock is actually wired, not merely present', () => {
  it('counts copies through the definer doorway — the half that was dead', async () => {
    // If this reports 0 after a real copy, pii_access_log is being read as the rep
    // again and the whole control is inert however green the unit tests are.
    const res = await copy();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { recentCopies?: number };
    expect(body.recentCopies).toBeGreaterThanOrEqual(0);

    const second = await copy();
    const secondBody = (await second.json()) as { recentCopies?: number };
    expect(secondBody.recentCopies).toBeGreaterThan(0);
  });

  it('does not fire below the threshold', async () => {
    expect(await isLocked()).toBe(false);
  });

  it('locks on the fourth copy inside the window', async () => {
    let locked = false;
    for (let i = 0; i < PII_COPY_VELOCITY_COUNT + 2 && !locked; i += 1) {
      const res = await copy();
      if (res.status === 403) locked = true;
    }
    expect(locked).toBe(true);
    expect(await isLocked()).toBe(true);
  });
});

describe('what the lock actually does to her', () => {
  it('revokes her live sessions, not just her next sign-in', async () => {
    // Without this the lock takes effect whenever she next signs in, which may be
    // tomorrow — long after the numbers are gone.
    const { rows: [live] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_session
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [rep.userId],
    );
    expect(Number(live!.n)).toBe(0);
  });

  it('PRESERVES the revoked sessions, with the reason', async () => {
    // The first version deleted them, which worked only because SECURITY DEFINER
    // runs as the owner — app_role has no DELETE on app_session. It also destroyed
    // where she was signed in from and for how long, which is exactly what an
    // admin needs when deciding whether the lock was fair.
    // Counted by reason, not max(). Single-session enforcement revokes her
    // earlier sessions too with SUPERSEDED_BY_NEW_LOGIN, and picking the
    // alphabetical maximum of several reasons is meaningless — it happened to
    // return the wrong one and the test failed for a reason unrelated to the lock.
    const { rows: [revoked] } = await pool.query<{ total: string; by_lock: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE revoked_reason = 'Copy-velocity lock')::text AS by_lock
         FROM app_session WHERE user_id = $1 AND revoked_at IS NOT NULL`,
      [rep.userId],
    );
    expect(Number(revoked!.total)).toBeGreaterThan(0);
    expect(Number(revoked!.by_lock)).toBeGreaterThan(0);
  });

  it('kills the cookie she is holding right now', async () => {
    const res = await fetch(`${API}/worklist`, { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it('refuses a fresh sign-in, and says why', async () => {
    const { body } = await login();
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/locked/i);
    // She is told an admin can undo it, so she asks rather than assuming she has
    // been sacked by a computer.
    expect(body.message).toMatch(/admin can unlock/i);
  });
});

describe('the alert and the trail', () => {
  it('tells every unlocked admin', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notification_outbox n
        WHERE n.kind = 'velocity_lock_alert'`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  it('writes the lock to the audit trail with the session count', async () => {
    const { rows } = await pool.query<{ after_json: { sessions_revoked: number } }>(
      `SELECT after_json FROM audit_log
        WHERE action = 'ACCOUNT_LOCKED_VELOCITY' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(rows[0]?.after_json.sessions_revoked).toBeGreaterThanOrEqual(1);
  });

  it('does not re-alert an account that is already locked', async () => {
    // Otherwise an admin gets one alert per copy for an account already stopped,
    // and learns to ignore the alert that matters.
    const before = await alertCount();
    await copy();
    expect(await alertCount()).toBe(before);
  });
});

describe('the doorway cannot be turned against a colleague', () => {
  it('a rep cannot read another rep’s copy history through it', async () => {
    const { rows: [other] } = await pool.query<{ employee_id: string }>(
      `SELECT employee_id FROM employee WHERE employee_id <> $1 AND status = 'ACTIVE' LIMIT 1`,
      [rep.employeeId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_role');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [rep.userId]);
      await client.query(`SELECT set_config('app.user_role', 'EMPLOYEE', true)`);
      await expect(
        client.query(`SELECT * FROM security_recent_pii_copies($1, 90)`, [other!.employee_id]),
      ).rejects.toThrow(/only read your own/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });
});

async function alertCount(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notification_outbox WHERE kind = 'velocity_lock_alert'`,
  );
  return Number(rows[0]!.n);
}
