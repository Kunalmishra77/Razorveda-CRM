import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFileStorage, StorageIntegrityError } from '../src/storage/storage.js';

/**
 * ADR-005: uploads are immutable and retained, so any batch can be replayed after
 * a rule fix. These tests are about the guarantee, not the filesystem.
 */

const roots: string[] = [];
let storage: LocalFileStorage;
let root: string;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const FILE = bytes('Order id,Date,Phone no\nRZ10041,20-08-26,8076845536\n');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'razorveda-storage-'));
  roots.push(root);
  storage = new LocalFileStorage(root);
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('storing an upload', () => {
  it('returns the content hash as the key', async () => {
    const stored = await storage.put(FILE, 'shopify-20-aug.csv');
    expect(stored.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.bytes).toBe(FILE.length);
    expect(stored.alreadyExisted).toBe(false);
  });

  it('round-trips the exact bytes', async () => {
    const { hash } = await storage.put(FILE, 'shopify-20-aug.csv');
    expect(await storage.get(hash)).toEqual(FILE);
  });

  it('is idempotent — the same file twice is stored once', async () => {
    const first = await storage.put(FILE, 'shopify-20-aug.csv');
    const second = await storage.put(FILE, 'a-different-name.csv');
    expect(second.hash).toBe(first.hash);
    expect(second.alreadyExisted).toBe(true);
  });

  it('gives different content different keys', async () => {
    const a = await storage.put(FILE, 'a.csv');
    const b = await storage.put(bytes('something else entirely'), 'b.csv');
    expect(a.hash).not.toBe(b.hash);
  });

  it('keeps the original filename alongside, without trusting it as the key', async () => {
    // The uploaded name is what the admin recognises in the batch list, but two
    // different exports are routinely called "shopify.csv" — the hash is identity,
    // the name is only a label.
    const { hash } = await storage.put(FILE, 'shopify-20-aug.csv');
    const meta = JSON.parse(readFileSync(join(root, hash.slice(0, 2), `${hash}.json`), 'utf8'));
    expect(meta.originalName).toBe('shopify-20-aug.csv');
    expect(meta.bytes).toBe(FILE.length);
  });
});

describe('immutability is structural, not conventional', () => {
  it('exposes no destructive operation at all', () => {
    // ADR-005 is only true if overwriting is impossible rather than discouraged.
    //
    // Asserting the exact prototype surface was too strict: TypeScript `private`
    // is compile-time only, so pathFor and metaPathFor are legitimately there at
    // runtime. What must hold is that nothing DESTRUCTIVE exists.
    const surface = Object.getOwnPropertyNames(LocalFileStorage.prototype);
    for (const forbidden of ['delete', 'update', 'remove', 'overwrite', 'replace', 'truncate']) {
      expect(surface, `storage exposes ${forbidden}()`).not.toContain(forbidden);
    }
    expect(surface).toEqual(expect.arrayContaining(['put', 'get', 'has']));
  });

  it('cannot store different content under an existing key', async () => {
    // The hash IS the path, so this is physically impossible rather than guarded.
    const { hash } = await storage.put(FILE, 'a.csv');
    const other = await storage.put(bytes('tampered'), 'b.csv');
    expect(other.hash).not.toBe(hash);
    expect(await storage.get(hash)).toEqual(FILE);
  });
});

describe('integrity is checked on the way out, not assumed', () => {
  it('detects a stored file that no longer matches its hash', async () => {
    // A corrupted archive must surface now, not during a replay months later when
    // nobody remembers what the batch contained.
    const { hash } = await storage.put(FILE, 'a.csv');
    writeFileSync(join(root, hash.slice(0, 2), `${hash}.bin`), 'quietly altered');

    await expect(storage.get(hash)).rejects.toThrow(StorageIntegrityError);
    await expect(storage.get(hash)).rejects.toThrow(/does not match its hash/);
  });

  it('detects corruption on a repeat upload too', async () => {
    const { hash } = await storage.put(FILE, 'a.csv');
    writeFileSync(join(root, hash.slice(0, 2), `${hash}.bin`), 'quietly altered');
    await expect(storage.put(FILE, 'a.csv')).rejects.toThrow(/archive is corrupt/);
  });

  it('explains that a missing file blocks replay, citing the reason', async () => {
    const missing = 'f'.repeat(64);
    await expect(storage.get(missing)).rejects.toThrow(/cannot be replayed/);
    await expect(storage.get(missing)).rejects.toThrow(/ADR-005/);
  });

  it('reports presence without reading the file', async () => {
    const { hash } = await storage.put(FILE, 'a.csv');
    expect(await storage.has(hash)).toBe(true);
    expect(await storage.has('0'.repeat(64))).toBe(false);
  });
});

describe('storage keys agree with the ingestion fingerprint', () => {
  it('uses the same hash the duplicate check uses', async () => {
    // If these ever diverged, a file could be refused as a duplicate by the
    // database while being stored again under a different key, or vice versa.
    const { fileHash } = await import('@razorveda/shared');
    const stored = await storage.put(FILE, 'a.csv');
    expect(stored.hash).toBe(fileHash(FILE));
  });
});
