import type { Pool } from 'pg';
import { SYSTEM_ACTOR_EMAIL } from '@razorveda/shared';
import type { RlsSession } from '../db/rls-context.js';

/**
 * Resolves the identity scheduled jobs act as.
 *
 * REUSES auth_lookup RATHER THAN ADDING A DOORWAY.
 *
 * `app_user` is admin-only under RLS, and the API pool connects as
 * `razorveda_app` with no user context — so a plain `SELECT ... FROM app_user`
 * here would match zero rows and report "the system actor does not exist". That
 * is the same trap that made TOTP enrolment silently fail and every password look
 * wrong: RLS refusing a read that looks like missing data.
 *
 * `auth_lookup` is already the single SECURITY DEFINER doorway into that table,
 * already granted to app_role, and already returns exactly the two fields needed.
 * Adding a second function with the same purpose would mean two places to audit
 * when the rules around app_user change.
 *
 * It also returns `is_locked`, which is deliberately IGNORED here — see below.
 */
export async function resolveSystemActor(pool: Pool): Promise<RlsSession> {
  const { rows } = await pool.query<{ user_id: string; role: string; is_locked: boolean }>(
    'SELECT user_id, role, is_locked FROM auth_lookup($1)',
    [SYSTEM_ACTOR_EMAIL],
  );

  const actor = rows[0];
  if (!actor) {
    throw new Error(
      `The scheduled-jobs actor ${SYSTEM_ACTOR_EMAIL} does not exist. Run \`npm run db:seed\`.\n` +
        'Without it the 72h pool return, the repeat queue and the daily digests cannot run,\n' +
        'because there would be no attributable actor for the rows they write.',
    );
  }

  // is_locked is EXPECTED to be true and is not an error.
  //
  // The lock exists to make the account unusable as a LOGIN. It says nothing about
  // whether the account may be the actor on a row, which is its only job. Treating
  // the lock as a failure here would mean the safest possible configuration of this
  // account — permanently locked, no known password — was also the one that stopped
  // rule 6 from running.
  if (actor.role !== 'ADMIN' && actor.role !== 'OWNER') {
    throw new Error(
      `${SYSTEM_ACTOR_EMAIL} has role ${actor.role}, but the scheduled jobs need is_admin() ` +
        'to be true — the 72h recall reaches every rep\'s leads by design. Re-run the seed.',
    );
  }

  return { userId: actor.user_id, role: actor.role };
}
