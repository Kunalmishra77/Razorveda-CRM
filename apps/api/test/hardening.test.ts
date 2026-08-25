import { describe, it, expect } from 'vitest';
import { RateLimiter, DEFAULT_RULES, GLOBAL_RULE, rateLimit } from '../src/security/rate-limit.js';
import { validateUpload, MAX_UPLOAD_BYTES } from '../src/security/upload-guard.js';

/**
 * Rate limiting and upload validation (Phase 5 deliverable 7).
 *
 * Both are pure, so both are tested without a server or a clock — the window
 * boundaries in particular, which are the part that is wrong in most hand-rolled
 * limiters and which nothing at runtime would reveal.
 */

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

describe('rate limiting', () => {
  it('allows a normal burst and refuses the one past the limit', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.check('1.2.3.4', '/auth/login', NOW), `attempt ${i + 1}`).toBeNull();
    }
    expect(limiter.check('1.2.3.4', '/auth/login', NOW)).not.toBeNull();
  });

  it('is per address, so one attacker cannot lock everyone out', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 10; i += 1) limiter.check('1.2.3.4', '/auth/login', NOW);
    expect(limiter.check('1.2.3.4', '/auth/login', NOW)).not.toBeNull();
    // A different rep, behind a different address, is unaffected.
    expect(limiter.check('5.6.7.8', '/auth/login', NOW)).toBeNull();
  });

  it('is per route, so hammering login does not block the worklist', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 10; i += 1) limiter.check('1.2.3.4', '/auth/login', NOW);
    expect(limiter.check('1.2.3.4', '/auth/login', NOW)).not.toBeNull();
    expect(limiter.check('1.2.3.4', '/worklist', NOW)).toBeNull();
  });

  it('slides, so the window cannot be doubled at its boundary', () => {
    // The bug in every fixed-window limiter: `max` at 11:59:59 and `max` again at
    // 12:00:00 is twice the limit across one second.
    const limiter = new RateLimiter();
    for (let i = 0; i < 10; i += 1) limiter.check('1.2.3.4', '/auth/login', NOW);
    expect(limiter.check('1.2.3.4', '/auth/login', NOW + 1000)).not.toBeNull();

    // Only once the whole window has passed does it open again.
    expect(limiter.check('1.2.3.4', '/auth/login', NOW + 5 * 60_000 + 1)).toBeNull();
  });

  it('refuses two-factor attempts faster than password attempts', () => {
    // A six-digit code is guessable at volume, and nothing else stands between an
    // attacker and binding a permanent second factor of their own.
    const login = DEFAULT_RULES.find(([p]) => p === '/auth/login')![1];
    const totp = DEFAULT_RULES.find(([p]) => p === '/auth/totp')![1];
    expect(totp.max).toBeLessThan(login.max);
  });

  it('falls back to the global rule for anything unlisted', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < GLOBAL_RULE.max; i += 1) {
      expect(limiter.check('1.2.3.4', '/some/new/route', NOW)).toBeNull();
    }
    expect(limiter.check('1.2.3.4', '/some/new/route', NOW)).not.toBeNull();
  });

  it('says what to do, not just that it refused', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 11; i += 1) limiter.check('1.2.3.4', '/auth/login', NOW);
    const refused = limiter.check('1.2.3.4', '/auth/login', NOW);
    expect(refused!.message).toMatch(/wait five minutes/i);
    expect(refused!.message).toMatch(/admin can reset it/i);
  });

  it('sweeps old buckets, so the map is not an attacker-controlled leak', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 100; i += 1) limiter.check(`10.0.0.${i}`, '/worklist', NOW);
    expect(limiter.size).toBe(100);

    expect(limiter.sweep(NOW + 3_600_001)).toBe(100);
    expect(limiter.size).toBe(0);
  });

  it('does not sweep a bucket still in use', () => {
    const limiter = new RateLimiter();
    limiter.check('1.2.3.4', '/worklist', NOW);
    expect(limiter.sweep(NOW + 60_000)).toBe(0);
    expect(limiter.size).toBe(1);
  });
});

