/**
 * Prints the current 6-digit code for the DEV admin accounts.
 *
 *   node scripts/dev-totp.mjs
 *
 * Admins and the owner need a second factor (CLAUDE.md section 3), which is
 * correct and is not going to be softened for convenience. But it makes a local
 * demo awkward: you cannot sign in as an admin without an authenticator app, and
 * asking someone to scan a QR code before they can look at the product is a poor
 * first five minutes.
 *
 * `db:seed:dev` enrols every admin with ONE well-known secret, printed by the
 * seed. This prints the code that secret is currently showing, so a demo can get
 * moving in a terminal.
 *
 * DEV ONLY, and safe to be dev-only because the secret is a fixture: it exists
 * solely on databases built by `db:seed:dev`, which refuses to run against
 * anything that is not local (D-17). A real admin's secret is generated at
 * enrolment and is never in this repository.
 */

import { createHmac } from 'node:crypto';

/** The fixture secret db:seed:dev enrols. Printed by the seed itself. */
const DEV_SECRET = process.env.DEV_TOTP_SECRET ?? 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const STEP_SECONDS = 30;
const DIGITS = 6;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`"${ch}" is not valid base32`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secretBase32, atMs) {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

const now = Date.now();
const code = totp(DEV_SECRET, now);
const secondsLeft = STEP_SECONDS - Math.floor((now / 1000) % STEP_SECONDS);

console.log('');
console.log(`  code:  ${code}`);
console.log(`  valid: ${secondsLeft}s more`);
console.log('');
console.log('  Sign in at http://localhost:3000/login as an admin:');
console.log('    sunita@razorveda.local / razorveda-dev-only');
console.log('');
console.log('  A rep needs no code at all:');
console.log('    nikita@razorveda.local / razorveda-dev-only');
console.log('');
