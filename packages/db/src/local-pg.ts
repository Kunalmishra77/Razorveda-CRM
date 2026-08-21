import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local PostgreSQL 16 without Docker.
 *
 * D-79 supersedes the Docker half of D-17. The client's machine does not run
 * Docker Desktop and will not — it slows the machine down, which is a legitimate
 * reason and not one worth arguing with. Coolify still runs Docker in production;
 * this only changes how a developer gets a database on their own laptop.
 *
 * These are the REAL PostgreSQL binaries, shipped as an npm package, run under a
 * data directory inside the repo. Not an emulator, not a mock, not pg-mem: RLS,
 * FORCE ROW LEVEL SECURITY, roles, triggers and pgcrypto all behave exactly as
 * they do in production, which is the whole point — the one thing in this system
 * that fails silently is the one thing that must not be tested against a
 * lookalike.
 *
 * Version is pinned to 16 to match the Coolify target rather than taking the
 * latest, so dev and prod cannot drift apart underneath us.
 */

const BIN = resolve(
  fileURLToPath(new URL('../../../node_modules/@embedded-postgres/windows-x64/native/bin', import.meta.url)),
);
const DATA_DIR = resolve(fileURLToPath(new URL('../../../.pgdata', import.meta.url)));
const LOG_FILE = join(DATA_DIR, 'postgres.log');
const PW_FILE = join(DATA_DIR, '..', '.pgpass-init');

export const LOCAL_PG_PORT = Number(process.env['LOCAL_PG_PORT'] ?? 5433);
/** Superuser. Owns the tables, so it is also the migration user. */
export const SUPERUSER = 'razorveda_migrator';
export const SUPERUSER_PASSWORD = 'localdev';
export const DATABASE = 'razorveda';

const exe = (name: string): string => join(BIN, `${name}.exe`);

function run(cmd: string, args: string[], label: string): void {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    throw new Error(
      `${label} failed (exit ${r.status})\n${(r.stdout ?? '').trim()}\n${(r.stderr ?? '').trim()}`,
    );
  }
}

export const isInitialised = (): boolean => existsSync(join(DATA_DIR, 'PG_VERSION'));

/** `initdb` once. Idempotent. */
export function initialise(): void {
  if (isInitialised()) return;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PW_FILE, SUPERUSER_PASSWORD, 'utf8');
  try {
    run(
      exe('initdb'),
      [
        '-D', DATA_DIR,
        '-U', SUPERUSER,
        '--pwfile', PW_FILE,
        '--encoding=UTF8',
        '--locale=C',
        '--auth-local=trust',
        '--auth-host=scram-sha-256',
      ],
      'initdb',
    );
  } finally {
    rmSync(PW_FILE, { force: true });
  }
}

/**
 * `pg_ctl -w start` does not return on Windows — it holds the console handle open
 * and the caller hangs forever. Found by running it. Start without -w and poll
 * `pg_ctl status` instead, which is what -w was buying us anyway.
 */
export function start(timeoutMs = 30_000): void {
  initialise();
  if (isRunning()) return;

  // postgres.exe directly, NOT via pg_ctl. Three Windows problems, all found by
  // running it rather than by reading:
  //
  //   1. spawnSync inherits stdio and the server holds those pipes open forever,
  //      so the call blocks on an EOF that never comes.
  //   2. spawnSync cannot truly detach: the server died when node exited.
  //   3. pg_ctl passes its CONSOLE to the server it launches, so any Ctrl-C in
  //      that console kills the database — including the one a `timeout` wrapper
  //      sends. The log shows exit 0xC000013A, STATUS_CONTROL_C_EXIT, killing a
  //      CREATE DATABASE mid-flight.
  //
  // `detached: true` on Windows gives the child DETACHED_PROCESS: no console, so
  // no console signal can reach it. Output goes straight to the log file.
  mkdirSync(DATA_DIR, { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(
    exe('postgres'),
    ['-D', DATA_DIR, '-p', String(LOCAL_PG_PORT), '-c', 'listen_addresses=127.0.0.1'],
    { detached: true, stdio: ['ignore', log, log], windowsHide: true },
  );
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Sync poll keeps `pg:start && db:migrate` working as an ordinary shell chain.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    if (isRunning() && acceptsConnections()) return;
  }
  throw new Error(`postgres did not come up within ${timeoutMs / 1000}s. Check ${LOG_FILE}.`);
}

/**
 * `pg_ctl status` reports success as soon as postmaster.pid exists, which is
 * before the server accepts clients. Connecting one tick too early gives
 * ECONNRESET, so readiness is a real handshake, not a pid file.
 */
function acceptsConnections(): boolean {
  const r = spawnSync(
    process.execPath,
    ['-e', `const n=require('net');const s=n.createConnection({host:'127.0.0.1',port:${LOCAL_PG_PORT}});s.setTimeout(1500);s.on('connect',()=>{const b=Buffer.alloc(8);b.writeInt32BE(8,0);b.writeInt32BE(80877103,4);s.write(b)});s.on('data',()=>{s.end();process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));`],
    { encoding: 'utf8', windowsHide: true, timeout: 4000 },
  );
  return r.status === 0;
}

export function stop(): void {
  if (!isInitialised() || !isRunning()) return;
  run(exe('pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', '-w', 'stop'], 'pg_ctl stop');
}

export function isRunning(): boolean {
  if (!isInitialised()) return false;
  const r = spawnSync(exe('pg_ctl'), ['-D', DATA_DIR, 'status'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

/** Wipes the cluster entirely. Only ever touches the repo-local data directory. */
export function destroy(): void {
  stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
}

export const superuserUrl = (db = 'postgres'): string =>
  `postgresql://${SUPERUSER}:${SUPERUSER_PASSWORD}@127.0.0.1:${LOCAL_PG_PORT}/${db}`;

export const appUrl = (user = 'razorveda_app', password = 'localdev'): string =>
  `postgresql://${user}:${password}@127.0.0.1:${LOCAL_PG_PORT}/${DATABASE}`;

async function main(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case 'start': {
      start();
      console.log(`postgres 16 up on 127.0.0.1:${LOCAL_PG_PORT} (data: .pgdata)`);
      console.log(`  DATABASE_URL=${superuserUrl(DATABASE)}`);
      console.log(`  DATABASE_URL_APP=${appUrl()}`);
      break;
    }
    case 'stop':
      stop();
      console.log('postgres stopped');
      break;
    case 'status':
      console.log(isRunning() ? 'running' : 'stopped');
      break;
    case 'destroy':
      destroy();
      console.log('cluster destroyed');
      break;
    default:
      console.log('usage: local-pg <start|stop|status|destroy>');
      process.exitCode = 1;
  }
}

if (process.argv[1]?.includes('local-pg')) {
  main().catch((e: unknown) => {
    console.error(`local-pg failed:\n${(e as Error).message}`);
    process.exitCode = 1;
  });
}
