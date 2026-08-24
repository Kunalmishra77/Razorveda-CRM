import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import pg from 'pg';

/**
 * THE RESTORE DRILL (tasks/phase-5, exit criterion 3).
 *
 * "An untested backup is not a backup."
 *
 * This takes a real dump, restores it into a scratch database, and then checks
 * the thing that actually matters — not that the rows came back, but that the
 * SECURITY came back with them.
 *
 * A restore that loses row-level security is far worse than a failed restore. The
 * application starts, every query succeeds, every rep sees every customer, and
 * nothing anywhere says so. That is the failure this drill is built to catch, and
 * it is why the verification below asserts policies, FORCE flags and the
 * SECURITY DEFINER doorways rather than stopping at row counts.
 *
 *   npm run db:restore-drill
 *
 * ROLES ARE NOT IN THE DUMP. `pg_dump` is per-database; `app_role` and
 * `razorveda_app` live in the cluster. Restoring into a FRESH cluster needs
 * `pg_dumpall --roles-only` as well — see the README. This drill restores into
 * the same cluster, so the roles already exist, and it says so rather than
 * quietly passing on a technicality.
 */

/**
 * Windows default, because that is where this drill was written and is run by
 * hand. CI overrides it (/usr/lib/postgresql/16/bin) and the client's server is
 * Linux, so both paths matter.
 */
const PG_BIN =
  process.env['PG_BIN'] ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/bin');
const BACKUP_DIR = resolve(fileURLToPath(new URL('../../../.backups', import.meta.url)));

const HOST = process.env['PGHOST'] ?? '127.0.0.1';
const PORT = process.env['PGPORT'] ?? '5433';
const USER = process.env['PGUSER'] ?? 'razorveda_migrator';
const PASSWORD = process.env['PGPASSWORD'] ?? 'localdev';
const SOURCE_DB = process.env['PGDATABASE'] ?? 'razorveda';
const SCRATCH_DB = 'razorveda_restore_drill';

/**
 * `.exe` ONLY ON WINDOWS.
 *
 * This was unconditional, which meant the drill looked for `pg_dump.exe` on
 * Linux and reported "pg_dump was not found — set PG_BIN". Invisible for as long
 * as the drill only ever ran on the laptop it was written on; it failed the first
 * time CI ran it, which is the entire argument for putting it in CI.
 *
 * The client's production database is Linux. A disaster-recovery drill that
 * cannot execute on the platform it is meant to recover is not a drill.
 */
const EXE = process.platform === 'win32' ? '.exe' : '';
const tool = (name: string): string => join(PG_BIN, `${name}${EXE}`);

