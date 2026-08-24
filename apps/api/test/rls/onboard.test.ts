import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { verify } from '@node-rs/argon2';
import { SYSTEM_ACTOR_EMAIL } from '@razorveda/shared';
import { OnboardService } from '../../src/employees/onboard.service.js';
import type { RlsSession } from '../../src/db/rls-context.js';

/**
 * ADDING A PERSON TO THE ROSTER — and the boundary that must not move.
 *
 * `OWNER_ONLY_FIELDS` is `role` and `monthly_target`, and the reason is not
 * bureaucratic: an admin who can set a role can make themselves an owner, and an
 * admin who can set a target can set their own incentive. Onboarding is the one
 * new place where both could leak, because creating an account is exactly the act
 * of choosing someone's role.
 *
 * So the tests that matter here are the refusals.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let ownerSession: RlsSession;
let adminSession: RlsSession;
let onboard: OnboardService;

/** Unique per run: emp_code and email are both UNIQUE and nothing is deleted. */
const uniq = () => String(Date.now()).slice(-6) + Math.floor(Math.random() * 90 + 10);

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  onboard = new OnboardService(pool);

  // The system actor is an ADMIN and is the cleanest stand-in for one here.
  const { rows: [system] } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM auth_lookup($1)',
    [SYSTEM_ACTOR_EMAIL],
  );
  if (!system) throw new Error(`${SYSTEM_ACTOR_EMAIL} is not seeded — run npm run db:seed`);
  adminSession = { userId: system.user_id, role: 'ADMIN' };

  const { rows: [owner] } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE role = 'OWNER' LIMIT 1`,
  );
  if (!owner) throw new Error('no OWNER seeded — run npm run db:seed');
  ownerSession = { userId: owner.user_id, role: 'OWNER' };
});

// Nothing is torn down: audit_log is append-only and refuses DELETE even for the
// owner. See repeat-provisional.test.ts.
afterAll(async () => {
  await pool?.end();
});

describe('the boundary an admin must not cross', () => {
  it('an ADMIN cannot create another ADMIN', async () => {
    // This is privilege escalation in one request. An admin who can mint admins
    // can mint one for anybody, including a second account for themselves.
    await expect(
      onboard.add(adminSession, {
        empCode: `ADM-${uniq().slice(-3)}`,
        fullName: 'Should Not Exist',
        email: `nope-${uniq()}@razorveda.local`,
        role: 'ADMIN',
      }),
    ).rejects.toThrow(/owner/i);
  });

  it('a REP cannot add anybody at all', async () => {
    const { rows: [rep] } = await pool.query<{ user_id: string }>(
      `SELECT u.user_id FROM app_user u JOIN employee e ON e.user_id = u.user_id
        WHERE u.role = 'EMPLOYEE' LIMIT 1`,
    );
    await expect(
      onboard.add(
        { userId: rep!.user_id, role: 'EMPLOYEE' },
        { empCode: `EMP-${uniq().slice(-3)}`, fullName: 'Nope', email: `x-${uniq()}@razorveda.local`, role: 'EMPLOYEE' },
      ),
    ).rejects.toThrow(/admin/i);
  });

  it('the OWNER can create an ADMIN', async () => {
    // The permitted half. Without this the refusal above could be implemented by
    // simply never allowing an admin to be created, and nobody would notice.
    const r = await onboard.add(ownerSession, {
      empCode: `ADM-${uniq().slice(-3)}`,
      fullName: 'Real New Admin',
      email: `admin-${uniq()}@razorveda.local`,
      role: 'ADMIN',
    });
    expect(r.role).toBe('ADMIN');
    expect(r.mustEnrolTotp, 'an admin was created without being told they need 2FA').toBe(true);
  });
});

describe('adding a rep', () => {
  it('creates a working login and an ACTIVE roster row', async () => {
    const email = `rep-${uniq()}@razorveda.local`;
    const r = await onboard.add(adminSession, {
      empCode: `EMP-${uniq().slice(-3)}`,
      fullName: 'Brand New Rep',
      email,
      role: 'EMPLOYEE',
    });

    const { rows: [row] } = await pool.query<{
      status: string; monthly_target: string; role: string; is_locked: boolean; password_hash: string;
    }>(
      `SELECT e.status, e.monthly_target::text, u.role, u.is_locked, u.password_hash
         FROM employee e JOIN app_user u ON u.user_id = e.user_id
        WHERE e.employee_id = $1`,
      [r.employeeId],
    );

    expect(row!.status).toBe('ACTIVE');
    expect(row!.role).toBe('EMPLOYEE');
    expect(row!.is_locked, 'a new joiner was created already locked out').toBe(false);
    expect(r.mustEnrolTotp, 'a rep was told to set up 2FA she does not need').toBe(false);

    // The password that came back is the password that works. Without this the
    // admin could hand over a string that fails, and the rep would be told her
    // details are wrong on her first morning.
    expect(await verify(row!.password_hash, r.temporaryPassword)).toBe(true);
  });

  it('leaves monthly_target at ZERO even though an admin created the row', async () => {
    // The quiet half of the boundary. Refusing `role` is visible; a target
    // silently taken from the request would not be, and it is the field that
    // decides incentive.
    const r = await onboard.add(adminSession, {
      empCode: `EMP-${uniq().slice(-3)}`,
      fullName: 'Target Check',
      email: `target-${uniq()}@razorveda.local`,
      role: 'EMPLOYEE',
    });
    const { rows } = await pool.query<{ monthly_target: string }>(
      'SELECT monthly_target::text FROM employee WHERE employee_id = $1',
      [r.employeeId],
    );
    expect(rows[0]!.monthly_target).toBe('0.00');
  });

  it('writes an audit row that does NOT contain the password', async () => {
    // An audit trail holding credentials is a credential store with worse access
    // control, and audit_log is readable by every admin.
    const email = `audit-${uniq()}@razorveda.local`;
    const r = await onboard.add(adminSession, {
      empCode: `EMP-${uniq().slice(-3)}`,
      fullName: 'Audit Check',
      email,
      role: 'EMPLOYEE',
    });

    const { rows } = await pool.query<{ after_json: Record<string, unknown> }>(
      `SELECT after_json FROM audit_log
        WHERE action = 'EMPLOYEE_ONBOARDED' AND entity_id = $1`,
      [r.employeeId],
    );
    expect(rows, 'onboarding was not audited').toHaveLength(1);
    expect(JSON.stringify(rows[0]!.after_json)).not.toContain(r.temporaryPassword);
    expect(rows[0]!.after_json['email']).toBe(email);
  });

  it('gives every new joiner a DIFFERENT password', async () => {
    // Generated rather than chosen, because an admin setting passwords for seven
    // people sets the same one seven times.
    const a = await onboard.add(adminSession, {
      empCode: `EMP-${uniq().slice(-3)}`, fullName: 'A', email: `a-${uniq()}@razorveda.local`, role: 'EMPLOYEE',
    });
    const b = await onboard.add(adminSession, {
      empCode: `EMP-${uniq().slice(-3)}`, fullName: 'B', email: `b-${uniq()}@razorveda.local`, role: 'EMPLOYEE',
    });
    expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
    expect(a.temporaryPassword.length).toBeGreaterThanOrEqual(20);
  });
});

describe('refusing a duplicate, in words an admin can act on', () => {
  it('names the employee code when it collides', async () => {
    const code = `EMP-${uniq().slice(-3)}`;
    await onboard.add(adminSession, {
      empCode: code, fullName: 'First', email: `first-${uniq()}@razorveda.local`, role: 'EMPLOYEE',
    });
    await expect(
      onboard.add(adminSession, {
        empCode: code, fullName: 'Second', email: `second-${uniq()}@razorveda.local`, role: 'EMPLOYEE',
      }),
    ).rejects.toThrow(new RegExp(`${code}.*already in use`, 'i'));
  });

  it('names the email when it collides', async () => {
    const email = `dupe-${uniq()}@razorveda.local`;
    await onboard.add(adminSession, {
      empCode: `EMP-${uniq().slice(-3)}`, fullName: 'First', email, role: 'EMPLOYEE',
    });
    await expect(
      onboard.add(adminSession, {
        empCode: `EMP-${uniq().slice(-3)}`, fullName: 'Second', email, role: 'EMPLOYEE',
      }),
    ).rejects.toThrow(/already has an account/i);
  });

  it('rejects a malformed employee code before writing anything', async () => {
    await expect(
      onboard.add(adminSession, {
        empCode: 'nonsense', fullName: 'X', email: `x-${uniq()}@razorveda.local`, role: 'EMPLOYEE',
      }),
    ).rejects.toThrow(/EMP-010/);
  });
});
