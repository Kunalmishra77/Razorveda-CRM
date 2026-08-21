import type { Client } from 'pg';

/**
 * The local-dev sentinel.
 *
 * The host check in env.ts cannot tell a tunnel from local Postgres: the Tailscale
 * form of the production URL is `127.0.0.1:55432`, which is loopback. That makes
 * host-matching decorative against exactly the person most likely to trip it —
 * someone who tunnelled production to loopback at 11pm to make something work.
 *
 * So there is a second, independent check. `migrate --fresh` writes a row into
 * `_local_dev_marker`, and `seed` and `migrate --fresh` both refuse without it.
 * The production deploy path never creates that table, so a tunnelled production
 * database fails closed no matter what the URL looks like.
 *
 * Neither check is sufficient alone. Both are cheap. Keep both.
 *
 * RESIDUAL GAP, stated plainly: anyone who runs `migrate --fresh` against
 * production has already dropped the schema before the marker matters. This
 * guards the far more likely accident — a stray DATABASE_URL pointed at a
 * tunnelled database during a seed — not a determined operator.
 */

export const MARKER_TABLE = '_local_dev_marker';

export async function publicTableCount(client: Client): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'public'`,
  );
  return Number(rows[0]?.n ?? '0');
}

export async function hasLocalDevMarker(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_tables
      WHERE schemaname = 'public' AND tablename = $1`,
    [MARKER_TABLE],
  );
  if (Number(rows[0]?.n ?? '0') === 0) return false;

  const { rows: marker } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${MARKER_TABLE}`,
  );
  return Number(marker[0]?.n ?? '0') > 0;
}

/** Only ever called by `migrate --fresh`. Never by any deploy path. */
export async function createLocalDevMarker(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
       marked_at   timestamptz NOT NULL DEFAULT now(),
       marked_by   text NOT NULL,
       note        text NOT NULL
     )`,
  );
  await client.query(
    `INSERT INTO ${MARKER_TABLE} (marked_by, note) VALUES (current_user, $1)`,
    [
      'Local development database, created by `migrate --fresh`. ' +
        'Its presence is what allows seed and migrate --fresh to run (D-40). ' +
        'If you are reading this on a production database, something is very wrong.',
    ],
  );
}

const refusal = (operation: string, reason: string, remedy: string[]): Error =>
  new Error(
    [
      '',
      `REFUSING to run "${operation}".`,
      '',
      `  ${reason}`,
      '',
      `Decision D-40: the host check cannot distinguish a tunnelled production`,
      `database from local Postgres, because both look like 127.0.0.1. The`,
      `${MARKER_TABLE} table is the second, independent check.`,
      '',
      ...remedy.map((l) => `  ${l}`),
      '',
    ].join('\n'),
  );

/**
 * Guard for `seed`: the target must be a marked local-dev database.
 */
export async function assertLocalDevDatabase(client: Client, operation: string): Promise<void> {
  if (await hasLocalDevMarker(client)) return;

  throw refusal(
    operation,
    `This database has no ${MARKER_TABLE} row, so it is not a known local-dev database.`,
    [
      'If this is your local stack:  npm run infra:up && npm run db:migrate -- --fresh',
      'If this is anything else:     stop, and check DATABASE_URL.',
    ],
  );
}

/**
 * Guard for `migrate --fresh`, which DROPS THE SCHEMA.
 *
 * Allowed when the database is empty (nothing to destroy, so this is a first-time
 * local setup) or already marked. Refused when it holds tables we did not create —
 * which is what a tunnelled production database looks like.
 */
export async function assertSafeToDropSchema(client: Client): Promise<void> {
  if (await hasLocalDevMarker(client)) return;

  const tables = await publicTableCount(client);
  if (tables === 0) return; // empty database: first-time local setup

  throw refusal(
    'migrate --fresh (DROPS ALL DATA)',
    `This database holds ${tables} tables in "public" but has no ${MARKER_TABLE} row. ` +
      `It was not created by this tooling, so it is not safe to drop.`,
    [
      'If this really is a disposable local database, drop it and start clean:',
      '  npm run infra:reset',
      '',
      'If this is the Coolify database, or a tunnel to it: stop. Check DATABASE_URL.',
    ],
  );
}