function run(name: string, args: readonly string[]): { ok: boolean; output: string } {
  const result = spawnSync(tool(name), args, {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: PASSWORD },
    // Inherited stdio would print a password prompt into the operator's terminal
    // on failure; captured output is quieter and easier to attach to a report.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

const connect = async (database: string): Promise<pg.Client> => {
  const client = new pg.Client({
    host: HOST, port: Number(PORT), user: USER, password: PASSWORD, database,
  });
  client.on('error', () => undefined);
  await client.connect();
  return client;
};

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function main(): Promise<void> {
  if (!existsSync(tool('pg_dump'))) {
    throw new Error(
      `pg_dump was not found at ${PG_BIN}. Set PG_BIN to a PostgreSQL bin directory.\n` +
        `The embedded-postgres package ships only initdb, pg_ctl and postgres — no dump tools.`,
    );
  }

  mkdirSync(BACKUP_DIR, { recursive: true });
  const dumpFile = join(BACKUP_DIR, `${SOURCE_DB}-drill.dump`);

  console.log(`restore drill: ${USER}@${HOST}:${PORT}/${SOURCE_DB}`);
  console.log(`   pg_dump from ${PG_BIN}`);

  // ── 1. take the backup ────────────────────────────────────────────────────
  const dumpStarted = Date.now();
  const dump = run('pg_dump', [
    '-h', HOST, '-p', PORT, '-U', USER, '-d', SOURCE_DB,
    // Custom format: compressed, and pg_restore can be selective if a partial
    // recovery is ever needed. Plain SQL cannot.
    '-Fc',
    // --no-owner is fine: object ownership is remapped to whoever runs the
    // restore, and that is the migration role either way.
    '--no-owner',
    // --no-privileges is NOT fine, and the first version of this drill used it.
    // GRANTs are how app_role reaches a table at all; RLS policies decide WHICH
    // ROWS it sees. Restoring policies without grants produces a database where
    // every policy is present and app_role can read nothing — the application
    // fails closed, which is the right direction and still a broken restore.
    // Found by this drill: the isolation check errored on a permission denial.
    '-f', dumpFile,
  ]);
  if (!dump.ok) throw new Error(`pg_dump failed:\n${dump.output}`);
  const dumpMs = Date.now() - dumpStarted;
  const dumpBytes = statSync(dumpFile).size;
  console.log(`   dumped ${(dumpBytes / 1024).toFixed(0)} KB in ${dumpMs} ms -> ${dumpFile}`);

  // ── 2. row counts BEFORE, to compare against ──────────────────────────────
  const source = await connect(SOURCE_DB);
  const before = await rowCounts(source);
  await source.end();

  // ── 3. a scratch database, dropped and recreated ──────────────────────────
  const admin = await connect('postgres');
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();
  console.log(`   created scratch database ${SCRATCH_DB}`);

  // ── 4. restore ────────────────────────────────────────────────────────────
  const restoreStarted = Date.now();
  const restore = run('pg_restore', [
    '-h', HOST, '-p', PORT, '-U', USER, '-d', SCRATCH_DB,
    // No --no-privileges here either. Dropping it from the dump alone achieved
    // nothing: pg_restore was still told to skip them, so the grants were in the
    // archive and thrown away on the way in. Both sides have to agree.
    '--no-owner',
    dumpFile,
  ]);
  const restoreMs = Date.now() - restoreStarted;
  // pg_restore exits non-zero on warnings as well as errors, so its output is
  // reported rather than trusted as a pass/fail on its own — the checks below
  // are what decide.
  if (!restore.ok && restore.output) {
    // pg_dump 18 emits `SET transaction_timeout = 0`, a parameter PostgreSQL 16
    // does not know. It is a session setting with no effect on the data, so the
    // restore is sound — but the mismatch is real and worth naming rather than
    // swallowing, because a LATER version difference might not be benign.
    const benign = /unrecognized configuration parameter "transaction_timeout"/.test(restore.output);
    console.log(`   pg_restore reported:\n${indent(restore.output)}`);
    if (benign) {
      console.log(
        '   ^ known and benign: pg_dump 18 against a PostgreSQL 16 server. The setting\n' +
          '     affects nothing in the dump. Use a matching-version pg_dump in production\n' +
          '     so a future, less harmless difference is not hidden by a familiar warning.',
      );
    }
  }
  console.log(`   restored in ${restoreMs} ms`);

  // ── 5. refresh the materialised views ─────────────────────────────────────
  //
  // NOT optional, and not a tidy-up. pg_dump records a matview's definition but
  // not its contents, so a restored database has six EMPTY matviews. Every report
  // reads them. An empty matview returns zero rows rather than failing, so the
  // morning after a restore every report would show a quiet month and nothing
  // anywhere would say the data had not come back.
  //
  // Found by this drill, which is what a drill is for.
  const scratch = await connect(SCRATCH_DB);
  const refreshStarted = Date.now();
  const { rows: mvs } = await scratch.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'm' ORDER BY c.relname`,
  );
  for (const mv of mvs) await scratch.query(`REFRESH MATERIALIZED VIEW ${mv.relname}`);
  const refreshMs = Date.now() - refreshStarted;
  console.log(`   refreshed ${mvs.length} materialised views in ${refreshMs} ms`);

  // ── 6. verify ─────────────────────────────────────────────────────────────
  const checks = await verify(scratch, before);
  await scratch.end();

  console.log('\n   verification');
  for (const c of checks) console.log(`     ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n   RTO measured: dump ${dumpMs} ms + restore ${restoreMs} ms + refresh ${refreshMs} ms ` +
      `= ${dumpMs + restoreMs + refreshMs} ms at ${Object.values(before).reduce((a, b) => a + b, 0)} rows.`,
  );
  console.log(
    '   NOTE: measured on development data. Re-measure at the client\'s volume before ' +
      'claiming the 4-hour RTO in criterion 4.',
  );

  if (failed.length > 0) {
    throw new Error(`restore drill FAILED ${failed.length} check(s): ${failed.map((f) => f.name).join(', ')}`);
  }
  console.log('\nrestore drill: ok');
}

/** Every table's row count, so the comparison is complete rather than sampled. */
async function rowCounts(client: pg.Client): Promise<Record<string, number>> {
  const { rows: tables } = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  );
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${t.table_name}"`);
    counts[t.table_name] = Number(rows[0]?.n ?? '0');
  }
  return counts;
}

