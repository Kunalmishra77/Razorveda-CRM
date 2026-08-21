import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MOJIBAKE_BYTES,
  normaliseDate,
  normaliseName,
  normalisePhone,
  parsePayment,
  repairEncoding,
  repairEncodingDetailed,
} from '../src/normalise/index.js';

/**
 * Phase 2 item 1: "write tests from `fixtures/` BEFORE the implementation".
 *
 * These are written from the actual fixture files, and several assertions read
 * values straight out of them so a fixture edit cannot quietly diverge from the
 * expectation. Every case here is a defect measured in the client's real
 * workbooks, cited by finding.
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8');

const rows = (name: string): string[][] =>
  fixture(name)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(','));

// ─── normalisePhone ─────────────────────────────────────────────────────────
describe('normalisePhone — F2: 10.9% of rows are un-keyable', () => {
  it('passes a clean 10-digit number through', () => {
    expect(normalisePhone('9876543210')).toEqual({ ok: true, value: '9876543210' });
  });

  it('strips the +91 country code', () => {
    // meta_ads_sample.csv row 1: "+918449645312"
    expect(normalisePhone('+918449645312')).toEqual({ ok: true, value: '8449645312' });
  });

  it('strips a bare 91 prefix on a 12-digit number', () => {
    // meta_ads_sample.csv: "918765432109"
    expect(normalisePhone('918765432109')).toEqual({ ok: true, value: '8765432109' });
  });

  it('strips a leading 0 on an 11-digit number', () => {
    // meta_ads_sample.csv: "09286465807"
    expect(normalisePhone('09286465807')).toEqual({ ok: true, value: '9286465807' });
  });

  it('strips spaces inside a +91 number', () => {
    // meta_ads_sample.csv: "+91 89672 36564"
    expect(normalisePhone('+91 89672 36564')).toEqual({ ok: true, value: '8967236564' });
  });

  it('drops a trailing .0 from Excel float coercion', () => {
    // edge_cases.csv "Float Phone": 9876543211.0
    expect(normalisePhone('9876543211.0')).toEqual({ ok: true, value: '9876543211' });
  });

  it('parks the literal text "code"', () => {
    // edge_cases.csv "Literal Text Phone" — a real value in the client's data.
    const r = normalisePhone('code');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no digits|not.*10 digits/i);
  });

  it('parks a blank', () => {
    expect(normalisePhone('').ok).toBe(false);
    expect(normalisePhone(null).ok).toBe(false);
  });

  it('parks a 9-digit number', () => {
    expect(normalisePhone('987654321').ok).toBe(false);
  });

  it('parks a number starting 0-5 — Indian mobiles start 6-9', () => {
    // edge_cases.csv "Landline Prefix": 5876543210
    expect(normalisePhone('5876543210').ok).toBe(false);
    expect(normalisePhone('1234567890').ok).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    // Ingestion must not die on one bad cell; the row parks and the batch goes on.
    for (const junk of ['   ', '--', 'N/A', '☎️', '9876543210x2', '+91-98765-43210']) {
      expect(() => normalisePhone(junk)).not.toThrow();
    }
  });

  it('reproduces the edge_cases.csv expectation table exactly', () => {
    // fixtures/README.md: 4 VALID · 4 PARKED · 2 ERROR (phone accounts for the parks).
    const data = rows('edge_cases.csv').slice(1);
    const parked = data.filter((r) => !normalisePhone(r[2] ?? '').ok);
    expect(parked.map((r) => r[1])).toEqual([
      'No Phone At All', 'Literal Text Phone', 'Nine Digit Phone', 'Landline Prefix',
    ]);
    expect(parked).toHaveLength(4);
  });
});

// ─── repairEncoding ─────────────────────────────────────────────────────────
describe('repairEncoding — mojibake Devanagari', () => {
  it('recovers Devanagari from CP1252-mangled UTF-8', () => {
    // wa_campaign_sample.csv row 3 carries this exact string.
    //
    // My first expectation here was `मोहन शर्मा` and it was IMPOSSIBLE, which the
    // bytes settled: the stored text runs E0 A5 straight into E0, so the virama
    // byte 0x8D is missing. CP1252 leaves 0x8D undefined, so that byte was
    // destroyed when the file was first mis-decoded — before it ever reached us.
    // No implementation can bring it back.
    const r = repairEncodingDetailed('à¤®à¥‹à¤¹à¤¨ à¤¶à¤°à¥à¤®à¤¾');
    expect(r.changed).toBe(true);
    expect(r.value).toMatch(/[ऀ-ॿ]/);
    expect(r.value.startsWith('मोहन')).toBe(true);
  });

  it('FLAGS a repair it could not complete, rather than presenting it as clean', () => {
    // A recognisable name with one missing mark beats an unreadable one — but the
    // row has to be flagged, not quietly accepted.
    expect(repairEncodingDetailed('à¤®à¥‹à¤¹à¤¨ à¤¶à¤°à¥à¤®à¤¾').lossy).toBe(true);
  });

  it('does not flag a clean repair as lossy', () => {
    // "मोहन" alone has no byte in the CP1252 dead zone, so it recovers exactly.
    const clean = repairEncodingDetailed('à¤®à¥‹à¤¹à¤¨');
    expect(clean.value).toBe('मोहन');
    expect(clean.lossy).toBe(false);
  });

  it('leaves clean Devanagari untouched', () => {
    expect(repairEncoding('मोहन शर्मा')).toBe('मोहन शर्मा');
  });

  it('leaves plain ASCII untouched', () => {
    expect(repairEncoding('Priyanshi Sharma')).toBe('Priyanshi Sharma');
  });

  it('repairs the mojibake actually present in the fixture', () => {
    // Detected by the byte-range pattern, not by a specific character. The first
    // version looked for U+00C3 and found nothing, because this fixture's lead
    // byte is U+00E0 — a reminder that mojibake has a shape, not a signature char.
    const row = rows('wa_campaign_sample.csv').find((r) => MOJIBAKE_BYTES.test(r[1] ?? ''));
    expect(row, 'wa_campaign_sample.csv no longer contains mojibake').toBeDefined();
    expect(repairEncoding(row?.[1] ?? '')).toMatch(/[ऀ-ॿ]/);
  });
});

// ─── normaliseName ──────────────────────────────────────────────────────────
describe('normaliseName — emoji and decorative unicode', () => {
  it('strips a trailing emoji', () => {
    // meta_ads_sample.csv: "Sahiba Khan ❤️"
    expect(normaliseName('Sahiba Khan ❤️')).toBe('Sahiba Khan');
  });

  it('unwraps enclosed characters', () => {
    // meta_ads_sample.csv: "【A】【a】【r】【t】【i】❣️"
    expect(normaliseName('【A】【a】【r】【t】【i】❣️')).toBe('Aarti');
  });

  it('collapses whitespace and title-cases', () => {
    expect(normaliseName('  priyanshi   SHARMA ')).toBe('Priyanshi Sharma');
  });

  it('never empties a row out of existence', () => {
    // docs/06: keep "Unknown" and flag, rather than losing the row.
    expect(normaliseName('❤️❤️')).toBe('Unknown');
    expect(normaliseName('')).toBe('Unknown');
    expect(normaliseName(null)).toBe('Unknown');
  });

  it('preserves Devanagari rather than stripping it as non-ASCII', () => {
    expect(normaliseName('मोहन शर्मा')).toBe('मोहन शर्मा');
  });

  it('handles every name in the meta ads fixture without throwing', () => {
    for (const r of rows('meta_ads_sample.csv').slice(1)) {
      expect(() => normaliseName(r[1] ?? '')).not.toThrow();
      expect(normaliseName(r[1] ?? '').length).toBeGreaterThan(0);
    }
  });
});

// ─── parsePayment ───────────────────────────────────────────────────────────
describe('parsePayment — F5: 121 distinct payment strings', () => {
  it('parses plain COD', () => {
    expect(parsePayment('COD', '2500.00')).toMatchObject({
      mode: 'COD', prepaidAmount: '0.00', codAmount: '2500.00',
    });
  });

  it('parses plain prepaid', () => {
    expect(parsePayment('prepaid', '949.00')).toMatchObject({
      mode: 'PREPAID', prepaidAmount: '949.00', codAmount: '0.00',
    });
  });

  it('parses the exit-criterion string: "300 prepaid & 2200 cod"', () => {
    // tasks/phase-2 exit criterion 4, verbatim.
    expect(parsePayment('300 prepaid & 2200 cod', '2500.00')).toMatchObject({
      mode: 'PARTIAL_PREPAID', prepaidAmount: '300.00', codAmount: '2200.00',
    });
  });

  it('parses "849 webpay & 1651 cod" — webpay is prepaid', () => {
    // shopify_orders_sample.csv RZ10044.
    expect(parsePayment('849 webpay & 1651 cod', '2500.00')).toMatchObject({
      mode: 'PARTIAL_PREPAID', prepaidAmount: '849.00', codAmount: '1651.00',
    });
  });

  it.each([
    ['500 preapid & 2000 cod', '500.00', '2000.00'],
    ['900 prepiad & 900 cod', '900.00', '900.00'],
    ['300 prepaid & 900 cod', '300.00', '900.00'],
  ])('handles the misspelling in %s', (input, prepaid, cod) => {
    // F5 lists preapid / prepiad / preapaid as real values in the client's files.
    expect(parsePayment(input, '9999.00')).toMatchObject({
      mode: 'PARTIAL_PREPAID', prepaidAmount: prepaid, codAmount: cod,
    });
  });

  it('parses the standalone misspelling "preapaid"', () => {
    // wa_campaign_sample.csv row 4.
    expect(parsePayment('preapaid', '899.00')).toMatchObject({ mode: 'PREPAID' });
  });

  it('WARNS rather than guessing on an unparseable string', () => {
    // shopify_orders_sample.csv RZ10050: "pay later maybe". docs/06: flag as
    // WARNING, do not guess. Guessing here would invent a prepaid ratio, which is
    // the strongest RTO predictor we have.
    const r = parsePayment('pay later maybe', '1300.00');
    expect(r.mode).toBe('UNKNOWN');
    expect(r.warning).toBeTruthy();
  });

  it('never invents money: prepaid + cod equals the order value or it warns', () => {
    // The invariant that matters. A split that does not reconcile is a defect,
    // and prepaid_ratio feeds RTO risk directly.
    const r = parsePayment('300 prepaid & 2200 cod', '2500.00');
    expect(Number(r.prepaidAmount) + Number(r.codAmount)).toBe(2500);
  });

  it('warns when the split does not add up to the order value', () => {
    const r = parsePayment('300 prepaid & 2200 cod', '3000.00');
    expect(r.warning).toMatch(/does not add up|reconcile/i);
  });

  it('parses every payment string in the shopify and wa fixtures', () => {
    const strings = [
      ...rows('shopify_orders_sample.csv').slice(1).map((r) => r[8] ?? ''),
      ...rows('wa_campaign_sample.csv').slice(1).map((r) => r[5] ?? ''),
    ].filter(Boolean);
    expect(strings.length).toBeGreaterThan(10);
    const unknown = strings.filter((s) => parsePayment(s, '9999.00').mode === 'UNKNOWN');
    // fixtures/README: exactly one unparseable payment string across the set.
    expect(unknown).toEqual(['pay later maybe']);
  });
});

// ─── normaliseDate ──────────────────────────────────────────────────────────
describe('normaliseDate — the same day written two ways', () => {
  it('reads DD-MM-YY under the DMY locale', () => {
    // Every dated fixture row uses this shape.
    expect(normaliseDate('20-08-26', 'DMY', '2026-08-21')).toEqual({
      ok: true, value: '2026-08-20',
    });
  });

  it('reads an unambiguous ISO date regardless of locale', () => {
    expect(normaliseDate('2026-08-20', 'DMY', '2026-08-21')).toMatchObject({
      ok: true, value: '2026-08-20',
    });
  });

  it('flags the ambiguous fixture row and picks the plausible reading', () => {
    // wa_campaign_sample.csv row 2 is "2026-12-06". Read as YYYY-MM-DD that is
    // 6 December — in the future, so not a plausible order date. Read day-first it
    // is 12 June, which is in the past and sits with the rest of that file's June
    // dates. The past reading wins, and the alternative is reported.
    const r = normaliseDate('2026-12-06', 'DMY', '2026-08-21');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe('2026-06-12');
      expect(r.warning).toMatch(/ambiguous/i);
      expect(r.warning).toContain('2026-12-06');
    }
  });

  it('does not invent ambiguity where there is none', () => {
    // 2026-08-20: the third part is 20, which cannot be a month, so there is
    // exactly one reading and no warning.
    const r = normaliseDate('2026-08-20', 'DMY', '2026-08-21');
    expect(r).toEqual({ ok: true, value: '2026-08-20' });
  });

  it('handles an Excel serial number', () => {
    // Derived, not hardcoded: the first attempt guessed 46265, which is 31 August
    // and therefore rejected as a future date against a 21 August clock.
    const serial = (Date.UTC(2026, 7, 20) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(normaliseDate(String(serial), 'DMY', '2026-08-21')).toEqual({
      ok: true, value: '2026-08-20',
    });
  });

  it('rejects an Excel serial that lands in the future', () => {
    const serial = (Date.UTC(2026, 7, 31) - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(normaliseDate(String(serial), 'DMY', '2026-08-21').ok).toBe(false);
  });

  it('rejects a date more than a day in the future', () => {
    // edge_cases.csv "Future Date Row" is 27-08-26 against a 21 Aug clock.
    expect(normaliseDate('27-08-26', 'DMY', '2026-08-21').ok).toBe(false);
  });

  it('allows tomorrow, for timezone slack', () => {
    expect(normaliseDate('22-08-26', 'DMY', '2026-08-21').ok).toBe(true);
  });

  it('rejects an impossible date rather than rolling it over', () => {
    // 31 February must not silently become 3 March.
    expect(normaliseDate('31-02-26', 'DMY', '2026-08-21').ok).toBe(false);
  });

  it('never throws on junk', () => {
    for (const junk of ['', 'tomorrow', '??', '00-00-00']) {
      expect(() => normaliseDate(junk, 'DMY', '2026-08-21')).not.toThrow();
      expect(normaliseDate(junk, 'DMY', '2026-08-21').ok).toBe(false);
    }
  });
});
