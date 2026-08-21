import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALL_ENUMS, PG_ENUM_NAMES } from '../src/enums.js';

/**
 * db/schema.sql is authoritative (CLAUDE.md section 3). If someone adds a value
 * to a Postgres enum and forgets packages/shared, the API and web will silently
 * disagree with the database. This test makes that impossible.
 *
 * Same guardrail shape as the metric-registry parity test.
 */

const schemaSql = readFileSync(
  fileURLToPath(new URL('../../../db/schema.sql', import.meta.url)),
  'utf8',
);

/** Parse `CREATE TYPE <name> AS ENUM ('A','B', ...);` including multi-line ones. */
function parsePgEnums(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /CREATE TYPE\s+(\w+)\s+AS ENUM\s*\(([\s\S]*?)\);/g;
  for (const m of sql.matchAll(re)) {
    const [, name, body] = m;
    if (!name || !body) continue;
    out.set(name, [...body.matchAll(/'([^']+)'/g)].map((v) => v[1] as string));
  }
  return out;
}

const pgEnums = parsePgEnums(schemaSql);

describe('Postgres enums <-> packages/shared', () => {
  it('parses every CREATE TYPE in db/schema.sql', () => {
    const declared = (schemaSql.match(/^CREATE TYPE/gm) ?? []).length;
    expect(pgEnums.size).toBe(declared);
    expect(pgEnums.size).toBeGreaterThan(0);
  });

  it('has a TypeScript mirror for every Postgres enum', () => {
    const mirrored = new Set(Object.values(PG_ENUM_NAMES));
    const missing = [...pgEnums.keys()].filter((n) => !mirrored.has(n as never));
    expect(missing, `Postgres enums with no mirror in packages/shared: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('has a Postgres enum for every TypeScript mirror', () => {
    const orphans = Object.entries(PG_ENUM_NAMES)
      .filter(([, pgName]) => !pgEnums.has(pgName))
      .map(([tsName, pgName]) => `${tsName} -> ${pgName}`);
    expect(orphans, `TS enums with no Postgres type: ${orphans.join(', ')}`).toEqual([]);
  });

  it.each(Object.entries(PG_ENUM_NAMES))(
    '%s matches Postgres type %s value-for-value',
    (tsName, pgName) => {
      const pgValues = pgEnums.get(pgName);
      expect(pgValues, `no CREATE TYPE ${pgName} in db/schema.sql`).toBeDefined();
      const tsValues = Object.values(ALL_ENUMS[tsName as keyof typeof ALL_ENUMS]);
      expect([...(tsValues as string[])].sort()).toEqual([...(pgValues as string[])].sort());
    },
  );
});
