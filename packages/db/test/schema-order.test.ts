import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SQL IS ORDER-DEPENDENT AND THE FILE IS 700 LINES LONG.
 *
 * `db/schema.sql` is authoritative (CLAUDE.md §3) and is applied top to bottom in
 * one transaction. An index written above the table it indexes is a hard error on
 * an empty database — and on no other kind.
 *
 * That is what makes it dangerous. Every database anyone here touches was
 * migrated months ago and already has the table, so the statement succeeds, the
 * developer sees "migrate: ok", and the defect is invisible until someone builds
 * from nothing: a new environment, a restore drill, a fresh CI run, or the
 * disaster this project keeps rehearsing for.
 *
 * Two of these were introduced during the performance pass, both by scripts that
 * inserted an index near a related index rather than near its table. Neither was
 * caught by 681 tests, and the first attempt to bootstrap a database from empty
 * hit both within a minute.
 *
 * The RLS CI job now builds from empty on every push, which catches this too. It
 * needs a live Postgres and forty seconds. This is a text scan and needs neither,
 * so it fails in the right place: next to the edit that caused it.
 */

const schemaPath = fileURLToPath(new URL('../../../db/schema.sql', import.meta.url));
const schema = readFileSync(schemaPath, 'utf8');
const lines = schema.split('\n');

/**
 * All three files migrate applies, in order, inside ONE transaction. They share a
 * single object namespace, so duplicate-name checks have to look at them together.
 */
const APPLIED_FILES: Record<string, string> = {
  'db/schema.sql': schema,
  'db/rls-policies.sql': readFileSync(
    fileURLToPath(new URL('../../../db/rls-policies.sql', import.meta.url)),
    'utf8',
  ),
  'packages/metrics/sql/views.sql': readFileSync(
    fileURLToPath(new URL('../../metrics/sql/views.sql', import.meta.url)),
    'utf8',
  ),
};

interface Ref {
  readonly line: number;
  readonly kind: string;
  readonly name: string;
  readonly table: string;
}

function analyse() {
  const created = new Map<string, number>();
  const refs: Ref[] = [];

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    const table = /^\s*CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/.exec(line);
    if (table && !created.has(table[1]!)) created.set(table[1]!, lineNo);

    const index = /^\s*CREATE (?:UNIQUE )?INDEX (\w+)\s+ON\s+"?(\w+)"?/.exec(line);
    if (index) refs.push({ line: lineNo, kind: 'INDEX', name: index[1]!, table: index[2]! });

    const alter = /^\s*ALTER TABLE (?:ONLY )?"?(\w+)"?/.exec(line);
    if (alter) refs.push({ line: lineNo, kind: 'ALTER', name: '', table: alter[1]! });

    const trigger = /^\s*CREATE TRIGGER (\w+)/.exec(line);
    if (trigger) {
      // The target may be on the same line or the next one or two.
      const target = /\bON\s+"?(\w+)"?/.exec(lines.slice(i, i + 3).join(' '));
      if (target) refs.push({ line: lineNo, kind: 'TRIGGER', name: trigger[1]!, table: target[1]! });
    }
  });

  return { created, refs };
}

