import { money } from '../money.js';

/**
 * Normalisation library (docs/06 section 3). Pure functions, no I/O, no AI.
 *
 * Every rule here exists because of a measured defect in the client's workbooks.
 * The governing principle: **park or flag, never guess.** A row that cannot be
 * read is kept for a human, because 236 of 2,159 real rows are un-keyable (F2)
 * and discarding them loses customers who exist.
 *
 * EVERY unicode range below is a \u escape, never a literal character. The first
 * version used literals and lost two of them silently: U+0080 is an invisible
 * control character, so its range collapsed and matched nothing, and a second
 * range accidentally spanned the whole ASCII block and deleted the space in
 * "Sahiba Khan". Escapes are reviewable; literals are not.
 */

// --- phone -----------------------------------------------------------------

export type PhoneResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/**
 * F2. The client's phone column contains `9876543210`, `+919876543210`,
 * `09876543210`, `9876543210.0` and the literal text `code`.
 *
 * Valid output is exactly 10 digits starting 6-9. Anything else parks the row.
 */
export function normalisePhone(raw: string | null | undefined): PhoneResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'no value' };

  // Excel coerces a phone column to float and renders 9876543210.0. Drop the
  // fractional part before stripping, or that trailing zero becomes an 11th digit.
  const withoutFloat = String(raw).trim().replace(/\.0+$/, '');
  let digits = withoutFloat.replace(/\D/g, '');

  if (digits === '') return { ok: false, reason: `no digits in ${JSON.stringify(String(raw))}` };

  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length !== 10) {
    return { ok: false, reason: `not 10 digits after normalising (got ${digits.length})` };
  }
  if (!/^[6-9]/.test(digits)) {
    return { ok: false, reason: `Indian mobiles start 6-9, got ${digits[0]}` };
  }
  return { ok: true, value: digits };
}

// --- encoding --------------------------------------------------------------

/**
 * A UTF-8 lead byte followed by a continuation byte, both rendered as Latin-1.
 * This is what `à¤®` looks like when Devanagari is read wrongly.
 */
export const MOJIBAKE_BYTES = /[À-ÿ][-¿]/;

/** Devanagari, Arabic, Bengali. Used to confirm a repair actually helped. */
const NON_LATIN_SCRIPT = /[ऀ-ॿ؀-ۿঀ-৿]/;

/**
 * Repairs UTF-8 bytes that were read as Latin-1.
 *
 * Repair, don't discard. These are real customer names, and dropping them would
 * quietly lose Hindi-speaking customers from the database.
 */
/**
 * Reverse of the CP1252 0x80-0x9F block.
 *
 * This is the part that matters, and it is not obvious. Mojibake produced on
 * Windows — which is all of it here — is UTF-8 read as **CP1252**, not Latin-1.
 * The two agree everywhere except 0x80-0x9F, where CP1252 has printable
 * characters and Latin-1 has controls.
 *
 * `मोहन` contains the byte 0x8B, which renders as U+2039. Recovering bytes with
 * `charCodeAt(0) & 0xff` turns U+2039 into 0x39, the digit "9", which corrupts
 * the UTF-8 sequence so the decode throws and the name is returned unrepaired.
 * Found by the fixture test; a Latin-1 assumption silently fails on exactly the
 * names we most need to keep.
 */
const CP1252_HIGH: Readonly<Record<number, number>> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

const toByte = (codePoint: number): number => CP1252_HIGH[codePoint] ?? (codePoint & 0xff);

export function repairEncoding(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw);

  if (!MOJIBAKE_BYTES.test(s)) return s;

  try {
    const bytes = Uint8Array.from([...s].map((ch) => toByte(ch.charCodeAt(0))));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Only accept the repair if it produced non-Latin script. Otherwise we would
    // "fix" a legitimately accented Latin name into nonsense.
    return NON_LATIN_SCRIPT.test(decoded) ? decoded : s;
  } catch {
    return s; // not valid UTF-8 underneath — leave it alone
  }
}

// --- name ------------------------------------------------------------------

/**
 * Strips decoration while preserving word boundaries.
 *
 * Note what is NOT in these ranges: the space character. Removing it is what
 * turned "Sahiba Khan" into "Sahibakhan" in the first attempt.
 */
