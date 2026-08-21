import { z } from 'zod';

/**
 * Shared primitive schemas. Every one of these encodes a rule from docs/, not a
 * generic validation preference. Cite the rule when you change one.
 */

/** Turn a const-object enum into a Zod enum without losing the literal union type. */
export const pgEnum = <T extends Record<string, string>>(obj: T) =>
  z.enum(Object.values(obj) as [T[keyof T], ...T[keyof T][]]);

export const uuidSchema = z.string().uuid();

/**
 * Money. numeric(12,2) in Postgres — docs/02: "Never float. Never integer paise."
 * Carried as a string across the wire so no JS float ever touches a rupee value.
 */
export const moneySchema = z
  .string()
  .regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'money must be a decimal string with at most 2 dp');

/**
 * Indian mobile, post-normalisation. docs/06 section 3 normalisePhone():
 * exactly 10 digits, first digit 6-9. Anything else parks the row (F2).
 * This validates the OUTPUT of normalisation, never raw file input.
 */
export const phoneSchema = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'phone must be 10 digits starting 6, 7, 8 or 9');

/** 6 digits, and India has no PIN starting 0. */
export const pincodeSchema = z
  .string()
  .regex(/^[1-9]\d{5}$/, 'pincode must be 6 digits not starting with 0');

/** Calendar date, no time. Columns named *_date. */
export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** period_key on the attribution ledger. Cash-basis month (D-13). */
export const periodKeySchema = z.string().regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM');

/** SHA-256 of the raw uploaded bytes. UNIQUE — refuses duplicate files (docs/06 stage 1). */
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase sha-256 hex');

/** 0.0000-1.0000, e.g. expected_conversion_rate, prepaid_ratio, rto_pct. */
export const ratioSchema = z.number().min(0).max(1);

/** EMPLOYEE role is capped at 50 rows per page (docs/05, anti-exfiltration). */
export const EMPLOYEE_MAX_PAGE_SIZE = 50;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

/** Percentages on order_credit_split must sum to exactly 100 (docs/03 section 4). */
export const percentSchema = z
  .number()
  .min(0)
  .max(100)
  .refine((n) => Number.isInteger(n * 100), 'percent may carry at most 2 decimal places');
