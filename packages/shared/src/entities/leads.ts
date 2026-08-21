import { z } from 'zod';
import { ActivityType, AssignMethod, LeadTemperature } from '../enums.js';
import { dateOnlySchema, moneySchema, pgEnum, uuidSchema } from '../primitives.js';

/** One instance of a customer arriving from a source. A customer has many leads. */
export const leadSchema = z.object({
  leadId: uuidSchema,
  customerId: uuidSchema,
  sourceId: uuidSchema,
  ingestionBatchId: uuidSchema.nullable().default(null),
  receivedAt: z.string().datetime(),
  validTill: dateOnlySchema.nullable().default(null),
  predictedValue: moneySchema.nullable().default(null),
  productInterest: z.string().nullable().default(null),
  temperature: pgEnum(LeadTemperature).nullable().default(null),
  currentDispositionId: uuidSchema.nullable().default(null),
  /** NULL = the unassigned pool. There is no separate pool table (docs/02). */
  assignedTo: uuidSchema.nullable().default(null),
  assignedAt: z.string().datetime().nullable().default(null),
  firstContactAt: z.string().datetime().nullable().default(null),
  /**
   * Drives Today's CD. Set on the FIRST activity with connected=true.
   * Do NOT substitute firstContactAt - contact is not connect (defect B5).
   */
  firstConnectedAt: z.string().datetime().nullable().default(null),
  lastContactAt: z.string().datetime().nullable().default(null),
  /** Fq. Also the Untouched Leads metric: contact_attempts = 0. */
  contactAttempts: z.number().int().nonnegative().default(0),
  /** CD/ND split. */
  everConnected: z.boolean().default(false),
  nextFollowupAt: z.string().datetime().nullable().default(null),
  isConverted: z.boolean().default(false),
  convertedOrderId: uuidSchema.nullable().default(null),
});

/** APPEND ONLY. Every assignment, transfer and 72h RECALL writes a row. */
export const leadAssignmentSchema = z.object({
  assignmentId: uuidSchema,
  leadId: uuidSchema,
  fromEmployeeId: uuidSchema.nullable().default(null),
  toEmployeeId: uuidSchema.nullable().default(null),
  assignedBy: uuidSchema.nullable().default(null),
  method: pgEnum(AssignMethod),
  /** Overridden pre-assign warnings are recorded here (docs/07 section 3). */
  reason: z.string().nullable().default(null),
  assignedAt: z.string().datetime(),
});

/** APPEND ONLY. Disposition is mandatory; the API rejects an activity without one. */
export const activitySchema = z.object({
  activityId: uuidSchema,
  leadId: uuidSchema.nullable().default(null),
  customerId: uuidSchema,
  employeeId: uuidSchema.nullable().default(null),
  type: pgEnum(ActivityType),
  connected: z.boolean().nullable().default(null),
  dispositionId: uuidSchema.nullable().default(null),
  /** Hinglish, verbatim. Never auto-corrected (docs/07 section 4). */
  remarkRaw: z.string().nullable().default(null),
  /** Written by the nightly Phase 4 batch. The raw remark always survives. */
  remarkNormalised: z.string().nullable().default(null),
  intentTags: z.array(z.string()).default([]),
  occurredAt: z.string().datetime(),
});

/**
 * What a rep may POST when logging a contact attempt.
 * Disposition is required, and a follow-up date is required when the chosen
 * disposition sets requires_followup_date - enforced by the API, not just the UI.
 */
export const activityWriteSchema = z.object({
  leadId: uuidSchema,
  type: pgEnum(ActivityType),
  connected: z.boolean().optional(),
  dispositionId: uuidSchema,
  remarkRaw: z.string().max(4000).optional(),
  followupAt: z.string().datetime().optional(),
});

/** Bulk assignment: filter, tick, pick a rep, assign. Never automatic (D-02). */
export const bulkAssignSchema = z.object({
  leadIds: z.array(uuidSchema).min(1).max(1000),
  toEmployeeId: uuidSchema,
  /** Present when the admin assigned past a warning. Logged, never blocked. */
  overrideReason: z.string().max(500).optional(),
});

export type Lead = z.infer<typeof leadSchema>;
export type LeadAssignment = z.infer<typeof leadAssignmentSchema>;
export type Activity = z.infer<typeof activitySchema>;
export type ActivityWrite = z.infer<typeof activityWriteSchema>;
export type BulkAssign = z.infer<typeof bulkAssignSchema>;