const stripDecorations = (s: string): string =>
  s
    // CJK brackets and fullwidth square brackets, used decoratively in the data.
    .replace(/[【】［］[\]]/gu, '')
    // Arrows, misc symbols, dingbats, variation selectors, zero-width joiner.
    .replace(/[←-⯿☀-➿︀-️‍]/gu, '')
    // Emoji and pictographs.
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '')
    // Zero-width and directional marks, which travel with pasted text.
    .replace(/[​‌‎‏﻿]/gu, '');

const titleCase = (s: string): string =>
  s.replace(/(\p{L})(\p{L}*)/gu, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase());

/**
 * Names carry emoji and decorative unicode: `Aditi` with a heart, or each letter
 * wrapped in CJK brackets.
 *
 * Never empty a row out of existence — returns `Unknown` so the record survives
 * and can be flagged (docs/06 section 3).
 */
export function normaliseName(raw: string | null | undefined): string {
  if (!raw) return 'Unknown';

  const repaired = repairEncoding(String(raw));
  const cleaned = stripDecorations(repaired).replace(/\s+/gu, ' ').trim();
  if (cleaned === '') return 'Unknown';

  // Non-cased scripts have no title case. Leave them exactly as written rather
  // than mangling them.
  if (NON_LATIN_SCRIPT.test(cleaned)) return cleaned;
  return titleCase(cleaned);
}

// --- payment ---------------------------------------------------------------

export interface PaymentResult {
  readonly mode: 'COD' | 'PREPAID' | 'PARTIAL_PREPAID' | 'UNKNOWN';
  readonly prepaidAmount: string;
  readonly codAmount: string;
  readonly warning?: string;
}

/** F5 lists preapid / prepiad / preapaid as real values. webpay is prepaid. */
const PREPAID_WORD = /(prepaid|preapid|prepiad|preapaid|prepay|webpay|online|paytm|upi)/i;
const COD_WORD = /(cod|cash)/i;

/**
 * F5: 121 distinct payment strings, which is why the prepaid ratio — the
 * strongest RTO predictor available — is currently unmeasurable.
 *
 * Unparseable input returns UNKNOWN with a warning. It never guesses: an invented
 * split feeds a fabricated prepaid ratio straight into RTO risk scoring.
 */
export function parsePayment(raw: string | null | undefined, finalValue: string): PaymentResult {
  const zero = money('0');
  const total = money(finalValue);

  if (!raw || String(raw).trim() === '') {
    return { mode: 'UNKNOWN', prepaidAmount: zero, codAmount: zero, warning: 'no payment mode given' };
  }
  const s = String(raw).trim();

  // "300 prepaid & 2200 cod" — a number attached to each half.
  const amounts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z.]+)/gi)];
  const prepaidPart = amounts.find((m) => PREPAID_WORD.test(m[2] ?? ''));
  const codPart = amounts.find((m) => COD_WORD.test(m[2] ?? ''));

  if (prepaidPart && codPart) {
    const prepaidAmount = money(prepaidPart[1] as string);
    const codAmount = money(codPart[1] as string);
    const sum = Number(prepaidAmount) + Number(codAmount);
    const warning =
      Math.abs(sum - Number(total)) > 0.005
        ? `payment split does not add up: ${prepaidAmount} + ${codAmount} does not reconcile to order value ${total}`
        : undefined;
    return { mode: 'PARTIAL_PREPAID', prepaidAmount, codAmount, ...(warning ? { warning } : {}) };
  }

  const hasPrepaid = PREPAID_WORD.test(s);
  const hasCod = COD_WORD.test(s);

  if (hasPrepaid && !hasCod) return { mode: 'PREPAID', prepaidAmount: total, codAmount: zero };
  if (hasCod && !hasPrepaid) return { mode: 'COD', prepaidAmount: zero, codAmount: total };

  return {
    mode: 'UNKNOWN',
    prepaidAmount: zero,
    codAmount: zero,
    warning: `could not read payment mode from ${JSON.stringify(s)} — needs a human`,
  };
}

// --- date ------------------------------------------------------------------