async function verify(client: pg.Client, before: Record<string, number>): Promise<Check[]> {
  const checks: Check[] = [];

  const after = await rowCounts(client);
  const missingTables = Object.keys(before).filter((t) => !(t in after));
  const wrongCounts = Object.keys(before).filter((t) => t in after && after[t] !== before[t]);

  checks.push({
    name: 'every table restored',
    ok: missingTables.length === 0,
    detail: missingTables.length === 0
      ? `${Object.keys(after).length} tables`
      : `missing: ${missingTables.join(', ')}`,
  });
  checks.push({
    name: 'every row restored',
    ok: wrongCounts.length === 0,
    detail: wrongCounts.length === 0
      ? `${Object.values(after).reduce((a, b) => a + b, 0)} rows match the source exactly`
      : wrongCounts.map((t) => `${t}: ${before[t]} -> ${after[t]}`).join(', '),
  });

  // THE CHECK THAT MATTERS. A restore that comes back without RLS starts cleanly
  // and shows every rep every customer.
  const { rows: [rls] } = await client.query<{ total: string; secured: string; forced: string; policies: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE c.relrowsecurity)::text AS secured,
            count(*) FILTER (WHERE c.relforcerowsecurity)::text AS forced,
            (SELECT count(*)::text FROM pg_policy) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_local_dev_marker'`,
  );
  checks.push({
    name: 'row-level security survived',
    ok: rls!.total === rls!.secured && rls!.total === rls!.forced && Number(rls!.policies) > 0,
    detail: `${rls!.secured}/${rls!.total} tables secured, ${rls!.forced}/${rls!.total} FORCED, ${rls!.policies} policies`,
  });

  // The SECURITY DEFINER doorways. Losing one of these does not expose data, but
  // it silently disables login, two-factor enrolment or the velocity lock.
  const doorways = [
    'auth_lookup', 'auth_enrol_totp', 'auth_touch_last_login',
    'security_lock_account', 'security_recent_pii_copies',
    'current_user_id', 'current_employee_id', 'is_admin',
  ];
  const { rows: fns } = await client.query<{ proname: string; prosecdef: boolean }>(
    `SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [doorways],
  );
  const missingFns = doorways.filter((d) => !fns.some((f) => f.proname === d));
  checks.push({
    name: 'security functions survived',
    ok: missingFns.length === 0,
    detail: missingFns.length === 0
      ? `${fns.length} present, ${fns.filter((f) => f.prosecdef).length} SECURITY DEFINER`
      : `missing: ${missingFns.join(', ')}`,
  });

  // Append-only is enforced by triggers. A restore without them turns an
  // immutable ledger into an editable one, which is the quietest possible way to
  // lose the guarantee that makes a March report reproducible in December.
  const { rows: [triggers] } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND c.relname IN ('order_status_event','activity','lead_assignment',
                          'attribution_ledger','audit_log','pii_access_log')`,
  );
  checks.push({
    name: 'append-only triggers survived',
    ok: Number(triggers!.n) >= 6,
    detail: `${triggers!.n} triggers on the six append-only tables`,
  });

  // Matviews restore empty unless populated. A report reading an empty matview
  // returns zero rather than failing, which reads as "a quiet month".
  // Aliased, because the column is `relispopulated` and reading it as
  // `ispopulated` gave undefined for every row — so this check reported all six
  // matviews unpopulated even immediately after a successful refresh. A
  // verification that always fails is only marginally better than one that always
  // passes: both stop telling you anything.
  const { rows: matviews } = await client.query<{ relname: string; ispopulated: boolean }>(
    `SELECT c.relname, c.relispopulated AS ispopulated
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'm' ORDER BY c.relname`,
  );
  const unpopulated = matviews.filter((m) => !m.ispopulated).map((m) => m.relname);
  checks.push({
    name: 'materialised views populated',
    ok: unpopulated.length === 0,
    detail: unpopulated.length === 0
      ? `${matviews.length} populated`
      : `NOT populated: ${unpopulated.join(', ')} — run REFRESH MATERIALIZED VIEW after restore`,
  });

  // Policies existing is not the same as policies WORKING. D-49: a check run as
  // the table owner returns every row and reports a pass, because owners bypass
  // RLS unless it is FORCED. This runs as app_role with a real rep's context and
  // asserts she sees strictly less than the owner does.
  const { rows: [rep] } = await client.query<{ user_id: string }>(
    `SELECT u.user_id FROM app_user u JOIN employee e ON e.user_id = u.user_id
      WHERE u.role = 'EMPLOYEE' ORDER BY e.emp_code LIMIT 1`,
  );
  if (rep) {
    const { rows: [ownerView] } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lead`,
    );

    let repCount = -1;
    let isolationError: string | null = null;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_role');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [rep.user_id]);
      await client.query(`SELECT set_config('app.user_role', 'EMPLOYEE', true)`);
      const { rows: [repView] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lead`,
      );
      repCount = Number(repView!.n);
    } catch (e) {
      // A permission denial here is itself a finding: it means the GRANTs did not
      // come back. Recorded rather than thrown, so the drill still reports every
      // other check — and so the connection is always released. The first version
      // let this escape, stranding an aborted transaction and hanging the drill.
      isolationError = (e as Error).message;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.query('RESET ROLE').catch(() => undefined);
    }

    if (isolationError) {
      checks.push({
        name: 'isolation actually works after restore',
        ok: false,
        detail: `app_role could not read at all: ${isolationError}. GRANTs are missing from the restore.`,
      });
      return checks;
    }

    const repView = { n: String(repCount) };
    checks.push({
      name: 'isolation actually works after restore',
      ok: Number(repView.n) < Number(ownerView!.n),
      detail: Number(repView.n) < Number(ownerView!.n)
        ? `owner sees ${ownerView!.n} leads, the rep sees ${repView.n}`
        : `owner ${ownerView!.n}, rep ${repView.n} — equal counts mean isolation is broken ` +
          `OR the restored data has no cross-rep leads. Either way this proves nothing.`,
    });
  }

  return checks;
}

const indent = (text: string): string => text.split('\n').map((l) => `     ${l}`).join('\n');

main().catch((e: unknown) => {
  console.error(`\nrestore drill failed:\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
