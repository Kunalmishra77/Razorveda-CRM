import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertLocalTarget, requireDatabaseUrl } from './env.js';
import { assertSafeToDropSchema, createLocalDevMarker } from './sentinel.js';

/**
 * Applies db/schema.sql then db/rls-policies.sql.
 *
 * The checked-in SQL is authoritative for v1 (CLAUDE.md section 3). Drizzle Kit
 * takes over for changes after that; this runner exists to get a database from
 * nothing to correct in one command.
 *
 *   npm run db:migrate            apply to an empty database
 *   npm run db:migrate -- --fresh drop and recreate public first (local only)
 */

const sqlPath = (name: string) => fileURLToPath(new URL(`../../../db/${name}`, import.meta.url));

async function main(): Promise<void> {
  const target = requireDatabaseUrl();
  const fresh = process.argv.includes('--fresh');

  assertLocalTarget(target, fresh ? 'migrate --fresh (DROPS ALL DATA)' : 'migrate');

  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  console.log(`-> ${target.user}@${target.host}:${target.port}/${target.database}`);

  try {
    if (fresh) {
      // Second, independent check. The host check cannot see through a tunnel to
      // 127.0.0.1; this one can, because a production database has no marker (D-40).
      await assertSafeToDropSchema(client);
      console.log('   dropping schema public');
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
      await createLocalDevMarker(client);
      console.log('   wrote _local_dev_marker');
    }

    for (const file of ['schema.sql', 'rls-policies.sql']) {
      console.log(`   applying ${file}`);
      // Single transaction per file: a half-applied schema is worse than none.
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(sqlPath(file), 'utf8'));
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed and was rolled back:\n${(e as Error).message}`);
      }
    }

    // D-21 / D-09: the app must never connect as a role that owns tables, because
    // owners bypass RLS. Verified here so a broken setup fails at migrate time
    // rather than silently passing every isolation test later.
    const { rows } = await client.query<{ owner: string; n: string }>(
      `SELECT tableowner AS owner, count(*)::text AS n
         FROM pg_tables WHERE schemaname = 'public' GROUP BY tableowner`,
    );
    for (const r of rows) {
      console.log(`   ${r.n} tables owned by ${r.owner}`);
      if (r.owner === 'app_role') {
        throw new Error(
          'app_role owns tables. Owners bypass RLS (D-21) and every isolation ' +
            'test would pass while proving nothing. Re-run migrate as the migration user.',
        );
      }
    }

    console.log('migrate: ok');
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\nmigrate failed:\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