export type DateLocale = 'DMY' | 'MDY' | 'YMD';

export type DateResult =
  | { readonly ok: true; readonly value: string; readonly warning?: string }
  | { readonly ok: false; readonly reason: string };

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** Rejects 31 February rather than letting Date roll it over to 3 March. */
function realDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Excel 1900 date system, including its historical phantom leap day. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/**
 * Dates arrive as `15-06-26` and `2026-12-06` meaning the same thing, plus Excel
 * serials.
 *
 * Where two readings are both real dates, the tie is broken by a rule that is
 * boring and explicable: **a date in the future is not a plausible order date**,
 * so if exactly one reading is in the past it wins. The other reading is always
 * reported as a warning, so the admin sees the choice rather than inheriting it
 * silently. When both readings are plausible, the source's configured locale
 * decides — again with a warning.
 */
export function normaliseDate(
  raw: string | null | undefined,
  locale: DateLocale,
  todayIso: string,
): DateResult {
  if (!raw || String(raw).trim() === '') return { ok: false, reason: 'no date given' };
  const s = String(raw).trim();

  const tomorrow = new Date(Date.parse(`${todayIso}T00:00:00Z`) + 86_400_000);
  const latestAllowed = iso(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
  );
  const plausible = (c: { y: number; m: number; d: number }): boolean =>
    realDate(c.y, c.m, c.d) && iso(c.y, c.m, c.d) <= latestAllowed;

  // Excel serial: unambiguous, so handled first and on its own.
  if (/^\d{5}$/.test(s)) {
    const dt = new Date(EXCEL_EPOCH_UTC + Number(s) * 86_400_000);
    const [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    if (!realDate(y, m, d)) return { ok: false, reason: `excel serial ${s} is not a real date` };
    const value = iso(y, m, d);
    return value > latestAllowed
      ? { ok: false, reason: `date is in the future: ${value}` }
      : { ok: true, value };
  }

  // Build every reading the string could legitimately have.
  const candidates: Array<{ y: number; m: number; d: number; how: string }> = [];

  const isoMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  const shortMatch = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);

  if (isoMatch) {
    const [y, a, b] = [Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3])];
    candidates.push({ y, m: a, d: b, how: 'YYYY-MM-DD' });
    // The client also writes day-first in this column, so YYYY-DD-MM is a real
    // possibility whenever the third part could be a month.
    if (b <= 12 && a !== b) candidates.push({ y, m: b, d: a, how: 'YYYY-DD-MM' });
  } else if (shortMatch) {
    const [a, b, c] = [Number(shortMatch[1]), Number(shortMatch[2]), Number(shortMatch[3])];
    const y = c < 100 ? 2000 + c : c;
    const dmy = { y, m: b, d: a, how: 'DD-MM-YY' };
    const mdy = { y, m: a, d: b, how: 'MM-DD-YY' };
    candidates.push(...(locale === 'MDY' ? [mdy, dmy] : [dmy, mdy]));
  } else {
    return { ok: false, reason: `unrecognised date format: ${JSON.stringify(s)}` };
  }

  const real = candidates.filter((c) => realDate(c.y, c.m, c.d));
  if (real.length === 0) {
    return { ok: false, reason: `not a real calendar date: ${JSON.stringify(s)}` };
  }

  const viable = real.filter(plausible);
  if (viable.length === 0) {
    const first = real[0] as { y: number; m: number; d: number };
    return { ok: false, reason: `date is in the future: ${iso(first.y, first.m, first.d)}` };
  }

  const chosen = viable[0] as { y: number; m: number; d: number; how: string };
  const value = iso(chosen.y, chosen.m, chosen.d);

  // More than one reading was possible. Say so — the admin should see the choice.
  const alternatives = real.filter((c) => iso(c.y, c.m, c.d) !== value);
  if (alternatives.length > 0) {
    const alt = alternatives[0] as { y: number; m: number; d: number; how: string };
    return {
      ok: true,
      value,
      warning:
        `ambiguous date ${JSON.stringify(s)}: read as ${value} (${chosen.how}); ` +
        `it could also be ${iso(alt.y, alt.m, alt.d)} (${alt.how})`,
    };
  }

  return { ok: true, value };
}
