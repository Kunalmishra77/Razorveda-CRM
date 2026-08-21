import { normaliseDate, normalisePhone, parsePayment } from '../normalise/index.js';

/**
 * Row-level validation (docs/06 stage 5).
 *
 * Produces a status and a list of reasons. It never repairs and never guesses —
 * a row it cannot read becomes an exception for a human, because the admin
 * reviewing ~26 rows on a 500-row day is the entire design.
 */

export type RowStatus = 'VALID' | 'WARNING' | 'ERROR' | 'DUPLICATE' | 'PARKED';

export interface RowIssue {
  readonly field: string;
  readonly code: string;
  readonly message: string;
  readonly severity: Exclude<RowStatus, 'VALID'>;
}

export interface RowInput {
  readonly phone?: string | null;
  readonly altPhone?: string | null;
  readonly name?: string | null;
  readonly date?: string | null;
  readonly amount?: string | null;
  readonly paymentMode?: string | null;
  readonly pincode?: string | null;
  readonly state?: string | null;
  readonly productText?: string | null;
}

export interface RowContext {
  /** Mandatory target fields for this source (docs/06 section 5). */
  readonly requiredFields: readonly (keyof RowInput)[];
  readonly dateLocale: 'DMY' | 'MDY' | 'YMD';
  readonly todayIso: string;
  /** `sku.mrp` for the resolved product, when one resolved. Drives value sanity. */
  readonly skuMrp?: string | null;
  /** Set by the caller after the in-batch and cross-batch duplicate checks. */
  readonly isDuplicate?: boolean;
}

export interface RowVerdict {
  readonly status: RowStatus;
  readonly issues: readonly RowIssue[];
  /** Normalised values, present whenever they could be read. */
  readonly normalised: {
    readonly phone: string | null;
    readonly date: string | null;
    readonly prepaidAmount: string | null;
    readonly codAmount: string | null;
  };
}

/**
 * Severity precedence, worst first.
 *
 * PARKED beats ERROR deliberately. A row with no usable phone AND a bad value is
 * un-keyable first: the admin's next action is to find a number, not to fix the
 * amount, and showing them the amount problem would send them down the wrong path.
 */
const PRECEDENCE: readonly RowStatus[] = ['PARKED', 'ERROR', 'DUPLICATE', 'WARNING', 'VALID'];

const worst = (statuses: readonly RowStatus[]): RowStatus =>
  PRECEDENCE.find((s) => statuses.includes(s)) ?? 'VALID';

/**
 * PIN prefix to state, for the consistency check.
 *
 * Reference data, not a business rule — geography does not change because an
 * admin wants it to. Deliberately partial: an unknown prefix produces NO opinion
 * rather than a false warning. This only ever raises a WARNING, so a gap here can
 * never block an import.
 */
const PIN_PREFIX_STATE: Readonly<Record<string, string>> = {
  11: 'delhi', 12: 'haryana', 13: 'haryana', 14: 'punjab', 15: 'punjab',
  16: 'punjab', 17: 'himachal pradesh', 18: 'jammu and kashmir', 19: 'jammu and kashmir',
  20: 'uttar pradesh', 21: 'uttar pradesh', 22: 'uttar pradesh', 23: 'uttar pradesh',
  24: 'uttar pradesh', 25: 'uttar pradesh', 26: 'uttar pradesh', 27: 'uttar pradesh',
  28: 'uttar pradesh', 30: 'rajasthan', 31: 'rajasthan', 32: 'rajasthan',
  33: 'rajasthan', 34: 'rajasthan', 36: 'gujarat', 37: 'gujarat', 38: 'gujarat',
  39: 'gujarat', 40: 'maharashtra', 41: 'maharashtra', 42: 'maharashtra',
  43: 'maharashtra', 44: 'maharashtra', 45: 'madhya pradesh', 46: 'madhya pradesh',
  47: 'madhya pradesh', 48: 'madhya pradesh', 49: 'chhattisgarh',
  50: 'telangana', 51: 'andhra pradesh', 52: 'andhra pradesh', 53: 'andhra pradesh',
  56: 'karnataka', 57: 'karnataka', 58: 'karnataka', 59: 'karnataka',
  60: 'tamil nadu', 61: 'tamil nadu', 62: 'tamil nadu', 63: 'tamil nadu',
  64: 'tamil nadu', 67: 'kerala', 68: 'kerala', 69: 'kerala',
  70: 'west bengal', 71: 'west bengal', 72: 'west bengal', 73: 'west bengal',
  74: 'west bengal', 75: 'odisha', 76: 'odisha', 77: 'odisha',
  78: 'assam', 79: 'arunachal pradesh', 80: 'bihar', 81: 'bihar', 82: 'bihar',
  83: 'jharkhand', 84: 'bihar', 85: 'bihar',
};

const norm = (s: string): string => s.trim().toLowerCase();