describe('db/schema.sql applies top to bottom', () => {
  const { created, refs } = analyse();

  it('the scan actually parses the file — otherwise "no problems" means nothing', () => {
    // Every assertion below is "nothing was found". If the regexes stop matching,
    // nothing is found no matter what the file says, and this test file becomes a
    // 100-line no-op that reports success. Anchor it to structure that must exist.
    expect(created.size).toBeGreaterThan(25);
    expect(refs.length).toBeGreaterThan(20);
    expect(created.has('order_status_event')).toBe(true);
    expect(created.has('attribution_ledger')).toBe(true);
  });

  it('no index, trigger or ALTER references a table created later in the file', () => {
    const forward = refs
      .filter((r) => {
        const at = created.get(r.table);
        return at !== undefined && at > r.line;
      })
      .map((r) => `  line ${r.line}: ${r.kind} ${r.name} -> ${r.table} (created at line ${created.get(r.table)})`);

    expect(
      forward.join('\n'),
      'These statements come BEFORE the table they act on. Postgres accepts this only ' +
        'on a database that already has the table, so it will pass locally and fail on ' +
        'any fresh bootstrap — a new environment, a restore, or the RLS CI job.',
    ).toBe('');
  });

  it('every table the RLS policy file secures is actually created here', () => {
    // A policy on a table that does not exist fails the same way, one file later,
    // and rls-policies.sql is applied straight after this one.
    const policyPath = fileURLToPath(new URL('../../../db/rls-policies.sql', import.meta.url));
    const policies = readFileSync(policyPath, 'utf8');

    // Two forms. Most tables are secured by a literal ALTER; the admin-only group
    // is secured inside a FOREACH over an array of names, which a naive scan for
    // ALTER TABLE misses entirely — it found 14 of 29 and quietly said fine.
    //
    // Comments are stripped FIRST because one of them contains "colleague's", and
    // an apostrophe inside a comment derails any scan for 'quoted' identifiers.
    const withoutComments = policies.replace(/--[^\n]*/g, '');

    const secured = new Set(
      [...withoutComments.matchAll(/ALTER TABLE\s+"?(\w+)"?\s+ENABLE ROW LEVEL SECURITY/gi)].map((m) => m[1]!),
    );
    for (const block of withoutComments.matchAll(/FOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\[([^\]]+)\]/gi)) {
      for (const name of block[1]!.matchAll(/'(\w+)'/g)) secured.add(name[1]!);
    }

    // 29 tables are secured today. Asserting a floor near that number means the
    // parser cannot silently degrade to matching one form and still pass.
    expect(secured.size, `only found ${secured.size} secured tables — the scan is missing a form`).toBeGreaterThanOrEqual(
      25,
    );

    const missing = [...secured].filter((t) => !created.has(t));
    expect(missing, `rls-policies.sql secures tables that db/schema.sql never creates: ${missing.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('no SQL object is defined twice', () => {
  /**
   * A CREATE INDEX whose name already exists is a hard error, and migrate applies
   * all three files in one transaction — so a duplicate anywhere fails the entire
   * bootstrap.
   *
   * THIS CHECK EXISTS BECAUSE IT CAUGHT A REAL ONE, minutes after being needed.
   * Adding a unique index to mv_rto_analysis produced a SECOND definition of
   * `ux_mv_rto_analysis`: the existing one spanned two lines and the grep used to
   * look for it only matched single-line definitions, so it reported the index as
   * absent. It would have passed every other test here, worked locally against a
   * database that already had the index, and failed only on a fresh build.
   *
   * The lesson is the same one as the forward references: a check that reads SQL
   * line-by-line is blind to anything wrapped across lines.
   */
  it('no index name is created twice across the three applied files', () => {
    const seen = new Map<string, string[]>();
    for (const [file, sql] of Object.entries(APPLIED_FILES)) {
      // Match only the NAME. Multi-line definitions are normal, so the ON clause
      // is deliberately not part of the pattern — requiring it is what made the
      // original grep miss a definition that was right there.
      for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)) {
        const name = m[1]!;
        seen.set(name, [...(seen.get(name) ?? []), file]);
      }
    }

    expect(seen.size, 'no CREATE INDEX found at all — the scan is broken').toBeGreaterThan(20);

    const duplicated = [...seen.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([name, where]) => `  ${name} defined ${where.length}x (${where.join(', ')})`);

    expect(
      duplicated.join('\n'),
      'Duplicate index names. migrate applies all three files in one transaction, so this ' +
        'fails the whole bootstrap on any database that does not already have the index.',
    ).toBe('');
  });

  it('no materialised view is created twice', () => {
    const names = [
      ...APPLIED_FILES['packages/metrics/sql/views.sql']!.matchAll(
        /CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF NOT EXISTS\s+)?(\w+)/gi,
      ),
    ].map((m) => m[1]!);

    expect(names.length, 'no matviews found — the scan is broken').toBeGreaterThan(3);
    expect(new Set(names).size, `duplicate matview among: ${names.join(', ')}`).toBe(names.length);
  });

  it('every matview has a unique index, so every refresh can be CONCURRENT', () => {
    // A matview without one can only be refreshed with an ACCESS EXCLUSIVE lock,
    // which blocks every report reading it. Worth knowing at edit time rather than
    // from a production stall, and it is the reason refresh_certified_views()
    // reports which views it could not refresh concurrently.
    const views = APPLIED_FILES['packages/metrics/sql/views.sql']!;
    const matviews = [...views.matchAll(/CREATE\s+MATERIALIZED\s+VIEW\s+(\w+)/gi)].map((m) => m[1]!);
    const indexed = new Set(
      [...views.matchAll(/CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+(\w+)/gis)].map((m) => m[1]!),
    );

    const unindexed = matviews.filter((v) => !indexed.has(v));
    expect(unindexed, `matviews with no unique index (refresh will block readers): ${unindexed.join(', ')}`).toEqual(
      [],
    );
  });
});
