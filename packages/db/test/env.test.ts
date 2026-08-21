import { describe, it, expect } from 'vitest';
import { assertLocalTarget, parseDatabaseUrl } from '../src/env.js';

/**
 * D-17 is only worth something if it is mechanical. These tests assert that the
 * guard actually refuses the real Coolify shape, using the deploy target's own
 * port so a copy-pasted URL cannot quietly slip past.
 */

const LOCAL = 'postgresql://razorveda_migrator:localdev@localhost:5432/razorveda';
const COOLIFY_TAILSCALE = 'postgresql://razorbill_crm:pw@127.0.0.1:55432/razorbill_crm';
const COOLIFY_INTERNAL = 'postgresql://razorbill_crm:pw@w04cscwsccsc880sc488cscg:5432/razorbill_crm';

describe('parseDatabaseUrl', () => {
  it('pulls apart a local URL', () => {
    const t = parseDatabaseUrl(LOCAL);
    expect(t).toMatchObject({
      host: 'localhost', port: 5432, database: 'razorveda',
      user: 'razorveda_migrator', isLocal: true,
    });
  });

  it('defaults the port to 5432 when absent', () => {
    expect(parseDatabaseUrl('postgresql://u:p@localhost/db').port).toBe(5432);
  });

  it('accepts both postgresql:// and postgres://', () => {
    expect(parseDatabaseUrl('postgres://u:p@localhost/db').isLocal).toBe(true);
  });

  it('rejects a non-postgres URL', () => {
    expect(() => parseDatabaseUrl('mysql://u:p@localhost/db')).toThrow(/must be a postgresql/);
    expect(() => parseDatabaseUrl('not a url')).toThrow(/not a valid URL/);
  });
});

describe('assertLocalTarget — the D-17 guard', () => {
  it('allows local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', 'postgres', 'razorveda-postgres']) {
      const t = parseDatabaseUrl(`postgresql://u:p@${h}:5432/db`);
      expect(() => assertLocalTarget(t, 'migrate')).not.toThrow();
    }
  });

  it("refuses the Coolify internal hostname", () => {
    const t = parseDatabaseUrl(COOLIFY_INTERNAL);
    expect(t.isLocal).toBe(false);
    expect(() => assertLocalTarget(t, 'seed')).toThrow(/REFUSING to run "seed"/);
    expect(() => assertLocalTarget(t, 'seed')).toThrow(/D-17/);
  });

  it('names the host, database and user so the operator can see what they nearly hit', () => {
    const t = parseDatabaseUrl(COOLIFY_INTERNAL);
    try {
      assertLocalTarget(t, 'migrate');
      expect.unreachable('guard should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('w04cscwsccsc880sc488cscg');
      expect(msg).toContain('razorbill_crm');
    }
  });

  it('ALLOWS 127.0.0.1:55432 — and that is a deliberate, documented hole', () => {
    // The Tailscale form of the Coolify URL is loopback, so host-matching cannot
    // distinguish it from local Postgres. Anyone tunnelling the production
    // database to 127.0.0.1 has bypassed the guard by construction.
    //
    // This is asserted rather than left implicit so the limitation is visible in a
    // test run instead of being discovered afterwards. The real protections are
    // the compose file binding 5432 and DATABASE_URL living in .env, not this check.
    const t = parseDatabaseUrl(COOLIFY_TAILSCALE);
    expect(t.isLocal).toBe(true);
    expect(() => assertLocalTarget(t, 'migrate')).not.toThrow();
  });

  it('lets a reviewed production migration through only with the explicit override', () => {
    const t = parseDatabaseUrl(COOLIFY_INTERNAL);
    const key = 'RAZORVEDA_ALLOW_REMOTE_DDL';
    const prev = process.env[key];
    try {
      process.env[key] = 'yes';
      expect(() => assertLocalTarget(t, 'migrate')).toThrow(/REFUSING/);
      process.env[key] = 'i-understand';
      expect(() => assertLocalTarget(t, 'migrate')).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });
});