export function validateRow(input: RowInput, ctx: RowContext): RowVerdict {
  const issues: RowIssue[] = [];
  const statuses: RowStatus[] = [];

  // --- phone: the keyability question, asked first -------------------------
  const phoneResult = normalisePhone(input.phone);
  const phone = phoneResult.ok ? phoneResult.value : null;

  if (!phone && ctx.requiredFields.includes('phone')) {
    issues.push({
      field: 'phone',
      code: 'UNKEYABLE',
      severity: 'PARKED',
      message: phoneResult.ok
        ? 'No mobile number.'
        : `Cannot read a mobile number: ${phoneResult.reason}. Add a number or merge this into an existing customer.`,
    });
    statuses.push('PARKED');
  }

  // --- date ----------------------------------------------------------------
  let date: string | null = null;
  if (input.date != null && String(input.date).trim() !== '') {
    const d = normaliseDate(input.date, ctx.dateLocale, ctx.todayIso);
    if (d.ok) {
      date = d.value;
      if (d.warning) {
        issues.push({ field: 'date', code: 'AMBIGUOUS_DATE', severity: 'WARNING', message: d.warning });
        statuses.push('WARNING');
      }
    } else {
      issues.push({
        field: 'date',
        code: 'BAD_DATE',
        severity: 'ERROR',
        message: `${d.reason}. Correct the date in the file and upload again.`,
      });
      statuses.push('ERROR');
    }
  } else if (ctx.requiredFields.includes('date')) {
    issues.push({ field: 'date', code: 'MISSING', severity: 'ERROR', message: 'No date on this row.' });
    statuses.push('ERROR');
  }

  // --- value sanity --------------------------------------------------------
  const amount = input.amount == null ? null : Number(String(input.amount).replace(/,/g, ''));
  if (amount !== null && Number.isFinite(amount) && ctx.skuMrp != null) {
    const mrp = Number(ctx.skuMrp);
    if (mrp > 0 && amount > mrp * 10) {
      issues.push({
        field: 'amount',
        code: 'VALUE_SANITY',
        severity: 'ERROR',
        // A single mistyped zero on a ₹1,450 product becomes ₹14,500 of credit.
        message: `₹${amount} on a product with MRP ₹${mrp} is more than ten times the price. Check for a typo.`,
      });
      statuses.push('ERROR');
    }
  }
  if (amount !== null && !Number.isFinite(amount)) {
    issues.push({
      field: 'amount',
      code: 'BAD_AMOUNT',
      severity: 'ERROR',
      message: `"${String(input.amount)}" is not an amount.`,
    });
    statuses.push('ERROR');
  }

  // --- payment split -------------------------------------------------------
  let prepaidAmount: string | null = null;
  let codAmount: string | null = null;
  if (input.paymentMode != null && String(input.paymentMode).trim() !== '') {
    const p = parsePayment(input.paymentMode, amount !== null && Number.isFinite(amount) ? String(amount) : '0');
    prepaidAmount = p.prepaidAmount;
    codAmount = p.codAmount;
    if (p.warning) {
      issues.push({ field: 'paymentMode', code: 'PAYMENT_UNCLEAR', severity: 'WARNING', message: p.warning });
      statuses.push('WARNING');
    }
  }

  // --- pincode and state ---------------------------------------------------
  const pin = input.pincode == null ? '' : String(input.pincode).replace(/\s/g, '');
  if (pin !== '') {
    if (/^9\d{5}$/.test(pin)) {
      // A 9 prefix is the Army Postal Service, not a geographic zone. Rare, real,
      // and worth telling the admin about — many couriers will not deliver to an
      // APO address, so this is a dispatch problem waiting to happen rather than
      // a typo. Flagged, never rejected.
      issues.push({
        field: 'pincode',
        code: 'ARMY_POSTAL_PINCODE',
        severity: 'WARNING',
        message: `PIN ${pin} is an Army Postal Service address. Check the courier delivers there before dispatch.`,
      });
      statuses.push('WARNING');
    } else if (!/^[1-8]\d{5}$/.test(pin)) {
      issues.push({
        field: 'pincode',
        code: 'BAD_PINCODE',
        severity: 'WARNING',
        message: `"${pin}" is not a 6-digit Indian PIN code.`,
      });
      statuses.push('WARNING');
    } else if (input.state) {
      const expected = PIN_PREFIX_STATE[pin.slice(0, 2)];
      // No opinion on an unknown prefix — a false warning is worse than silence.
      if (expected && norm(input.state) !== expected) {
        issues.push({
          field: 'state',
          code: 'PIN_STATE_MISMATCH',
          severity: 'WARNING',
          message: `PIN ${pin} is in ${expected}, but the row says ${input.state}. One of them is wrong.`,
        });
        statuses.push('WARNING');
      }
    }
  }

  // --- other mandatory fields ---------------------------------------------
  for (const field of ctx.requiredFields) {
    if (field === 'phone' || field === 'date') continue; // handled above
    const value = input[field];
    if (value == null || String(value).trim() === '') {
      issues.push({
        field,
        code: 'MISSING',
        severity: 'ERROR',
        message: `${field} is required for this source but is empty.`,
      });
      statuses.push('ERROR');
    }
  }

  if (ctx.isDuplicate) {
    issues.push({
      field: 'row',
      code: 'DUPLICATE',
      severity: 'DUPLICATE',
      message: 'This looks like an order already recorded — same customer, product and value within 48 hours.',
    });
    statuses.push('DUPLICATE');
  }

  return {
    status: worst(statuses),
    issues,
    normalised: { phone, date, prepaidAmount, codAmount },
  };
}

/**
 * The admin sees ONLY these (docs/06 stage 6). Clean rows are never rendered —
 * that is the entire point, and what makes a 500-row day a 26-row review.
 */
export const EXCEPTION_STATUSES: readonly RowStatus[] = ['WARNING', 'ERROR', 'DUPLICATE', 'PARKED'];

export const isException = (status: RowStatus): boolean => EXCEPTION_STATUSES.includes(status);
