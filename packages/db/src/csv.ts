/**
 * Minimal RFC-4180 CSV reader for the seed files.
 *
 * Deliberately hand-rolled and tiny: db/seed/*.csv are files we control, and the
 * messy client data goes through the Phase 2 ingestion pipeline, not this. Adding
 * a parser dependency here would blur that line.
 *
 * Handles quoted fields, embedded commas and doubled quotes — skus.csv needs all
 * three for its pipe-delimited name_aliases column.
 */

export type CsvRow = Readonly<Record<string, string>>;

export function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  const src = text.replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const header = nonEmpty.shift();
  if (!header) return [];

  const keys = header.map((h) => h.trim());
  return nonEmpty.map((r) => {
    const obj: Record<string, string> = {};
    keys.forEach((k, idx) => {
      obj[k] = (r[idx] ?? '').trim();
    });
    return obj;
  });
}

/** Empty string means NULL in the seed files, not the empty string. */
export const orNull = (v: string | undefined): string | null =>
  v === undefined || v === '' ? null : v;

export const asNumber = (v: string | undefined): number | null => {
  const s = orNull(v);
  if (s === null) return null;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`expected a number, got "${s}"`);
  return n;
};

export const asBool = (v: string | undefined): boolean =>
  (orNull(v) ?? 'false').toLowerCase() === 'true';

/** skus.csv encodes name_aliases as a pipe-delimited list inside one quoted field. */
export const asPipeList = (v: string | undefined): string[] => {
  const s = orNull(v);
  return s === null ? [] : s.split('|').map((x) => x.trim()).filter(Boolean);
};
