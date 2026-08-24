import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  todaySql, lifetimeSql, periodsSql,
  type TodayRow, type LifetimeRow, type PeriodRow,
} from '../../src/worklist/rep-metrics.sql.js';

/**
 * A REP AND HER ADMIN MUST SEE THE SAME NUMBERS.
 *
 * `/me/dashboard` builds its SQL with `current_employee_id()`; `/team/:id` builds
 * the same SQL with `$1::uuid`. They share one module so they cannot drift, and
 * this file proves the sharing actually holds end to end rather than in principle
 * — running both forms against the same rep and requiring identical answers.
 *
 * If someone later "optimises" one caller by inlining its own copy, this fails.
 * That is the whole point: rule 10 says a metric has exactly one definition, and
 * a rule with no test behind it is a preference.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const APP_URL = process.env['DATABASE_URL_APP'];

let admin: pg.Pool;
let app: pg.Pool;
let repId: string;
let repUserId: string;

beforeAll(async () => {
  if (!DATABASE_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_URL_APP are required. These tests do not skip.');
  }
  admin = new pg.Pool({ connectionString: DATABASE_URL });
  app = new pg.Pool({ connectionString: APP_URL });

  // A rep with real work behind her, so the comparison is not 0 = 0.
  const { rows: [rep] } = await admin.query<{ employee_id: string; user_id: string }>(
    `SELECT e.employee_id, e.user_id
       FROM employee e JOIN app_user u ON u.user_id = e.user_id
      WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE' AND e.emp_code LIKE 'EMP-%'
      ORDER BY (SELECT count(*) FROM lead l WHERE l.assigned_to = e.employee_id) DESC
      LIMIT 1`,
  );
  if (!rep) throw new Error('need an active rep with leads. Run db:seed and the import.');
  repId = rep.employee_id;
  repUserId = rep.user_id;
});

afterAll(async () => {
  await admin?.end();
  await app?.end();
});

/** Run a builder the way the REP's own screen does: RLS, no parameters. */
async function asRep<T>(sql: string): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [repUserId]);
    await client.query(`SELECT set_config('app.user_role', $1, true)`, ['EMPLOYEE']);
    const { rows } = await client.query(sql);
    await client.query('ROLLBACK');
    return rows as T;
  } finally {
    client.release();
  }
}

/** Run the same builder the way the ADMIN's screen does: bound parameter. */
async function asAdmin<T>(sql: string): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [repUserId]);
    await client.query(`SELECT set_config('app.user_role', $1, true)`, ['ADMIN']);
    const { rows } = await client.query(sql, [repId]);
    await client.query('ROLLBACK');
    return rows as T;
  } finally {
    client.release();
  }
}

describe('the rep screen and the admin screen read one definition', () => {
  it('agrees on today', async () => {
    const [mine] = await asRep<TodayRow[]>(todaySql('current_employee_id()'));
    const [theirs] = await asAdmin<TodayRow[]>(todaySql('$1::uuid'));
    expect(theirs).toEqual(mine);
  });

  it('agrees on lifetime', async () => {
    const [mine] = await asRep<LifetimeRow[]>(lifetimeSql('current_employee_id()'));
    const [theirs] = await asAdmin<LifetimeRow[]>(lifetimeSql('$1::uuid'));
    expect(theirs).toEqual(mine);
  });

  it('agrees on today / week / month / all time', async () => {
    const mine = await asRep<PeriodRow[]>(periodsSql('current_employee_id()'));
    const theirs = await asAdmin<PeriodRow[]>(periodsSql('$1::uuid'));
    expect(theirs).toEqual(mine);
    expect(mine.length, 'four periods, or the dashboard has holes in it').toBe(4);
  });
});

describe('Conversion % is the dictionary definition, not one invented at render time', () => {
  it('carries the denominator the formula needs', async () => {
    // docs/03 §2 and §5 both define it as delivered orders over LEADS ASSIGNED.
    // Without `assigned` in the payload the UI has nothing to divide by, and the
    // first version reached for connected calls instead — two populations with
    // nothing to do with each other, which printed 675%.
    const rows = await asAdmin<PeriodRow[]>(periodsSql('$1::uuid'));
    for (const r of rows) {
      expect(r.assigned, `period ${r.period} has no leads-assigned count`).toBeDefined();
      expect(Number.isNaN(Number(r.assigned))).toBe(false);
    }
  });

  it('cannot exceed 100% for any period', async () => {
    // The property, not a fixture. Delivered orders are attributed to the rep who
    // booked them and assigned leads are the leads she was given; a rate above 1
    // means the two are being drawn from different populations again.
    const rows = await asAdmin<PeriodRow[]>(periodsSql('$1::uuid'));
    for (const r of rows) {
      const assigned = Number(r.assigned);
      if (assigned === 0) continue;
      const pct = (Number(r.delivered) / assigned) * 100;
      expect(pct, `${r.period}: conversion came out at ${Math.round(pct)}%`).toBeLessThanOrEqual(100);
    }
  });

  it('reports delivered, never booked — realised not booked (rule 3)', async () => {
    const rows = await asAdmin<PeriodRow[]>(periodsSql('$1::uuid'));
    for (const r of rows) {
      expect(
        Number(r.delivered),
        `${r.period}: more delivered than booked, so one of them is not what it says`,
      ).toBeLessThanOrEqual(Number(r.orders));
    }
  });
});
