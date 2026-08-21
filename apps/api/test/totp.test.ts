import { describe, it, expect } from 'vitest';
import { base32Decode, hotp, totp, verifyTotp } from '../src/auth/totp.js';

/**
 * Verified against the OFFICIAL test vectors in RFC 4226 Appendix D and RFC 6238
 * Appendix B. That is the whole reason this is implemented rather than imported:
 * it can be checked against the specification instead of trusted.
 */

/** RFC 4226 uses the ASCII secret "12345678901234567890". */
const RFC_SECRET_ASCII = '12345678901234567890';
/** The same 20 bytes, base32-encoded, as an authenticator app would store it. */
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32Decode', () => {
  it('round-trips the RFC secret to the right 20 bytes', () => {
    expect(base32Decode(RFC_SECRET_B32).toString('ascii')).toBe(RFC_SECRET_ASCII);
  });

  it('tolerates padding, whitespace and lower case, as apps emit all three', () => {
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString('ascii')).toBe(
      RFC_SECRET_ASCII,
    );
    expect(base32Decode('MZXW6===').toString('ascii')).toBe('foo');
  });

  it('rejects a character outside the alphabet', () => {
    expect(() => base32Decode('MZXW6!!!')).toThrow(/invalid base32/);
  });
});

describe('HOTP — RFC 4226 Appendix D test vectors', () => {
  // Counter 0..9 against the RFC secret. If any of these drift, the
  // implementation is wrong, not the test.
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  it.each(expected.map((code, counter) => [counter, code]))(
    'counter %i produces %s',
    (counter, code) => {
      expect(hotp(Buffer.from(RFC_SECRET_ASCII, 'ascii'), counter as number)).toBe(code);
    },
  );
});

describe('TOTP — RFC 6238 Appendix B (SHA-1 rows)', () => {
  // The RFC prints 8-digit codes; a 6-digit authenticator shows the last six.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
  ];

  it.each(vectors)('at unix time %i the code ends %s', (unixSeconds, eightDigit) => {
    expect(totp(RFC_SECRET_B32, unixSeconds * 1000)).toBe(eightDigit.slice(-6));
  });
});

describe('verifyTotp', () => {
  const now = 1_111_111_111_000;

  it('accepts the current code', () => {
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now), now)).toBe(true);
  });

  it('accepts one step either side, for clock skew', () => {
    const step = 30_000;
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now - step), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now + step), now)).toBe(true);
  });

  it('rejects two steps away — the window does not widen quietly', () => {
    const twoSteps = 60_000;
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now - twoSteps), now)).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now + twoSteps), now)).toBe(false);
  });

  it('rejects malformed input without throwing', () => {
    // A thrown error on the auth path can leak timing and shape information.
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      expect(verifyTotp(RFC_SECRET_B32, bad, now)).toBe(false);
    }
  });

  it('rejects a code from a different secret', () => {
    const other = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    expect(verifyTotp(RFC_SECRET_B32, totp(other, now), now)).toBe(false);
  });
});
