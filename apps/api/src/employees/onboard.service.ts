import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import pgLib from 'pg';
import type { Pool } from 'pg';
import { ARGON2ID_PARAMS } from '@razorveda/shared';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { canEditRosterField } from './roster-rules.js';

/**
 * ADDING A PERSON. The half of roster management that was never built.
 *
 * `roster-rules.ts` says it plainly: "Admins manage it in the Employees panel,
 * and the seeded 9 are a starting point rather than a claim." That was how O-01
 * was resolved - as a mechanism rather than a list, because the roster changes:
 * people join, go on leave, and leave (D-87).
 *
 * Leaving was built. Joining was not. There was no endpoint anywhere in the API
 * that could create an `employee` or an `app_user`, so the only roster this system
 * could ever have was the one in `employees.csv`, and a new joiner had no way in
 * except a developer re-running the seed. Third time this exact shape has turned
 * up: the scheduler, the pending credit, and now this - a capability described in
 * a comment that nothing implements.
 *
 * THE BOUNDARY THAT MATTERS, and it already existed.
 *
 * `OWNER_ONLY_FIELDS` is `role` and `monthly_target`. An admin who could set a
 * role could make themselves an owner; an admin who could set a target could set
 * their own incentive. So an ADMIN may add a rep and nothing else: the role is
 * forced to EMPLOYEE and the target is left at zero for the owner to set. Only the
 * OWNER may create another admin.
 *
 * That rule is not re-implemented here - `canEditRosterField` already encodes it
 * and is already tested. This calls it.
 */

export interface NewEmployee {
  readonly empCode: string;
  readonly fullName: string;
  readonly email: string;
  readonly role: 'EMPLOYEE' | 'ADMIN';
  // `| undefined` explicitly, because the project runs with
  // exactOptionalPropertyTypes: an omitted Zod field arrives as undefined, not as
  // an absent key, and the two are different types under that flag.
  readonly wipCap?: number | null | undefined;
  readonly shiftStart?: string | null | undefined;
  readonly shiftEnd?: string | null | undefined;
  readonly joinedOn?: string | null | undefined;
}

export interface OnboardResult {
  readonly employeeId: string;
  readonly empCode: string;
  readonly fullName: string;
  readonly role: string;
  /**
   * Shown to the admin ONCE and never stored in readable form.
   *
   * There is no password-reset flow in v1, so a temporary password the admin
   * hands over is the only way a new joiner can sign in. It is generated here
   * rather than chosen by the admin, because an admin choosing passwords for
   * seven people picks the same one seven times.
   */
  readonly temporaryPassword: string;
  readonly mustEnrolTotp: boolean;
}

@Injectable()
export class OnboardService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  async add(session: RlsSession, input: NewEmployee): Promise<OnboardResult> {
    // Creating an ADMIN is a change of ROLE, which is owner-only. Checked before
    // anything is written and with the rule that already exists, so the API and
    // the UI cannot drift apart about who may do what.
    if (input.role === 'ADMIN') {
      const permitted = canEditRosterField(session.role, 'role');
      if (!permitted.allowed) throw new ForbiddenException(permitted.reason);
    } else if (session.role === 'EMPLOYEE') {
      throw new ForbiddenException('Only an admin can add someone to the roster.');
    }

    const empCode = input.empCode.trim().toUpperCase();
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();

    if (!/^[A-Z]{2,5}-\d{1,4}$/.test(empCode)) {
      throw new BadRequestException(
        'The employee code should look like EMP-010 or ADM-004 — letters, a dash, then a number.',
      );
    }
    if (!fullName) throw new BadRequestException('A name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('That does not look like an email address.');
    }

    /**
     * 18 random bytes, base64url. Long enough that it cannot be guessed and short
     * enough that it can be read down a phone line, which is how it will actually
     * be delivered to a rep who dials from her own handset.
     */
    const temporaryPassword = randomBytes(18).toString('base64url');
    const passwordHash = await hash(temporaryPassword, ARGON2ID_PARAMS);

    return withRlsContext(this.pool, session, async (client) => {
      // Checked explicitly rather than relying on the UNIQUE constraint, because
      // a raw "duplicate key value violates unique constraint" tells an admin
      // nothing about which field collided or what to do next.
      const { rows: clashes } = await client.query<{ what: string }>(
        `SELECT 'code' AS what FROM employee WHERE upper(emp_code) = $1
          UNION ALL
         SELECT 'email' FROM app_user WHERE lower(email) = $2`,
        [empCode, email],
      );
      if (clashes.some((c) => c.what === 'code')) {
        throw new BadRequestException(`${empCode} is already in use by someone else on the roster.`);
      }
      if (clashes.some((c) => c.what === 'email')) {
        throw new BadRequestException(`${email} already has an account.`);
      }

      const { rows: [user] } = await client.query<{ user_id: string }>(
        `INSERT INTO app_user (email, password_hash, role, is_locked)
         VALUES ($1, $2, $3::user_role, false)
         RETURNING user_id`,
        [email, passwordHash, input.role],
      );
      if (!user) throw new BadRequestException('That account could not be created.');

      const { rows: [employee] } = await client.query<{ employee_id: string }>(
        `INSERT INTO employee (user_id, emp_code, full_name, status, monthly_target,
                               wip_cap, shift_start, shift_end, joined_on)
         VALUES ($1,$2,$3,'ACTIVE',
                 -- Zero, ALWAYS. monthly_target is owner-only (OWNER_ONLY_FIELDS),
                 -- so it is never taken from this request whoever is calling.
                 -- The owner sets it afterwards on the roster screen.
                 0,
                 coalesce($4, 150), coalesce($5::time, '10:00'), coalesce($6::time, '20:00'),
                 coalesce($7::date, CURRENT_DATE))
         RETURNING employee_id`,
        [
          user.user_id, empCode, fullName,
          input.wipCap ?? null, input.shiftStart ?? null, input.shiftEnd ?? null, input.joinedOn ?? null,
        ],
      );
      if (!employee) throw new BadRequestException('That employee could not be created.');

      // The password is NOT in the audit row. An audit trail that records
      // credentials is a credential store with worse access control.
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
         VALUES ($1,$2::user_role,'EMPLOYEE_ONBOARDED','employee',$3,$4::jsonb)`,
        [
          session.userId, session.role, employee.employee_id,
          JSON.stringify({ emp_code: empCode, full_name: fullName, email, role: input.role }),
        ],
      );

      return {
        employeeId: employee.employee_id,
        empCode,
        fullName,
        role: input.role,
        temporaryPassword,
        // Admins and the owner need a 6-digit code; a rep does not. Returned so the
        // screen can tell the admin what the new person will meet at first login
        // rather than leaving them to discover it.
        mustEnrolTotp: input.role === 'ADMIN',
      };
    });
  }
}
