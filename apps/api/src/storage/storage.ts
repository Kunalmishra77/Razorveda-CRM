import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Raw-file storage (ADR-005: uploads are immutable and retained).
 *
 * "Every uploaded file is stored byte-for-byte. Any batch can be replayed after a
 * rule fix without asking anyone to re-download anything." That is only true if
 * storage physically cannot overwrite, so this interface has no update and no
 * delete — not as a convention, but because the operations do not exist.
 *
 * Content-addressed: the path IS the SHA-256 we already compute for the duplicate
 * check. That gives a second, independent duplicate signal — the filesystem
 * refuses a colliding write on its own — which is the same two-cheap-guards
 * pattern as the local-dev sentinel (D-40).
 */

export interface StoredFile {
  /** SHA-256 of the bytes. Also the storage key. */
  readonly hash: string;
  /** Opaque location string persisted on `ingestion_batch.file_url`. */
  readonly url: string;
  readonly bytes: number;
  /** True when this exact content was already stored. */
  readonly alreadyExisted: boolean;
}

export interface StorageAdapter {
  /** Store bytes under their own hash. Idempotent; never overwrites. */
  put(bytes: Uint8Array, originalName: string): Promise<StoredFile>;
  /** Retrieve by hash for replay. Verifies integrity before returning. */
  get(hash: string): Promise<Uint8Array>;
  has(hash: string): Promise<boolean>;
}

export class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageIntegrityError';
  }
}

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * Local filesystem storage for development.
 *
 * MinIO is a Docker service and Docker is not available on this machine, so
 * uploads land on disk under `.uploads/` — the same reasoning that put real
 * Postgres binaries in `node_modules` rather than a container (D-79). The
 * production adapter talks to MinIO on Coolify; both satisfy the same interface,
 * and the immutability guarantee is enforced here rather than assumed of the
 * backend.
 */
export class LocalFileStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  /** Two-character shard, so one directory never holds a hundred thousand files. */
  private pathFor(hash: string): string {
    return resolve(join(this.root, hash.slice(0, 2), `${hash}.bin`));
  }

  private metaPathFor(hash: string): string {
    return resolve(join(this.root, hash.slice(0, 2), `${hash}.json`));
  }

  async put(bytes: Uint8Array, originalName: string): Promise<StoredFile> {
    const hash = sha256(bytes);
    const path = this.pathFor(hash);

    if (existsSync(path)) {
      // Same content by definition — the hash is the name. Verify anyway: a
      // corrupted file on disk must surface here, not during a replay months
      // later when nobody remembers what the batch contained.
      const existing = new Uint8Array(readFileSync(path));
      if (sha256(existing) !== hash) {
        throw new StorageIntegrityError(
          `Stored file ${hash} no longer matches its own hash. The archive is corrupt; ` +
            `do not replay from it until this is resolved.`,
        );
      }
      return { hash, url: `file://${path}`, bytes: existing.length, alreadyExisted: true };
    }

    mkdirSync(dirname(path), { recursive: true });
    // No flag that permits overwriting. Writing the same content twice takes the
    // branch above; writing DIFFERENT content under the same hash is not
    // physically possible.
    writeFileSync(path, bytes, { flag: 'wx' });
    writeFileSync(
      this.metaPathFor(hash),
      JSON.stringify({ originalName, storedAt: new Date().toISOString(), bytes: bytes.length }, null, 2),
      { flag: 'wx' },
    );

    return { hash, url: `file://${path}`, bytes: bytes.length, alreadyExisted: false };
  }

  async get(hash: string): Promise<Uint8Array> {
    const path = this.pathFor(hash);
    if (!existsSync(path)) {
      throw new StorageIntegrityError(
        `No stored file for ${hash}. A batch cannot be replayed without its source file (ADR-005).`,
      );
    }
    const bytes = new Uint8Array(readFileSync(path));
    if (sha256(bytes) !== hash) {
      throw new StorageIntegrityError(
        `Stored file ${hash} does not match its hash — the archive has been altered.`,
      );
    }
    return bytes;
  }

  async has(hash: string): Promise<boolean> {
    return existsSync(this.pathFor(hash));
  }
}