describe('upload validation', () => {
  const csv = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

  it('accepts an ordinary CSV', () => {
    expect(validateUpload(csv('Name,Phone\nAditi,9876543210\n'), 'leads.csv').ok).toBe(true);
  });

  it('names an XLSX as an XLSX and says how to fix it', () => {
    // A ZIP header. Read as UTF-8 this becomes replacement characters and the
    // column-shift detector rejects it with a message about type contracts —
    // correct, and useless to the admin holding the file.
    const xlsx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
    const v = validateUpload(xlsx, 'orders.xlsx');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/Excel workbook/i);
      expect(v.reason).toMatch(/Save As.*CSV UTF-8/i);
    }
  });

  it('recognises a PDF, an old .xls and a gzip', () => {
    for (const [bytes, pattern] of [
      [[0x25, 0x50, 0x44, 0x46], /PDF/i],
      [[0xd0, 0xcf, 0x11, 0xe0], /old-format Excel/i],
      [[0x1f, 0x8b, 0x08, 0x00], /gzip/i],
    ] as const) {
      const v = validateUpload(new Uint8Array(bytes), 'file');
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(pattern);
    }
  });

  it('catches a UTF-16 export, which looks fine in Notepad', () => {
    // Excel's "Unicode Text" export. Every other character is a NUL.
    const utf16 = new Uint8Array(Buffer.from('Name,Phone\n', 'utf16le'));
    const v = validateUpload(utf16, 'leads.txt');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/UTF-16/i);
  });

  it('rejects text with no delimiter, and quotes the line back', () => {
    const v = validateUpload(csv('This is a report about sales\nnot a spreadsheet\n'), 'report.csv');
    expect(v.ok).toBe(false);
    // Quoting the offending line is what turns "invalid file" into something the
    // admin can recognise as the wrong export.
    if (!v.ok) expect(v.reason).toContain('This is a report about sales');
  });

  it('accepts tab and semicolon delimiters', () => {
    // A European Excel export uses semicolons; a copy-paste from a sheet uses tabs.
    expect(validateUpload(csv('Name\tPhone\nAditi\t98765\n'), 'a.csv').ok).toBe(true);
    expect(validateUpload(csv('Name;Phone\nAditi;98765\n'), 'b.csv').ok).toBe(true);
  });

  it('refuses an empty file', () => {
    const v = validateUpload(new Uint8Array(0), 'empty.csv');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/is empty/i);
  });

  it('refuses one over the ceiling and suggests splitting it', () => {
    const huge = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    huge.set(Buffer.from('a,b\n1,2\n', 'utf8'));
    const v = validateUpload(huge, 'backfill.csv');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toMatch(/over the 25 MB limit/i);
      // Splitting is safe precisely because batches commit and roll back
      // independently, and the message says so.
      expect(v.reason).toMatch(/rolled back independently/i);
    }
  });

  it('has a ceiling big enough for a real day, and for the backfill', () => {
    // 2,000 rows/day at ~175 bytes is ~350 KB. The old effective limit was ~75 KB
    // of CSV, because Express defaults to a 100 KB body and base64 adds a third.
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(350 * 1024 * 10);
  });
});

/**
 * THE MIDDLEWARE, not just the counter.
 *
 * `RateLimiter` was well covered and both of these bugs lived in the twenty lines
 * around it — the part nothing tested because it needed a request object. Both
 * were found by using the product: a browser could not read a 429 at all, and it
 * reported "Cannot reach the API" instead.
 *
 * Fakes rather than a live server: the properties are about headers and about
 * which requests get counted, and neither needs a socket.
 */
type Handler = (req: unknown, res: unknown, next: () => void) => void;

function fakeRes() {
  const headers: Record<string, string> = {};
  let code = 200;
  let body: unknown = null;
  // `status` is Express's SETTER, so the reader needs a different name — the
  // first version had both and the method silently shadowed the getter, which
  // made three assertions compare against a function and fail confusingly.
  return {
    headers,
    get code() { return code; },
    get body() { return body; },
    setHeader(k: string, v: string) { headers[k] = v; },
    status(c: number) { code = c; return this; },
    json(b: unknown) { body = b; return this; },
  };
}

const req = (method: string, path: string, origin?: string) => ({
  method,
  path,
  ip: '203.0.113.7',
  socket: { remoteAddress: '203.0.113.7' },
  headers: origin ? { origin } : {},
});

describe('the rate-limit middleware', () => {
  const ORIGIN = 'http://localhost:3000';

  it('does not count a CORS preflight as a sign-in attempt', () => {
    // The browser sends OPTIONS before every cross-origin POST. Counting it made
    // each real sign-in cost two of the ten allowed, so a rep who mistyped her
    // password five times was locked out for the wrong reason.
    const mw = rateLimit(new RateLimiter(), [ORIGIN]) as unknown as Handler;
    let passed = 0;
    for (let i = 0; i < 50; i += 1) {
      const res = fakeRes();
      mw(req('OPTIONS', '/auth/login', ORIGIN), res, () => { passed += 1; });
      expect(res.code, 'a preflight was refused').not.toBe(429);
    }
    expect(passed, 'preflights should always pass through').toBe(50);
  });

  it('still counts the POST behind the preflight', () => {
    // The preflight is waved through; the request that can actually guess a
    // password is not. Skipping OPTIONS must not weaken the control.
    const mw = rateLimit(new RateLimiter(), [ORIGIN]) as unknown as Handler;
    let refusedAt = -1;
    for (let i = 0; i < 20; i += 1) {
      const res = fakeRes();
      mw(req('POST', '/auth/login', ORIGIN), res, () => undefined);
      if (res.code === 429 && refusedAt < 0) refusedAt = i;
    }
    // The login rule allows ten in the window.
    expect(refusedAt).toBe(10);
  });

  it('puts CORS headers on the refusal, so the browser can read the message', () => {
    // Without these the browser discards the 429 before any JavaScript sees it,
    // fetch rejects, and the web client reports "Cannot reach the API — check
    // that it is running". The API was running and had answered clearly; the one
    // message that could not get through was the useful one.
    const mw = rateLimit(new RateLimiter(), [ORIGIN]) as unknown as Handler;
    let last = fakeRes();
    for (let i = 0; i < 12; i += 1) {
      last = fakeRes();
      mw(req('POST', '/auth/login', ORIGIN), last, () => undefined);
    }
    expect(last.code).toBe(429);
    expect(last.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(last.headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(last.headers['Vary']).toBe('Origin');
    expect(last.headers['Retry-After']).toBe('300');
    expect((last.body as { message: string }).message).toMatch(/too many sign-in attempts/i);
  });

  it('does not echo an origin it was not told to allow', () => {
    // A refusal is not a reason to loosen the origin check. An attacker's page
    // must not be able to read the message either.
    const mw = rateLimit(new RateLimiter(), [ORIGIN]) as unknown as Handler;
    let last = fakeRes();
    for (let i = 0; i < 12; i += 1) {
      last = fakeRes();
      mw(req('POST', '/auth/login', 'https://evil.example'), last, () => undefined);
    }
    expect(last.code).toBe(429);
    expect(last.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
