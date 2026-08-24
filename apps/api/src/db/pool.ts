import { Logger } from '@nestjs/common';
import pg from 'pg';

/**
 * The application connection pool.
 *
 * Uses DATABASE_URL_APP — the role that owns NOTHING (D-21). Connecting as the
 * migration user would silently disable every RLS policy in the system while
 * leaving all eight isolation tests green, because those tests SET ROLE
 * explicitly. That is the single worst failure mode this codebase has, so the
 * variable is separate and the reason is written where someone will read it.
 */

const log = new Logger('Pool');

export function createAppPool(): pg.Pool {
  const connectionString = process.env['DATABASE_URL_APP'];
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL_APP is not set. The API must connect as a role that owns no ' +
        'tables (D-21) — see .env.example. Do NOT fall back to DATABASE_URL: that ' +
        'is the migration user, which owns the tables and therefore bypasses RLS.',
    );
  }

  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    // Fail a connection attempt rather than hanging a request forever behind a
    // database that is not answering.
    connectionTimeoutMillis: 10_000,
    // TCP keepalive, because the thing that kills an idle pooled connection is
    // usually something in the middle — a NAT table, a load balancer, a laptop
    // sleeping — quietly dropping a socket nobody has spoken on for a while.
    keepAlive: true,
  });

  /**
   * WITHOUT THIS LISTENER, A DROPPED CONNECTION KILLS THE ENTIRE API.
   *
   * `pg.Pool` emits `error` on IDLE clients when their connection dies —
   * Postgres restarted, the network blipped, a firewall reaped the socket. An
   * `error` event with no listener is, in Node, a thrown exception: the process
   * exits.
   *
   *   Error: Connection terminated unexpectedly
   *       at Connection.<anonymous> (pg/lib/client.js)
   *   [exited with code 1]
   *
   * That is not theoretical. It happened on this machine while the app was
   * simply sitting idle, and the visible symptom was the login screen saying
   * "Cannot reach the API" — which reads like a configuration mistake rather
   * than a crash. In production one Postgres hiccup would take the CRM down for
   * all seven reps until somebody noticed and restarted it.
   *
   * The right behaviour is the boring one: an idle client dying is EXPECTED
   * operationally. The pool discards it and opens another on the next request.
   * So this logs loudly and does nothing else. Requests in flight still get
   * their own error through the normal promise rejection path — this handler
   * only stops an idle-client failure from being fatal.
   */
  pool.on('error', (err) => {
    log.error(
      `idle client dropped: ${err.message}. The pool will replace it; requests are unaffected. ` +
        'If this repeats, look at the database or the network between here and it.',
    );
  });

  return pool;
}
