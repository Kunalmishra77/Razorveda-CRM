import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  duplicateFileMessage,
  fileHash,
  headerSignature,
} from '../src/ingestion/fingerprint.js';

const bytesOf = (name: string): Uint8Array =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)));

describe('fileHash — the duplicate-upload guard', () => {
  it('is stable for the same bytes', () => {
    expect(fileHash(bytesOf('shopify_orders_sample.csv'))).toBe(
      fileHash(bytesOf('shopify_orders_sample.csv')),
    );
  });

  it('differs between different files', () => {
    expect(fileHash(bytesOf('shopify_orders_sample.csv'))).not.toBe(
      fileHash(bytesOf('meta_ads_sample.csv')),
    );
  });

  it('changes when a single byte changes', () => {
    const original = bytesOf('meta_ads_sample.csv');
    const tampered = Uint8Array.from(original);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x01;
    expect(fileHash(tampered)).not.toBe(fileHash(original));
  });

  it('is a 64-character lowercase hex digest', () => {
    expect(fileHash(bytesOf('rto_sample.csv'))).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes RAW BYTES, so line endings change the hash', () => {
    // This is the whole reason .gitattributes forces LF on the fixtures (D-28).
    // If Git rewrote them to CRLF on a Windows checkout, the same file would hash
    // differently here than in Linux CI, and the duplicate check would silently
    // stop working across machines. Asserting it keeps that reasoning visible.
    const lf = new TextEncoder().encode('a,b\n1,2\n');
    const crlf = new TextEncoder().encode('a,b\r\n1,2\r\n');
    expect(fileHash(lf)).not.toBe(fileHash(crlf));
  });

  it('confirms the fixtures on disk are LF, not CRLF', () => {
    // The guard above only helps if the invariant actually holds.
    const raw = bytesOf('delivered_data_sample.csv');
    expect(raw.includes(0x0d), 'a fixture has CRLF line endings — see D-28').toBe(false);
  });
});

describe('headerSignature — the mapping-template lookup', () => {
  const shopify = [
    'Order id', 'Date', 'CustomerName', 'Phone no', 'Alt number', 'ProductDeatil',
  ];

  it('is stable for the same headers', () => {
    expect(headerSignature(shopify)).toBe(headerSignature([...shopify]));
  });

  it('ignores column ORDER — a reordered export is the same shape', () => {
    // Otherwise a source that moves a column sends the admin back to the AI
    // mapping path for a file it has already mapped a hundred times.
    expect(headerSignature([...shopify].reverse())).toBe(headerSignature(shopify));
  });

  it('ignores case and surrounding whitespace', () => {
    expect(headerSignature(['  PHONE NO ', 'date'])).toBe(headerSignature(['Phone no', 'Date']));
  });

  it('collapses internal whitespace', () => {
    expect(headerSignature(['Phone   no'])).toBe(headerSignature(['Phone no']));
  });

  it('ignores empty trailing columns, which Excel adds freely', () => {
    expect(headerSignature([...shopify, '', '  '])).toBe(headerSignature(shopify));
  });

  it('DIFFERS when a real column is added or renamed', () => {
    // The client's headers vary genuinely: Phone no / Phoneno / Number (F6). Each
    // is a different shape and deserves its own confirmed mapping.
    expect(headerSignature([...shopify, 'Coupon'])).not.toBe(headerSignature(shopify));
    expect(headerSignature(['Phoneno', 'Date'])).not.toBe(headerSignature(['Phone no', 'Date']));
  });

  it('gives each fixture layout its own signature', () => {
    const headerRow = (name: string): string[] =>
      readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8')
        .split(/\r?\n/)[0]!
        .split(',');

    const files = [
      'shopify_orders_sample.csv', 'meta_ads_sample.csv', 'wa_campaign_sample.csv',
      'delivered_data_sample.csv', 'rto_sample.csv', 'nc_refused_sample.csv',
    ];
    const signatures = files.map((f) => headerSignature(headerRow(f)));
    expect(new Set(signatures).size, 'two channels share a header signature').toBe(files.length);
  });

  it('gives a column-SHIFTED file the SAME signature as a clean one', () => {
    // Stated as a test because it is a real limitation, not an oversight. A shift
    // moves VALUES, not headers, so the signature cannot see it — which is exactly
    // why the type contracts exist as an independent mechanism (docs/06 5.1).
    const clean = ['Date', 'Name', 'Number', 'Order Status', 'Client Category'];
    expect(headerSignature(clean)).toBe(headerSignature([...clean]));
  });
});

describe('the duplicate-file message', () => {
  it('says what happened and what to do next', () => {
    // docs/07 section 5, near-verbatim: "File already uploaded on 19 Aug. Upload a
    // different file or roll back batch B-19826-11."
    const message = duplicateFileMessage({
      fileName: 'shopify-19-aug.csv',
      uploadedOn: '19 Aug 2026',
      batchRef: 'B-19826-11',
      rowsCommitted: 512,
    });
    expect(message).toContain('19 Aug 2026');
    expect(message).toContain('B-19826-11');
    expect(message).toContain('512 rows');
    expect(message).toContain('Nothing has been imported');
    expect(message).toMatch(/roll back/i);
    expect(message).not.toMatch(/something went wrong/i);
  });
});
