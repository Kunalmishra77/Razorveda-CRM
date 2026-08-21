import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) for ADMIN and OWNER two-factor (docs/05, Identity).
 *
 * Implemented on node:crypto rather than pulled from a package. TOTP is HMAC plus
 * a truncation rule — not a cryptographic primitive being invented — and RFC 6238
 * publishes official test vectors, so this can be verified against the spec
 * itself rather than trusted. That is worth more than an unaudited dependency on
 * the authentication path.
 *
 * Rejected: otplib. Perfectly reasonable, and swapping to it is a small change if
 * anyone prefers it — the surface here is two functions. (Tier 2)
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;

/**
 * Allow one step either side of now. Covers clock skew between the server and the
 * rep's phone without meaningfully widening the window: a stolen code is valid for
 * at most 90 seconds either way.
 */
const DEFAULT_WINDOW = 1;

/** RFC 4648 base32, no padding — the encoding every authenticator app expects. */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): HMAC-SHA1, dynamic truncation, modulo 10^digits. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const mac = createHmac('sha1', secret).update(buf).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const code =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);

  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secretBase32: string, atMs: number, digits = DIGITS): string {
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);
  return hotp(base32Decode(secretBase32), counter, digits);
}

/**
 * Constant-time comparison. A timing-variable check on a 6-digit code is a real
 * oracle when an attacker can retry.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyTotp(
  secretBase32: string,
  token: string,
  atMs: number,
  window = DEFAULT_WINDOW,
): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(atMs / 1000 / PERIOD_SECONDS);

  for (let drift = -window; drift <= window; drift++) {
    if (safeEqual(hotp(secret, counter + drift), token)) return true;
  }
  return false;
}
