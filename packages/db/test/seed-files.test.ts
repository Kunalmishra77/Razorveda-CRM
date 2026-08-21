import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asPipeList, parseCsv } from '../src/csv.js';

/**
 * Phase 0 exit criterion 7 ("Masters loaded: 7 product lines, 20 SKUs, 13 users,
 * 9 sources, 19 dispositions, 64 aliases") is usually proved by querying a live
 * database. Most of it can be proved from the files alone, which means it holds
 * before Docker exists and it fails the moment someone edits a seed file without
 * updating the criterion.
 *
 * The referential checks matter more than the counts: an alias pointing at a
 * disposition_code that does not exist, or a SKU pointing at a missing line_code,
 * would abort the seed transaction halfway. Better to know here.
 */

const read = (n: string) =>
  parseCsv(readFileSync(fileURLToPath(new URL(`../../../db/seed/${n}`, import.meta.url)), 'utf8'));

const lines = read('product_lines.csv');
const skus = read('skus.csv');
const employees = read('employees.csv');
const sources = read('lead_sources.csv');
const dispositions = read('dispositions.csv');
const aliases = read('disposition_aliases.csv');
const slabs = read('incentive_slabs.csv');

describe('seed files — phase 0 exit criterion 7', () => {
  it('has the expected row counts', () => {
    expect({
      productLines: lines.length,
      skus: skus.length,
      users: employees.length,
      sources: sources.length,
      dispositions: dispositions.length,
      aliases: aliases.length,
    }).toEqual({
      productLines: 7, skus: 20, users: 13, sources: 9, dispositions: 19, aliases: 64,
    });
  });

  it('splits the 13 users into 1 OWNER, 3 ADMIN and 9 EMPLOYEE', () => {
    const byRole = employees.reduce<Record<string, number>>((acc, r) => {
      const k = r['role'] ?? '?';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    expect(byRole).toEqual({ OWNER: 1, ADMIN: 3, EMPLOYEE: 9 });
  });

  it('keeps Megha ON_LEAVE — she powers the "rep on leave" assignment warning (D-19)', () => {
    const megha = employees.find((r) => r['full_name'] === 'Megha');
    expect(megha?.['status']).toBe('ON_LEAVE');
  });

  it('covers all seven product lines from the brief', () => {
    expect(lines.map((r) => r['code']).sort()).toEqual([
      'BREAST_CARE', 'CUSTOMISATION', 'FACE_CARE', 'HAIR_CARE',
      'INTIMATE_CARE', 'SKINWISE', 'SLIMMING_CARE',
    ]);
  });

  it('covers all nine lead sources from docs/06', () => {
    expect(sources.map((r) => r['code']).sort()).toEqual([
      'ADD_TO_CART', 'DELIVERED_REPEAT', 'META_ADS', 'NC_REFUSED', 'RTO_RECOVERY',
      'SHOPIFY', 'WA_CAMPAIGN', 'WEB_CALL', 'WEB_WHATSAPP',
    ]);
  });
});

describe('seed files — referential integrity', () => {
  it('every sku.line_code resolves to a product line', () => {
    const known = new Set(lines.map((r) => r['code']));
    const orphans = skus.filter((r) => !known.has(r['line_code'])).map((r) => r['sku_code']);
    expect(orphans, `SKUs with an unknown line_code: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every alias resolves to a disposition (D-20)', () => {
    // D-20 replaced the untestable "all 49 client variants map" with this.
    const known = new Set(dispositions.map((r) => r['code']));
    const orphans = aliases
      .filter((r) => !known.has(r['disposition_code']))
      .map((r) => `${r['disposition_code']} -> ${r['alias']}`);
    expect(orphans, `aliases with an unknown disposition_code: ${orphans.join(', ')}`).toEqual([]);
  });

  it('has no duplicate aliases — the alias column is UNIQUE in the schema', () => {
    const seen = aliases.map((r) => (r['alias'] ?? '').toLowerCase());
    const dupes = seen.filter((a, i) => seen.indexOf(a) !== i);
    expect(dupes, `duplicate aliases would violate the UNIQUE index: ${dupes.join(', ')}`)
      .toEqual([]);
  });

  it('has unique emp_codes and emails', () => {
    const codes = employees.map((r) => r['emp_code']);
    const emails = employees.map((r) => r['email']);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it('every disposition requiring a follow-up date is non-terminal', () => {
    // A terminal disposition that demands a follow-up date would block save on a
    // lead that is already closed (docs/07 section 4).
    const contradictory = dispositions
      .filter((r) => r['requires_followup_date'] === 'true' && r['is_terminal'] === 'true')
      .map((r) => r['code']);
    expect(contradictory).toEqual([]);
  });
});

describe('seed files — parsing the awkward columns', () => {
  it('reads pipe-delimited name_aliases out of a quoted field', () => {
    const bc014 = skus.find((r) => r['sku_code'] === 'BC-014');
    expect(asPipeList(bc014?.['name_aliases'])).toEqual([
      'Mamo Firm Cream', 'MAMO FIRM', 'Mamo firm cream', 'mamofirm cream',
    ]);
  });

  it('treats an empty shopify_base_price as NULL, not zero', () => {
    // A zero base price would silently credit the rep with the whole order value,
    // which is exactly the F7 leak we are here to close.
    const bc015 = skus.find((r) => r['sku_code'] === 'BC-015');
    expect(bc015?.['shopify_base_price']).toBe('');
  });

  it('carries the reverse-engineered base prices pending O-02', () => {
    const priced = skus.filter((r) => r['shopify_base_price'] !== '');
    expect(priced.length).toBeGreaterThan(0);
    // The clusters the audit observed in the client's order data.
    for (const r of priced) {
      expect(['899', '849', '949', '799']).toContain(r['shopify_base_price']);
    }
  });

  it('leaves the open-ended top incentive slab with no max_value', () => {
    const top = slabs.at(-1);
    expect(top?.['max_value']).toBe('');
    expect(top?.['percent']).toBe('4.0');
  });
});
