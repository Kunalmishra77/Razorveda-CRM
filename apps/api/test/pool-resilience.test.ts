import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAppPool } from '../src/db/pool.js';

/**
 * A DROPPED IDLE CONNECTION MUST NOT KILL THE API.
 *
 * `pg.Pool` emits `error` on idle clients whose connection dies — Postgres
 * restarted, the network blipped, something in the middle reaped a quiet socket.
 * In Node an `error` event with no listener is a thrown exception, so the whole
 * process exits:
 *
 *   Error: Connection terminated unexpectedly
 *   [exited with code 1]
 *
 * This is not hypothetical. It happened while the app sat idle on a development
 * machine, and what the user saw was the login screen saying "Cannot reach the
 * API" — which reads like a misconfiguration, not a crash. In production it would
 * take the CRM down for every rep until someone noticed.
 *
 * The listener is one line. The reason it is worth a test is that it is exactly
 * the kind of line a refactor deletes as "unused" — it has no callers and its
 * whole purpose is to exist.
 */

const ORIGINAL = process.env['DATABASE_URL_APP'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['DATABASE_URL_APP'];
  else process.env['DATABASE_URL_APP'] = ORIGINAL;
});

describe('the application pool', () => {
  it('handles its own error event, so an idle drop is survivable', async () => {
    // Points at a database that does not need to exist: no connection is opened
    // here. What is under test is the emitter wiring, not connectivity.
    process.env['DATABASE_URL_APP'] = 'postgresql://nobody:nothing@127.0.0.1:1/none';
    const pool = createAppPool();

    expect(
      pool.listenerCount('error'),
      'The pool has no error listener. An idle client dropping will throw an ' +
        'unhandled error event and exit the process — the CRM goes down for everyone.',
    ).toBeGreaterThan(0);

    // Emitting with a listener attached must NOT throw. Without the listener this
    // same call is what terminates the process.
    expect(() => pool.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow();

    await pool.end().catch(() => undefined);
  });

  it('refuses to start without DATABASE_URL_APP, and says why', () => {
    // The failure that must stay loud. Falling back to DATABASE_URL would connect
    // as the migration user, which owns the tables and therefore bypasses every
    // RLS policy — while all the isolation tests stay green, because they SET ROLE
    // explicitly (D-21).
    delete process.env['DATABASE_URL_APP'];
    expect(() => createAppPool()).toThrow(/DATABASE_URL_APP/);
    expect(() => createAppPool()).toThrow(/owns no/i);
  });

  it('sets a connection timeout, so a dead database fails instead of hanging', () => {
    process.env['DATABASE_URL_APP'] = 'postgresql://nobody:nothing@127.0.0.1:1/none';
    const pool = createAppPool();
    // pg keeps the resolved options on the pool. A request against an unreachable
    // database should surface an error a user can be shown, not wait forever
    // behind a spinner — which is precisely how "Loading your day…" becomes
    // permanent.
    const opts = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(opts['connectionTimeoutMillis']).toBeGreaterThan(0);
    expect(opts['keepAlive']).toBe(true);
    void pool.end().catch(() => undefined);
  });

  it('is the ONLY place a pool is constructed in application code', () => {
    // A second pool built somewhere else would not inherit any of the above, and
    // would reintroduce the crash on its own schedule.
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    let hits: string[] = [];
    try {
      hits = execFileSync('git', ['grep', '-l', '-I', '--untracked', '-E', 'new (pg\\.|pgLib\\.)?Pool\\(', '--', src], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch (e) {
      const err = e as { status?: number };
      if (err.status !== 1) throw e; // 1 means "no matches", which cannot happen here
    }

    expect(hits.length, `pools are constructed in: ${hits.join(', ')}`).toBe(1);
    expect(hits[0]).toMatch(/pool\.ts$/);
  });
});
