/**
 * Postgres enums mirrored as const objects + Zod schemas.
 *
 * CLAUDE.md section 5: "Enums in Postgres, mirrored as const objects in packages/shared."
 * This file is the single source of truth for api AND web.
 *
 * These MUST stay in lockstep with db/schema.sql. test/enum-parity.test.ts parses
 * the SQL and fails if the two ever drift — same guardrail as the metric registry.
 */

/** Two functional roles plus one OWNER account (CLAUDE.md rule 7, D-04). */
export const UserRole = { OWNER: 'OWNER', ADMIN: 'ADMIN', EMPLOYEE: 'EMPLOYEE' } as const;

/** Fixes F13 (roster drift): everything reads status from the employee master. */
export const EmployeeStatus = {
  ACTIVE: 'ACTIVE', ON_LEAVE: 'ON_LEAVE', SUSPENDED: 'SUSPENDED', EXITED: 'EXITED',
} as const;

/** Derived at identity resolution, never read from a file (docs/06 stage 4). */
export const CustomerType = { NEW: 'NEW', EXISTING: 'EXISTING' } as const;

export const BuyerStage = {
  PROSPECT: 'PROSPECT', FIRST: 'FIRST', SECOND: 'SECOND', THIRD: 'THIRD',
  REPEAT: 'REPEAT', LOYAL: 'LOYAL', DORMANT: 'DORMANT', CHURNED: 'CHURNED',
} as const;

export const IdentifierType = {
  MOBILE: 'MOBILE', ALT_MOBILE: 'ALT_MOBILE', WHATSAPP: 'WHATSAPP', EMAIL: 'EMAIL',
} as const;

/** Parsed from 121 free-text variants by parsePayment() (F5). */
export const PaymentMode = {
  COD: 'COD', PREPAID: 'PREPAID', PARTIAL_PREPAID: 'PARTIAL_PREPAID', UNKNOWN: 'UNKNOWN',
} as const;

export const OrderStatus = {
  PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', PROCESSING: 'PROCESSING',
  DISPATCHED: 'DISPATCHED', IN_TRANSIT: 'IN_TRANSIT', OFD: 'OFD',
  DELIVERED: 'DELIVERED', RTO: 'RTO', RETURNED: 'RETURNED', CANCELLED: 'CANCELLED',
  FAILED_DELIVERY: 'FAILED_DELIVERY', NO_RESPONSE: 'NO_RESPONSE', REFUSED: 'REFUSED',
} as const;

export const AttributionRule = {
  FULL_CREDIT: 'FULL_CREDIT', UPSELL_DELTA: 'UPSELL_DELTA', SPLIT_PERCENT: 'SPLIT_PERCENT',
} as const;

/** Append-only ledger. Corrections are new rows, never UPDATEs (CLAUDE.md rule 2). */
export const LedgerEntryType = {
  BOOKED_CREDIT: 'BOOKED_CREDIT', REALISED_CREDIT: 'REALISED_CREDIT',
  CLAWBACK: 'CLAWBACK', ADJUSTMENT: 'ADJUSTMENT', MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
} as const;

export const ActivityType = {
  CALL: 'CALL', WHATSAPP: 'WHATSAPP', SMS: 'SMS', NOTE: 'NOTE',
  STATUS_CHANGE: 'STATUS_CHANGE', ORDER: 'ORDER', SYSTEM: 'SYSTEM',
} as const;

export const DispositionCategory = {
  CONNECTED: 'CONNECTED', NOT_CONNECTED: 'NOT_CONNECTED',
  POSITIVE: 'POSITIVE', NEGATIVE: 'NEGATIVE', CLOSED: 'CLOSED',
} as const;

/** SHIFTED is the column-shift detector's verdict (F3, D-12). */
export const BatchStatus = {
  UPLOADED: 'UPLOADED', MAPPING: 'MAPPING', VALIDATING: 'VALIDATING', REVIEW: 'REVIEW',
  SHIFTED: 'SHIFTED', COMMITTED: 'COMMITTED', ROLLED_BACK: 'ROLLED_BACK', FAILED: 'FAILED',
} as const;

/** PARKED = un-keyable row kept, not discarded (F2: 10.9% of rows). */
export const RowStatus = {
  VALID: 'VALID', WARNING: 'WARNING', ERROR: 'ERROR',
  DUPLICATE: 'DUPLICATE', PARKED: 'PARKED',
} as const;

/** RECALL is written by the 72h untouched-lead return (D-02 / docs/10 step 10). */
export const AssignMethod = {
  MANUAL: 'MANUAL', BULK: 'BULK', TRANSFER: 'TRANSFER', RECALL: 'RECALL', SYSTEM: 'SYSTEM',
} as const;

export const LeadTemperature = { HOT: 'HOT', WARM: 'WARM', COLD: 'COLD' } as const;

/** Maps TS export name -> Postgres type name. Drives the parity test. */
export const PG_ENUM_NAMES = {
  UserRole: 'user_role',
  EmployeeStatus: 'employee_status',
  CustomerType: 'customer_type',
  BuyerStage: 'buyer_stage',
  IdentifierType: 'identifier_type',
  PaymentMode: 'payment_mode',
  OrderStatus: 'order_status',
  AttributionRule: 'attribution_rule',
  LedgerEntryType: 'ledger_entry_type',
  ActivityType: 'activity_type',
  DispositionCategory: 'disposition_cat',
  BatchStatus: 'batch_status',
  RowStatus: 'row_status',
  AssignMethod: 'assign_method',
  LeadTemperature: 'lead_temperature',
} as const;

export const ALL_ENUMS = {
  UserRole, EmployeeStatus, CustomerType, BuyerStage, IdentifierType, PaymentMode,
  OrderStatus, AttributionRule, LedgerEntryType, ActivityType, DispositionCategory,
  BatchStatus, RowStatus, AssignMethod, LeadTemperature,
} as const;

export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export type EmployeeStatus = (typeof EmployeeStatus)[keyof typeof EmployeeStatus];
export type CustomerType = (typeof CustomerType)[keyof typeof CustomerType];
export type BuyerStage = (typeof BuyerStage)[keyof typeof BuyerStage];
export type IdentifierType = (typeof IdentifierType)[keyof typeof IdentifierType];
export type PaymentMode = (typeof PaymentMode)[keyof typeof PaymentMode];
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export type AttributionRule = (typeof AttributionRule)[keyof typeof AttributionRule];
export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];
export type ActivityType = (typeof ActivityType)[keyof typeof ActivityType];
export type DispositionCategory = (typeof DispositionCategory)[keyof typeof DispositionCategory];
export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus];
export type RowStatus = (typeof RowStatus)[keyof typeof RowStatus];
export type AssignMethod = (typeof AssignMethod)[keyof typeof AssignMethod];
export type LeadTemperature = (typeof LeadTemperature)[keyof typeof LeadTemperature];
