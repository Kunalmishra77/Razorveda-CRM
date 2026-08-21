import type { UserRole } from '@razorveda/shared';

/**
 * Roster management (O-01, resolved as a mechanism — D-87).
 *
 * The client never handed over a definitive roster: the brief says 7, the Achieve
 * Report has 11, the Scoreboard has 10 (F13). Waiting for a list was always the
 * wrong shape of answer, because the roster changes — people join, go on leave and
 * leave. Admins manage it in the Employees panel, and the seeded 9 are a starting
 * point rather than a claim.
 *
 * What is NOT admin-editable matters as much as what is. docs/05 gives the OWNER
 * exactly three extra powers: managing admin accounts, setting targets, and
 * changing incentive rules. An admin who could set their own team's targets could
 * also set their own incentive, so that boundary is enforced here rather than
 * assumed.
 */

export type RosterField =
  | 'full_name'
  | 'emp_code'
  | 'status'
  | 'wip_cap'
  | 'shift_start'
  | 'shift_end'
  | 'joined_on'
  | 'exited_on'
  | 'monthly_target'
  | 'role';

/** Fields only the OWNER may change (docs/05 governance note, D-04). */
export const OWNER_ONLY_FIELDS: readonly RosterField[] = ['monthly_target', 'role'];

export type PermissionResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function canEditRosterField(actor: UserRole, field: RosterField): PermissionResult {
  if (actor === 'EMPLOYEE') {
    return { allowed: false, reason: 'Only an admin can change the employee roster.' };
  }
  if (actor === 'OWNER') return { allowed: true };

  if (OWNER_ONLY_FIELDS.includes(field)) {
    return {
      allowed: false,
      reason:
        field === 'monthly_target'
          ? 'Only the owner can set targets. An admin who could set targets could also set their own incentive.'
          : 'Only the owner can change roles or manage admin accounts.',
    };
  }
  return { allowed: true };
}

export type EmployeeStatus = 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'EXITED';

export interface StatusChangeEffects {
  /** Return this rep's open leads to the unassigned pool. */
  readonly returnLeadsToPool: boolean;
  /** Revoke sessions immediately rather than waiting for idle timeout. */
  readonly revokeSessions: boolean;
  /** Keep them selectable when assigning. */
  readonly assignable: boolean;
  readonly handoverNoteRequired: boolean;
}

/**
 * What a status change actually does.
 *
 * docs/05 offboarding: one action — revoke access, bulk-return open leads with a
 * handover note, preserve the access log. Leaving a departed rep's leads assigned
 * to them is how 174 leads sat untouched for a full validity window.
 *
 * ON_LEAVE deliberately does NOT return leads. A rep back next week should find
 * her pipeline where she left it; the assignment console already warns that she is
 * on leave, which is the right place to make that judgement.
 */
export function statusChangeEffects(to: EmployeeStatus): StatusChangeEffects {
  switch (to) {
    case 'ACTIVE':
      return {
        returnLeadsToPool: false,
        revokeSessions: false,
        assignable: true,
        handoverNoteRequired: false,
      };
    case 'ON_LEAVE':
      return {
        returnLeadsToPool: false,
        revokeSessions: false,
        assignable: false,
        handoverNoteRequired: false,
      };
    case 'SUSPENDED':
      // Access stops now. Leads stay put: a suspension is often short, and
      // scattering someone's pipeline is hard to undo.
      return {
        returnLeadsToPool: false,
        revokeSessions: true,
        assignable: false,
        handoverNoteRequired: false,
      };
    case 'EXITED':
      return {
        returnLeadsToPool: true,
        revokeSessions: true,
        assignable: false,
        handoverNoteRequired: true,
      };
  }
}

export interface RosterChange {
  readonly employeeId: string;
  readonly field: RosterField;
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Every roster change is audited with before and after (docs/05, definition of
 * done item 4).
 *
 * The roster is provisional until O-01 is settled in practice rather than on
 * paper, so "who changed Kajal's WIP cap and when" has to be answerable.
 */
export function auditEntryFor(change: RosterChange, actor: UserRole): {
  readonly action: string;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly actorRole: UserRole;
} {
  return {
    action: `EMPLOYEE_${change.field.toUpperCase()}_CHANGED`,
    before: { [change.field]: change.from },
    after: { [change.field]: change.to },
    actorRole: actor,
  };
}
