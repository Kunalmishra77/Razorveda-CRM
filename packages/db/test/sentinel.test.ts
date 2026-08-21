import { describe, it, expect } from 'vitest';
import type { Client } from 'pg';
import {
  MARKER_TABLE,
  assertLocalDevDatabase,
  assertSafeToDropSchema,
  hasLocalDevMarker,
} from '../src/sentinel.js';

/**
 * D-40. These run against a stubbed client rather than Postgres, because the
 * behaviour worth pinning is the DECISION — refuse or proceed — not the SQL.
 * That also means the guard is verified before Docker exists, which is precisely
 * when someone is most tempted to point a script at the only database that works.
 */

interface FakeDb {
  /** tables in schema "public", excluding the marker table */
  tables: number;
  markerTableExists: boolean;
  markerRows: number;
}

function fakeClient(db: FakeDb): Client {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('AND tablename = $1')) {
        expect(params?.[0]).toBe(MARKER_TABLE);
        return { rows: [{ n: db.markerTableExists ? '1' : '0' }] };
      }
      if (sql.includes(`FROM ${MARKER_TABLE}`)) {
        return { rows: [{ n: String(db.markerRows) }] };
      }
      if (sql.includes("WHERE schemaname = 'public'")) {
        return { rows: [{ n: String(db.tables) }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Client;
}

const marked: FakeDb = { tables: 26, markerTableExists: true, markerRows: 1 };
const emptyDb: FakeDb = { tables: 0, markerTableExists: false, markerRows: 0 };
/** What a tunnelled production database looks like: full of tables, no marker. */
const production: FakeDb = { tables: 25, markerTableExists: false, markerRows: 0 };
/** Table present but never populated — treat as unmarked. */
const hollow: FakeDb = { tables: 26, markerTableExists: true, markerRows: 0 };

describe('hasLocalDevMarker', () => {
  it('is true only when the table exists AND holds a row', async () => {
    expect(await hasLocalDevMarker(fakeClient(marked))).toBe(true);
    expect(await hasLocalDevMarker(fakeClient(production))).toBe(false);
    expect(await hasLocalDevMarker(fakeClient(emptyDb))).toBe(false);
    expect(await hasLocalDevMarker(fakeClient(hollow))).toBe(false);
  });
});

describe('seed guard — assertLocalDevDatabase', () => {
  it('proceeds on a marked local-dev database', async () => {
    await expect(assertLocalDevDatabase(fakeClient(marked), 'seed')).resolves.toBeUndefined();
  });

  it('REFUSES a tunnelled production database, which is the whole point', async () => {
    // This database is reachable at 127.0.0.1 through Tailscale, so the host check
    // in env.ts waves it through. The sentinel is what stops it.
    await expect(assertLocalDevDatabase(fakeClient(production), 'seed')).rejects.toThrow(
      /REFUSING to run "seed"/,
    );
    await expect(assertLocalDevDatabase(fakeClient(production), 'seed')).rejects.toThrow(/D-40/);
  });

  it('refuses an empty database too — seed alone never marks one', async () => {
    // Only `migrate --fresh` creates the marker. Seeding a bare database would
    // otherwise be a way to skip the guard entirely.
    await expect(assertLocalDevDatabase(fakeClient(emptyDb), 'seed')).rejects.toThrow(/REFUSING/);
  });

  it('tells the operator what to run instead', async () => {
    await expect(assertLocalDevDatabase(fakeClient(production), 'seed')).rejects.toThrow(
      /npm run db:migrate -- --fresh/,
    );
  });
});

describe('migrate --fresh guard — assertSafeToDropSchema', () => {
  it('allows a first-time setup on an empty database', async () => {
    // Nothing to destroy, so this is the bootstrap case. Without it the marker
    // could never be created and the guard would deadlock.
    await expect(assertSafeToDropSchema(fakeClient(emptyDb))).resolves.toBeUndefined();
  });

  it('allows a re-drop of an already-marked local database', async () => {
    await expect(assertSafeToDropSchema(fakeClient(marked))).resolves.toBeUndefined();
  });

  it('REFUSES to drop a database holding tables it did not create', async () => {
    await expect(assertSafeToDropSchema(fakeClient(production))).rejects.toThrow(
      /REFUSING to run "migrate --fresh/,
    );
    await expect(assertSafeToDropSchema(fakeClient(production))).rejects.toThrow(
      /holds 25 tables .* but has no _local_dev_marker/,
    );
  });

  it('names Coolify explicitly in the refusal, so the operator stops rather than retries', async () => {
    await expect(assertSafeToDropSchema(fakeClient(production))).rejects.toThrow(/Coolify/);
  });
});
