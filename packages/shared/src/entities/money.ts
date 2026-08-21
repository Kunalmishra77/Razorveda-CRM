import { z } from 'zod';
import { LedgerEntryType } from '../enums.js';
import {
  dateOnlySchema,
  moneySchema,
  periodKeySchema,
  pgEnum,
  ratioSchema,
  uuidSchema,
} from '../primitives.js';

/**
 * APPEND ONLY. The source of truth for incentive.
 *
 * D-13: the Booked/Realised invariant is PER ORDER, not per period.
 *   realised_credited_value(order) <= booked_credited_value(order), always.
 * Period reporting is cash basis by default (realised keyed on delivered_date).
 * An order booked 28 Aug and delivered 3 Sep is August booked and September realised,
 * so realised CAN exceed booked within a period. That is correct, not a bug.
 */
export const attributionLedgerSchema = z.object({
  entryId: uuidSchema,
  orderId: uuidSchema,
  employeeId: uuidSchema,
  entryType: pgEnum(LedgerEntryType),
  /** Looked up, never typed. The whole fix for the 31% leakage in F7. */
  companyBaseValue: moneySchema.default('0'),
  employeeCreditedValue: moneySchema.default('0'),
  /** Which source rule produced this row, e.g. UPSELL_DELTA or FULL_CREDIT. */
  ruleApplied: z.string().min(1),
  ruleVersion: z.number().int().positive().default(1),
  isRealised: z.boolean().default(false),
  /** Cash-basis month. Incentive is paid in the month the parcel delivers (D-13). */
  periodKey: periodKeySchema,
  note: z.string().nullable().default(null),
});

/** Versioned and admin-editable. Never hardcoded. Values pending O-09. */
export const incentiveSlabSchema = z.object({
  slabId: uuidSchema,
  minValue: moneySchema,
  maxValue: moneySchema.nullable().default(null),
  percent: z.number().min(0).max(100),
  effectiveFrom: dateOnlySchema,
  effectiveTo: dateOnlySchema.nullable().default(null),
});

/**
 * Written nightly by the scoring job. Never edited by hand.
 * Reports on reps. Does NOT assign leads (docs/03 section 5).
 */
export const employeeScoreDailySchema = z.object({
  employeeId: uuidSchema,
  scoreDate: dateOnlySchema,
  leadsAssigned: z.number().int().nonnegative().default(0),
  leadsTouched: z.number().int().nonnegative().default(0),
  leadsUntouched: z.number().int().nonnegative().default(0),
  /** Self-reported: reps dial from their own handsets (D-03). Label as such in the UI. */
  dials: z.number().int().nonnegative().default(0),
  /** Self-reported. */
  connects: z.number().int().nonnegative().default(0),
  connectivityPct: ratioSchema.nullable().default(null),
  ordersBooked: z.number().int().nonnegative().default(0),
  ordersDelivered: z.number().int().nonnegative().default(0),
  ordersRto: z.number().int().nonnegative().default(0),
  bookedValue: moneySchema.default('0'),
  realisedValue: moneySchema.default('0'),
  creditedValue: moneySchema.default('0'),
  /** The incentive basis. */
  realisedCredited: moneySchema.default('0'),
  upsellIndex: z.number().nullable().default(null),
  rtoPct: ratioSchema.nullable().default(null),
  conversionPct: ratioSchema.nullable().default(null),
  followupSlaPct: ratioSchema.nullable().default(null),
  dataHygienePct: ratioSchema.nullable().default(null),
  efficiencyScore: z.number().min(0).max(100).nullable().default(null),
  /** Bayesian shrinkage with k=30 leads, so 12 leads and one lucky order cannot top the table. */
  shrinkageApplied: z.boolean().default(false),
});

export type AttributionLedger = z.infer<typeof attributionLedgerSchema>;
export type IncentiveSlab = z.infer<typeof incentiveSlabSchema>;
export type EmployeeScoreDaily = z.infer<typeof employeeScoreDailySchema>;
