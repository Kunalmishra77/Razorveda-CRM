/**
 * Exact decimal arithmetic for money (D-29, D-39).
 *
 * Money is `numeric(12,2)` in Postgres and a decimal STRING everywhere in
 * TypeScript. A JSON number is an IEEE double, so `0.1 + 0.2` is 0.30000000000000004
 * and `2500 * 1.15` is 2874.9999999999995 — which is precisely the class of defect
 * that produced the client's 1,25,340 instead of 1,25,341.
 *
 * Internally these functions scale to integers with BigInt and scale back. That is
 * a COMPUTATION detail, not a storage or wire format: docs/02 says money is never
 * stored as integer paise, and it is not. Nothing here returns a JS number.
 *
 * Rounding is half-up (away from zero on .5), matching Postgres `numeric` and
 * ordinary commercial expectation. It happens once, at the end of an operation —
 * never on an intermediate.
 */

const SCALE = 2;
const FACTOR = 100n;

const MONEY_RE = /^-?\d{1,15}(\.\d+)?$/;

/** Parse a decimal string to scaled BigInt paise. Rejects floats and junk. */
export function toScaled(value: string): bigint {
  if (typeof value !== 'string' || !MONEY_RE.test(value.trim())) {
    throw new Error(`not a money string: ${JSON.stringify(value)}`);
  }
  const v = value.trim();
  const negative = v.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? v.slice(1) : v).split('.');

  // Round the fractional part to 2dp, half-up, without ever forming a float.
  const padded = (frac + '000').slice(0, SCALE + 1);
  const head = padded.slice(0, SCALE);
  const nextDigit = Number(padded[SCALE] ?? '0');

  let scaled = BigInt(whole) * FACTOR + BigInt(head || '0');
  if (nextDigit >= 5) scaled += 1n;
  return negative ? -scaled : scaled;
}

/** Format scaled paise back to a 2dp decimal string. */
export function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / FACTOR;
  const frac = abs % FACTOR;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(SCALE, '0')}`;
}

/** Normalise any accepted money string to canonical 2dp form. */
export const money = (value: string): string => fromScaled(toScaled(value));

export const addMoney = (a: string, b: string): string => fromScaled(toScaled(a) + toScaled(b));

export const subMoney = (a: string, b: string): string => fromScaled(toScaled(a) - toScaled(b));

/** Multiply by an integer quantity. Quantities are counts, never fractional. */
export function mulQuantity(a: string, quantity: number): string {
  if (!Number.isInteger(quantity)) throw new Error(`quantity must be an integer, got ${quantity}`);
  return fromScaled(toScaled(a) * BigInt(quantity));
}

/**
 * A percentage of an amount, e.g. a credit split or an incentive slab.
 * `percent` is itself a decimal string, so 33.33% does not become a float.
 */
export function percentOfMoney(amount: string, percent: string): string {
  const product = toScaled(amount) * toScaled(percent); // scaled by 100 * 100
  const divisor = FACTOR * FACTOR; // 10000 -> back to 2dp, half-up
  const negative = product < 0n;
  const abs = negative ? -product : product;
  let result = abs / divisor;
  if ((abs % divisor) * 2n >= divisor) result += 1n;
  return fromScaled(negative ? -result : result);
}

export const sumMoney = (values: readonly string[]): string =>
  fromScaled(values.reduce((acc, v) => acc + toScaled(v), 0n));

export const cmpMoney = (a: string, b: string): -1 | 0 | 1 => {
  const [x, y] = [toScaled(a), toScaled(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

export const isZeroMoney = (a: string): boolean => toScaled(a) === 0n;
export const isNegativeMoney = (a: string): boolean => toScaled(a) < 0n;
export const maxMoney = (a: string, b: string): string => (cmpMoney(a, b) >= 0 ? money(a) : money(b));

/**
 * Split an amount across percentages that sum to 100, with no rounding loss.
 *
 * The naive approach — round each share independently — loses or invents paise:
 * ₹1,000 across three reps at 33.33/33.33/33.34 must still total exactly ₹1,000.
 * The largest-remainder method distributes the residue to the largest fractional
 * parts, so the parts always re-sum to the whole. An attribution ledger that does
 * not add up is worse than one that is slightly unfair to one rep.
 */
export function splitMoney(amount: string, percents: readonly string[]): string[] {
  const total = percents.reduce((acc, p) => acc + toScaled(p), 0n);
  if (total !== 100n * FACTOR) {
    throw new Error(`credit split percentages must sum to exactly 100, got ${fromScaled(total)}`);
  }

  const scaledAmount = toScaled(amount);
  const divisor = FACTOR * FACTOR;

  const floors: bigint[] = [];
  const remainders: Array<{ index: number; remainder: bigint }> = [];

  percents.forEach((p, index) => {
    const product = scaledAmount * toScaled(p);
    floors.push(product / divisor);
    remainders.push({ index, remainder: ((product % divisor) + divisor) % divisor });
  });

  let residue = scaledAmount - floors.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (b.remainder === a.remainder ? a.index - b.index : Number(b.remainder - a.remainder)));

  for (const { index } of remainders) {
    if (residue === 0n) break;
    const step = residue > 0n ? 1n : -1n;
    floors[index] = (floors[index] as bigint) + step;
    residue -= step;
  }

  return floors.map(fromScaled);
}
