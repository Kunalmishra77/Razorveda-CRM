import type { Pool } from 'pg';
import { duplicateFileMessage, fileHash, headerSignature } from '@razorveda/shared';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import type { StorageAdapter } from '../storage/storage.js';

/**
 * Upload and fingerprint (docs/06 stages 1 and 2).
 *
 * The order matters and is not the obvious one: **hash first, refuse duplicates
 * before storing anything.** Storing then checking would leave orphan files for
 * every re-upload, and the whole point of a duplicate refusal is that nothing
 * happens.
 */

export class DuplicateFileError extends Error {
  constructor(
    message: string,
    readonly existingBatchId: string,
  ) {
    super(message);
    this.name = 'DuplicateFileError';
  }
}

export interface UploadInput {
  readonly sourceId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** Header row, already split by the CSV/XLSX reader. */
  readonly headers: readonly string[];
}

export interface UploadResult {
  readonly batchId: string;
  readonly fileHash: string;
  readonly headerSignature: string;
  /** A saved mapping template matched, so no AI is needed (docs/06 stage 2). */
  readonly templateId: string | null;
  readonly rowsExpected: number;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class UploadService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: StorageAdapter,
  ) {}

  async upload(session: RlsSession, input: UploadInput, rowCount: number): Promise<UploadResult> {
    if (session.role !== 'ADMIN' && session.role !== 'OWNER') {
      throw new Error('Only an admin can upload a file.');
    }
    if (input.bytes.length === 0) {
      throw new Error('That file is empty. Check the export and try again.');
    }
    if (input.bytes.length > MAX_UPLOAD_BYTES) {
      throw new Error(
        `That file is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB. The limit is 20 MB — ` +
          `split the export and upload it in parts.`,
      );
    }

    const hash = fileHash(input.bytes);
    const signature = headerSignature(input.headers);

    return withRlsContext(this.pool, session, async (client) => {
      // Refuse BEFORE storing. A duplicate upload must change nothing at all,
      // and storing first would leave an orphan file behind every retry.
      const { rows: existing } = await client.query<{
        batch_id: string;
        file_name: string;
        created_at: string;
        rows_committed: number;
      }>(
        `SELECT batch_id, file_name, created_at, rows_committed
           FROM ingestion_batch WHERE file_hash = $1`,
        [hash],
      );

      const prior = existing[0];
      if (prior) {
        throw new DuplicateFileError(
          duplicateFileMessage({
            fileName: prior.file_name,
            uploadedOn: new Date(prior.created_at).toISOString().slice(0, 10),
            batchRef: prior.batch_id.slice(0, 8),
            rowsCommitted: prior.rows_committed,
          }),
          prior.batch_id,
        );
      }

      // Immutable, content-addressed. Idempotent by construction, so a crash
      // between storing and inserting leaves no inconsistency to clean up.
      const stored = await this.storage.put(input.bytes, input.fileName);

      const { rows: template } = await client.query<{ template_id: string }>(
        `SELECT template_id FROM column_mapping_template
          WHERE source_id = $1 AND header_signature = $2`,
        [input.sourceId, signature],
      );
      const templateId = template[0]?.template_id ?? null;

      const { rows: created } = await client.query<{ batch_id: string }>(
        `INSERT INTO ingestion_batch (source_id, uploaded_by, file_name, file_hash, file_url,
                                      row_count, mapping_template_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::uuid IS NULL THEN 'MAPPING' ELSE 'VALIDATING' END::batch_status)
      RETURNING batch_id`,
        [input.sourceId, session.userId, input.fileName, hash, stored.url, rowCount, templateId],
      );

      const batch = created[0];
      if (!batch) throw new Error('Failed to create the ingestion batch.');

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
         VALUES ($1,$2::user_role,'FILE_UPLOADED','ingestion_batch',$3,$4::jsonb)`,
        [
          session.userId,
          session.role,
          batch.batch_id,
          JSON.stringify({
            fileName: input.fileName,
            fileHash: hash,
            headerSignature: signature,
            templateMatched: templateId !== null,
            bytes: stored.bytes,
          }),
        ],
      );

      // Template use_count drives "which layouts are actually in use" in Master
      // Data, and tells us when a template has gone stale.
      if (templateId) {
        await client.query(
          `UPDATE column_mapping_template SET use_count = use_count + 1 WHERE template_id = $1`,
          [templateId],
        );
      }

      return {
        batchId: batch.batch_id,
        fileHash: hash,
        headerSignature: signature,
        templateId,
        rowsExpected: rowCount,
      };
    });
  }
}
