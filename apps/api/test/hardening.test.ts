import { describe, it, expect } from 'vitest';
import { RateLimiter, DEFAULT_RULES, GLOBAL_RULE } from '../src/security/rate-limit.js';
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
