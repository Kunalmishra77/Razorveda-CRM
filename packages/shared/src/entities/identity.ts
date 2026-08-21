import { z } from 'zod';
import { BuyerStage, CustomerType, IdentifierType } from '../enums.js';
import {
  dateOnlySchema, moneySchema, pgEnum, phoneSchema, pincodeSchema, uuidSchema,
} from '../primitives.js';

/**
 * The golden record. D-01: surrogate UUID PK, phone is a UNIQUE business key.
 * D-15: one customer per mobile number. A different recipient name on an order is
 * an ordering fact stored on the order, not a second customer.
 */
export const customerSchema = z.object({
  customerId: uuidSchema,
  /** Nullable: 10.9% of historical rows have no valid mobile and still must exist (F2). */
  primaryPhone: phoneSchema.nullable().default(null),
  fullName: z.string().nullable().default(null),
  gender: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  state: z.string().nullable().default(null),
  pincode: pincodeSchema.nullable().default(null),
  /** DERIVED at identity resolution. Never uploaded, never settable via the API. */
  customerType: pgEnum(CustomerType).default(CustomerType.NEW),
  firstOrderDate: dateOnlySchema.nullable().default(null),
  lastOrderDate: dateOnlySchema.nullable().default(null),
  lifetimeOrders: z.number().int().nonnegative().default(0),
  lifetimeValue: moneySchema.default('0'),
  /** DERIVED. The client's hand-typed Client Category held PIN codes on 14 rows. */
  stage: pgEnum(BuyerStage).default(BuyerStage.PROSPECT),
  rtoCount: z.number().int().nonnegative().default(0),
  ownerEmployeeId: uuidSchema.nullable().default(null),
  /** Repeat engine: delivered_date + sku.usage_days - 5. */
  nextDueDate: dateOnlySchema.nullable().default(null),
  doNotCall: z.boolean().default(false),
  mergedInto: uuidSchema.nullable().default(null),
});

/**
 * Many identifiers -> one customer. Holds every phone number in the business,
 * which is why it must carry an RLS policy (defect B1, CLAUDE.md section 7b).
 */
export const customerIdentifierSchema = z.object({
  identifierId: uuidSchema,
  customerId: uuidSchema,
  type: pgEnum(IdentifierType),
  value: z.string().min(1).max(120),
  isPrimary: z.boolean().default(false),
  /** Auto-merge above 0.95, review 0.80-0.95, create below (docs/06 stage 4). */
  confidence: z.number().min(0).max(1).default(1),
});

/** Fields an admin may actually send. Derived fields are absent by construction. */
export const customerWriteSchema = customerSchema
  .omit({
    customerId: true, customerType: true, stage: true, lifetimeOrders: true,
    lifetimeValue: true, firstOrderDate: true, lastOrderDate: true,
    rtoCount: true, nextDueDate: true, mergedInto: true,
  })
  .partial({ ownerEmployeeId: true });

export type Customer = z.infer<typeof customerSchema>;
export type CustomerIdentifier = z.infer<typeof customerIdentifierSchema>;
export type CustomerWrite = z.infer<typeof customerWriteSchema>;
