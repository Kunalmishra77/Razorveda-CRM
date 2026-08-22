import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

/**
 * THE SILENT WRITE FILTER — the bug class that has now cost four separate fixes.
 *
 * RLS refuses a READ by returning fewer rows. Everyone expects that. What is not
 * obvious is that RLS refuses a WRITE the same way: an UPDATE whose USING clause
 * matches nothing succeeds, reports zero rows, and raises NOTHING. There is no
 * error, no log line, no exception to catch.
 *
 * That is how two-factor enrolment broke. `UPDATE app_user SET totp_secret = ...`
 * ran from a context with no role, matched zero rows, and the calling code read
 * "zero rows" as its own business rule — "this account already has an
 * authenticator". A permissions failure wearing a business-rule message, and a
 * clean log. It was only found by enrolling and watching the secret not appear.
 *
 * Three tables before it: audit_log (a failed login could not be recorded),
 * order_status_event and attribution_ledger (a rep could not write her own order).
 *
 * The fix pattern is a narrow SECURITY DEFINER function per operation — one
 * controlled doorway — rather than opening app_user, which holds password hashes,
 * to every app_role query.
 *
 * These tests exist so the NEXT pre-session write is caught here rather than in
 * production, where it looks like nothing happened at all. Unit tests cannot see
 * this: the behaviour lives entirely in the database.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let adminUserId: string;

/** app_role with NO session context — exactly what login and enrolment have. */
async function preSession<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('RESET ROLE').catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. These tests require a live database and will not skip.',
    );
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE role IN ('ADMIN','OWNER') ORDER BY email LIMIT 1`,
  );
  if (!rows[0]) throw new Error('need an admin account. Run db:seed.');
  adminUserId = rows[0].user_id;
});

afterAll(async () => {
  await pool?.end();
});

describe('RLS refuses writes silently — the trap itself', () => {
  it('a direct UPDATE with no session reports SUCCESS and changes nothing', async () => {
    // This is the whole hazard in one assertion. If this ever starts throwing,
    // Postgres has changed its behaviour and several defensive comments in this
    // repo can be simplified. Until then, assume every pre-session write is a
    // no-op unless it goes through a doorway function.
    const result = await preSession((c) =>
      c.query(`UPDATE app_user SET last_login_at = now() WHERE user_id = $1`, [adminUserId]),
    );
    expect(result.rowCount).toBe(0);
  });

  it('a direct INSERT into app_user is refused LOUDLY, unlike the update', async () => {
    // INSERT is checked by WITH CHECK, which does raise. The asymmetry is the
    // reason the UPDATE case went unnoticed: one half of the surface is noisy.
    await expect(
      preSession((c) =>
        c.query(
          `INSERT INTO app_user (email, password_hash, role) VALUES ('x@y.z','h','ADMIN')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('the doorway functions login and enrolment depend on', () => {
  it('auth_lookup reads an account that a direct SELECT cannot see', async () => {
    const { direct, viaDoorway } = await preSession(async (c) => {
      const email = (
        await pool.query<{ email: string }>(`SELECT email FROM app_user WHERE user_id = $1`, [
          adminUserId,
        ])
      ).rows[0]!.email;
      return {
        direct: (await c.query(`SELECT 1 FROM app_user WHERE user_id = $1`, [adminUserId]))
          .rowCount,
        viaDoorway: (await c.query(`SELECT * FROM auth_lookup($1)`, [email])).rowCount,
      };
    });
    // Without this, every password on a fresh deployment looks wrong.
    expect(direct).toBe(0);
    expect(viaDoorway).toBe(1);
  });

  it('auth_touch_last_login writes where the direct UPDATE silently did not', async () => {
    // Same statement, same session, same table — the only difference is the
    // doorway. Run as app_role with no user context, then read back as the owner
    // inside the same transaction, which is the only vantage point that can see it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE app_user SET last_login_at = NULL WHERE user_id = $1`, [
        adminUserId,
      ]);

      await client.query('SET LOCAL ROLE app_role');
      const direct = await client.query(
        `UPDATE app_user SET last_login_at = now() WHERE user_id = $1`, [adminUserId],
      );
      await client.query(`SELECT auth_touch_last_login($1)`, [adminUserId]);
      await client.query('RESET ROLE');

      const { rows: [after] } = await client.query<{ last_login_at: Date | null }>(
        `SELECT last_login_at FROM app_user WHERE user_id = $1`, [adminUserId],
      );

      expect(direct.rowCount).toBe(0);        // silently did nothing
      expect(after!.last_login_at).not.toBeNull();  // the doorway landed
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });

  it('auth_enrol_totp binds a secret exactly ONCE, then refuses', async () => {
    // The one-time rule lives in the database, not in the caller. Two enrolments
    // started at the same moment must not both win: the second gets false.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [victim] } = await client.query<{ user_id: string }>(
        `INSERT INTO app_user (email, password_hash, role)
         VALUES ('enrol-probe@razorveda.test', 'not-a-real-hash', 'ADMIN')
      RETURNING user_id`,
      );
      await client.query('SET LOCAL ROLE app_role');

      const first = await client.query<{ enrolled: boolean }>(
        `SELECT auth_enrol_totp($1,$2) AS enrolled`, [victim!.user_id, 'SECRETONE'],
      );
      const second = await client.query<{ enrolled: boolean }>(
        `SELECT auth_enrol_totp($1,$2) AS enrolled`, [victim!.user_id, 'SECRETTWO'],
      );
      await client.query('RESET ROLE');
      const { rows: [saved] } = await client.query<{ totp_secret: string }>(
        `SELECT totp_secret FROM app_user WHERE user_id = $1`, [victim!.user_id],
      );

      expect(first.rows[0]!.enrolled).toBe(true);
      // A stolen password must not be able to re-bind an authenticator. If this
      // ever returns true, account takeover becomes a single-factor problem.
      expect(second.rows[0]!.enrolled).toBe(false);
      expect(saved!.totp_secret).toBe('SECRETONE');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query('RESET ROLE').catch(() => undefined);
      client.release();
    }
  });
});
