import { z } from 'zod';
import { UserRole } from '../enums.js';
import { pgEnum, uuidSchema } from '../primitives.js';

/** APPEND ONLY. Before/after JSON on every mutation, login and ledger adjustment. */
export const auditLogSchema = z.object({
  logId: z.number().int().positive(),
  actorId: uuidSchema.nullable().default(null),
  actorRole: pgEnum(UserRole).nullable().default(null),
  action: z.string().min(1),
  entityType: z.string().nullable().default(null),
  entityId: uuidSchema.nullable().default(null),
  before: z.record(z.string(), z.unknown()).nullable().default(null),
  after: z.record(z.string(), z.unknown()).nullable().default(null),
  ipAddress: z.string().nullable().default(null),
  occurredAt: z.string().datetime(),
});

/**
 * APPEND ONLY. Written on every view and copy of a phone number.
 *
 * Reps dial from their own handsets, so they must see the full number (D-03).
 * That removes prevention as an option, and leaves detection and attribution.
 * Do not describe this in the UI as protection it is not.
 */
export const piiAccessLogSchema = z.object({
  accessId: z.number().int().positive(),
  employeeId: uuidSchema.nullable().default(null),
  leadId: uuidSchema.nullable().default(null),
  customerId: uuidSchema.nullable().default(null),
  action: z.enum(['VIEW', 'COPY']),
  ipAddress: z.string().nullable().default(null),
  occurredAt: z.string().datetime(),
});

/**
 * Velocity lock: 4 copy events in 90 seconds auto-locks the account.
 * A human working leads copies one number then talks for four minutes.
 * Machine-pace copying is a completely different signature.
 */
export const PII_COPY_VELOCITY_COUNT = 4;
export const PII_COPY_VELOCITY_WINDOW_SEC = 90;

/** Untouched-lead rules. 48h alerts the admin; 72h returns the lead to the pool. */
export const UNTOUCHED_ALERT_HOURS = 48;
export const UNTOUCHED_RECALL_HOURS = 72;

export type AuditLog = z.infer<typeof auditLogSchema>;
export type PiiAccessLog = z.infer<typeof piiAccessLogSchema>;
