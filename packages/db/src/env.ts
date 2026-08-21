/**
 * Connection configuration and the destructive-operation guard.
 *
 * D-17: dev and CI run against local Postgres in Docker. Coolify is the deploy
 * target only, and destructive schema/seed/RLS work must never touch it.
 *
 * That decision is worth more as a mechanism than as a promise. `migrate`, `seed`
 * and the RLS harness all call assertLocalTarget() before opening a connection, so
 * a stray DATABASE_URL in a shell aborts the run instead of rewriting the client's
 * only database.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'razorveda-postgres']);

/** Set to 'i-understand' ONLY for a deliberate, reviewed production migration. */
const OVERRIDE_VAR = 'RAZORVEDA_ALLOW_REMOTE_DDL';

export interface DbTarget {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly isLocal: boolean;
}

export function parseDatabaseUrl(url: string): DbTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    throw new Error(`DATABASE_URL must be a postgresql:// URL, got "${u.protocol}"`);
  }
  const host = u.hostname;
  return {
    url,
    host,
    port: u.port ? Number(u.port) : 5432,
    database: u.pathname.replace(/^\//, ''),
    user: decodeURIComponent(u.username),
    isLocal: LOCAL_HOSTS.has(host),
  };
}

export function requireDatabaseUrl(): DbTarget {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, then run `npm run infra:up`.',
    );
  }
  return parseDatabaseUrl(url);
}

/**
 * Abort unless the target is local. Called by every command that writes DDL or
 * bulk data.
 *
 * The override exists because a real production migration must eventually be
 * possible — but it has to be typed on purpose, by a person, with the host in
 * front of them.
 */
export function assertLocalTarget(target: DbTarget, operation: string): void {
  if (target.isLocal) return;

  if (process.env[OVERRIDE_VAR] === 'i-understand') {
    // eslint-disable-next-line no-console
    console.warn(
      `\n!!  ${operation} is running against a REMOTE host (${target.host}:${target.port})\n` +
        `!!  because ${OVERRIDE_VAR}=i-understand is set. This is not a drill.\n`,
    );
    return;
  }

  throw new Error(
    [
      '',
      `REFUSING to run "${operation}" against a non-local database.`,
      '',
      `  host:     ${target.host}:${target.port}`,
      `  database: ${target.database}`,
      `  user:     ${target.user}`,
      '',
      'Decision D-17: dev and CI run against local Postgres in Docker. Coolify is the',
      'deploy target only. Destructive schema, seed and RLS work must never point at it.',
      '',
      'If you meant to run locally:   npm run infra:up   (then check DATABASE_URL)',
      `If this really is a reviewed production migration: ${OVERRIDE_VAR}=i-understand`,
      '',
    ].join('\n'),
  );
}

/**
 * The migration user owns the tables; the application must never connect as it
 * (D-21). Owners bypass RLS, so an app connected as the owner would silently see
 * everything while every isolation test still passed.
 */
export const APP_ROLE = 'app_role';
