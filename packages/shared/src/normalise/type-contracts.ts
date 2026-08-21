import { normaliseDate, normalisePhone } from './index.js';

/**
 * Per-target-field type contracts (defect B10, decision O-12).
 *
 * The column-shift detector is only as deep as these contracts. Without them it
 * watches one column: `Order Status` is an enum so a customer name fails it
 * loudly, but a PIN code dropped into a free-text `Client Category` passes
 * everything and the shift goes unnoticed — which is exactly how F3 survived for
 * months in the client's files.
 *
 * So every mapped target field declares what it is, and free-text fields — which
 * cannot fail a type check by definition — get a heuristic instead.
 */

export type ContractKind =
  | 'PHONE'
  | 'PINCODE'
  | 'AWB'
  | 'ENUM'
  | 'DATE'
  | 'MONEY'
  | 'INTEGER'
  | 'FREE_TEXT';

export interface TypeContract {
  readonly kind: ContractKind;
  /** ENUM only: the closed set of permitted values, lowercased. */
  readonly allowed?: readonly string[];
  /** MONEY / INTEGER: sanity bounds. Outside them is a failure, not a warning. */
  readonly min?: number;
  readonly max?: number;
  /** DATE: the source's configured reading order. */
  readonly locale?: 'DMY' | 'MDY' | 'YMD';
}

/** Indian PIN codes are 6 digits and never start with 0 or 9. */
const PINCODE_RE = /^[1-8]\d{5}$/;
/** Courier AWBs are numeric and sit in a length band. Delhivery/Xpressbees are 9-16. */
const AWB_RE = /^\d{9,16}$/;
const MONEY_RE = /^-?\d{1,10}(\.\d{1,2})?$/;

const clean = (v: unknown): string => String(v ?? '').trim();

/**
 * Does one value satisfy its column's contract?
 *
 * FREE_TEXT always passes — that is what makes it free text, and why the
 * heuristic below exists separately.
 */
export function satisfiesContract(
  value: unknown,
  contract: TypeContract,
  todayIso: string,
): boolean {
  const v = clean(value);
  if (v === '') return true; // empty is a completeness question, not a type question

  switch (contract.kind) {
    case 'PHONE':
      return normalisePhone(v).ok;
    case 'PINCODE':
      return PINCODE_RE.test(v.replace(/\s/g, ''));
    case 'AWB':
      return AWB_RE.test(v.replace(/\s/g, ''));
    case 'ENUM':
      return (contract.allowed ?? []).includes(v.toLowerCase());
    case 'DATE':
      return normaliseDate(v, contract.locale ?? 'DMY', todayIso).ok;
    case 'MONEY': {
      if (!MONEY_RE.test(v.replace(/,/g, ''))) return false;
      const n = Number(v.replace(/,/g, ''));
      if (contract.min !== undefined && n < contract.min) return false;
      if (contract.max !== undefined && n > contract.max) return false;
      return true;
    }
    case 'INTEGER': {
      if (!/^-?\d+$/.test(v)) return false;
      const n = Number(v);
      if (contract.min !== undefined && n < contract.min) return false;
      if (contract.max !== undefined && n > contract.max) return false;
      return true;
    }
    case 'FREE_TEXT':
      return true;
  }
}

/**
 * The heuristic for FREE_TEXT columns.
 *
 * A free-text column cannot fail a type check, so shift into one is invisible to
 * the ordinary detector. What IS visible is a free-text column that suddenly
 * looks structured: `Client Category` holding "247232" and "440023" is not a
 * category, it is a PIN code column that slid one place left.
 *
 * Returns the proportion of non-empty values that look like structured data.
 */
export function structuredLookAlikeRatio(values: readonly unknown[]): number {
  const nonEmpty = values.map(clean).filter((v) => v !== '');
  if (nonEmpty.length === 0) return 0;

  const structured = nonEmpty.filter(
    (v) =>
      PINCODE_RE.test(v) || // a PIN code
      AWB_RE.test(v) || // an AWB
      normalisePhone(v).ok || // a phone number
      /^\d+(\.\d+)?$/.test(v), // any bare number
  );
  return structured.length / nonEmpty.length;
}

/**
 * A genuine category column is words. Above this proportion of number-shaped
 * values, something has shifted.
 *
 * Deliberately loose: a real category column occasionally holds "2 Pack" or a
 * size, and crying shift on a legitimate file costs an admin their morning. The
 * strict enum and typed columns are the primary signal; this is the backstop for
 * the columns that would otherwise be blind. (Tier 2)
 */
export const FREE_TEXT_STRUCTURED_THRESHOLD = 0.6;
