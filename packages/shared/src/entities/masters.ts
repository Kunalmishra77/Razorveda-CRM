import { z } from 'zod';
import {
  AttributionRule, DispositionCategory, EmployeeStatus, UserRole,
} from '../enums.js';
import { dateOnlySchema, moneySchema, pgEnum, ratioSchema, uuidSchema } from '../primitives.js';

export const productLineSchema = z.object({
  lineId: uuidSchema,
  code: z.string().min(1),
  name: z.string().min(1),
  isActive: z.boolean().default(true),
});

export const skuSchema = z.object({
  skuId: uuidSchema,
  skuCode: z.string().min(1),
  productName: z.string().min(1),
  lineId: uuidSchema,
  variant: z.string().nullable().default(null),
  packSize: z.string().nullable().default(null),
  mrp: moneySchema,
  /** Drives UPSELL_DELTA attribution (F7). Values are inferred pending O-02. */
  shopifyBasePrice: moneySchema.nullable().default(null),
  /** Drives the repeat-purchase engine: next_due = delivered + usage_days - 5. O-03. */
  usageDays: z.number().int().positive().nullable().default(null),
  nameAliases: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
});

export const appUserSchema = z.object({
  userId: uuidSchema,
  email: z.string().email(),
  role: pgEnum(UserRole),
  isLocked: z.boolean().default(false),
  lockedReason: z.string().nullable().default(null),
  lastLoginAt: z.string().datetime().nullable().default(null),
});

export const employeeSchema = z.object({
  employeeId: uuidSchema,
  userId: uuidSchema.nullable().default(null),
  empCode: z.string().min(1),
  fullName: z.string().min(1),
  /** Fixes F13. Roster is provisional pending O-01 (D-19). */
  status: pgEnum(EmployeeStatus).default(EmployeeStatus.ACTIVE),
  monthlyTarget: moneySchema.default('0'),
  wipCap: z.number().int().nonnegative().default(150),
  shiftStart: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  shiftEnd: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  joinedOn: dateOnlySchema.nullable().default(null),
  exitedOn: dateOnlySchema.nullable().default(null),
});

export const leadSourceSchema = z.object({
  sourceId: uuidSchema,
  code: z.string().min(1),
  displayName: z.string().min(1),
  /** Lead shelf life — "Data Valid Till". Most CRMs never model decay at all. */
  validityDays: z.number().int().positive(),
  expectedConversionRate: ratioSchema,
  attribution: pgEnum(AttributionRule),
  /** 100 for every source in v1; O-11 asks the client about recovery sources (D-16). */
  employeeCreditPercent: z.number().min(0).max(100).default(100),
  /** Resolves the 15-06-26 vs 2026-12-06 ambiguity per source (docs/06 normaliseDate). */
  dateLocale: z.enum(['DMY', 'MDY', 'YMD']).default('DMY'),
  isActive: z.boolean().default(true),
});

export const dispositionSchema = z.object({
  dispositionId: uuidSchema,
  code: z.string().min(1),
  label: z.string().min(1),
  category: pgEnum(DispositionCategory),
  isTerminal: z.boolean().default(false),
  /** When true the UI blocks save without a follow-up date (docs/07 section 4). */
  requiresFollowupDate: z.boolean().default(false),
  countsAsConnect: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

/** Fixes F4: 49 spellings of ~12 outcomes. Alias test asserts every seeded row resolves (D-20). */
export const dispositionAliasSchema = z.object({
  aliasId: uuidSchema,
  dispositionId: uuidSchema,
  alias: z.string().min(1),
});

/** Every "per day required" metric divides by this. Never a hardcoded weekend assumption. O-08. */
export const workingCalendarSchema = z.object({
  calendarDate: dateOnlySchema,
  isWorkingDay: z.boolean().default(true),
});

export type ProductLine = z.infer<typeof productLineSchema>;
export type Sku = z.infer<typeof skuSchema>;
export type AppUser = z.infer<typeof appUserSchema>;
export type Employee = z.infer<typeof employeeSchema>;
export type LeadSource = z.infer<typeof leadSourceSchema>;
export type Disposition = z.infer<typeof dispositionSchema>;
export type DispositionAlias = z.infer<typeof dispositionAliasSchema>;
export type WorkingCalendar = z.infer<typeof workingCalendarSchema>;
