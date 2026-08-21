import { z } from 'zod';
import { BatchStatus, RowStatus } from '../enums.js';
import { pgEnum, sha256Schema, uuidSchema } from '../primitives.js';

/**
 * Header signature -> mapping. Hit on ~95% of days, and no AI runs at all.
 * Miss goes to the AI adapter, and a mapping below 0.9 confidence is never auto-applied.
 */
export const columnMappingTemplateSchema = z.object({
  templateId: uuidSchema,
  sourceId: uuidSchema,
  /** SHA-256 of the sorted, trimmed, lowercased header row. */
  headerSignature: sha256Schema,
  mapping: z.record(z.string(), z.string()),
  confidence: z.number().min(0).max(1).nullable().default(null),
  confirmedBy: uuidSchema.nullable().default(null),
  useCount: z.number().int().nonnegative().default(0),
});

export const ingestionBatchSchema = z.object({
  batchId: uuidSchema,
  sourceId: uuidSchema,
  uploadedBy: uuidSchema,
  fileName: z.string().min(1),
  /**
   * SHA-256 of the raw bytes, UNIQUE. A duplicate hash is REFUSED, never merged -
   * this is what stops a daily Shopify export being counted twice.
   */
  fileHash: sha256Schema,
  fileUrl: z.string().min(1),
  rowCount: z.number().int().nonnegative().default(0),
  rowsValid: z.number().int().nonnegative().default(0),
  rowsException: z.number().int().nonnegative().default(0),
  rowsDuplicate: z.number().int().nonnegative().default(0),
  rowsCommitted: z.number().int().nonnegative().default(0),
  status: pgEnum(BatchStatus).default(BatchStatus.UPLOADED),
  /** Populated when status is SHIFTED: which column failed, and a sample (F3, D-12). */
  shiftDetail: z
    .object({
      column: z.string(),
      failureRate: z.number().min(0).max(1),
      expectedType: z.string(),
      sample: z.array(z.string()),
    })
    .nullable()
    .default(null),
});

export const stagingRowSchema = z.object({
  stagingId: uuidSchema,
  batchId: uuidSchema,
  rowNumber: z.number().int().positive(),
  raw: z.record(z.string(), z.unknown()),
  mapped: z.record(z.string(), z.unknown()).nullable().default(null),
  normalised: z.record(z.string(), z.unknown()).nullable().default(null),
  validationStatus: pgEnum(RowStatus).default(RowStatus.VALID),
  validationErrors: z
    .array(z.object({ field: z.string(), code: z.string(), message: z.string() }))
    .default([]),
  resolvedCustomerId: uuidSchema.nullable().default(null),
  resolvedAction: z.enum(['CREATE', 'UPDATE', 'MERGE_CANDIDATE', 'PARK']).nullable().default(null),
});

/**
 * The admin sees ONLY rows that are WARNING, ERROR or DUPLICATE.
 * Clean rows are never rendered - that is the entire point (docs/06 stage 6).
 */
export const EXCEPTION_ROW_STATUSES = [
  RowStatus.WARNING,
  RowStatus.ERROR,
  RowStatus.DUPLICATE,
] as const;

export type ColumnMappingTemplate = z.infer<typeof columnMappingTemplateSchema>;
export type IngestionBatch = z.infer<typeof ingestionBatchSchema>;
export type StagingRow = z.infer<typeof stagingRowSchema>;
