import { z } from 'zod';
import { OrderStatus, PaymentMode } from '../enums.js';
import {
  dateOnlySchema,
  moneySchema,
  percentSchema,
  pgEnum,
  pincodeSchema,
  uuidSchema,
} from '../primitives.js';

export const orderSchema = z.object({
  orderId: uuidSchema,
  orderNumber: z.string().min(1),
  customerId: uuidSchema,
  leadId: uuidSchema.nullable().default(null),
  sourceId: uuidSchema,
  bookedByEmployeeId: uuidSchema.nullable().default(null),
  orderDate: dateOnlySchema,
  dispatchDate: dateOnlySchema.nullable().default(null),
  deliveredDate: dateOnlySchema.nullable().default(null),
  rtoDate: dateOnlySchema.nullable().default(null),
  grossValue: moneySchema.default('0'),
  discountValue: moneySchema.default('0'),
  /**
   * The FULL order value, from the sheet column "Total amount".
   * NOT the sheet column "Final amount" - the words are inverted (defect B8, docs/06).
   */
  finalValue: moneySchema,
  /**
   * The sheet column "Final amount" = the manually typed employee credit.
   * Reconciliation only. Never used in a metric, score or incentive.
   * Expect roughly 31% of historical Shopify rows to disagree with the computed credit.
   */
  legacyCreditValue: moneySchema.nullable().default(null),
  /** Looked up from sku.shopify_base_price. NEVER typed by a human (F7). */
  companyBaseValue: moneySchema.default('0'),
  paymentMode: pgEnum(PaymentMode).default(PaymentMode.UNKNOWN),
  /** Two numeric columns, never one free-text field (F5). */
  prepaidAmount: moneySchema.default('0'),
  codAmount: moneySchema.default('0'),
  awbNumber: z.string().nullable().default(null),
  courierPartner: z.string().nullable().default(null),
  currentStatus: pgEnum(OrderStatus).default(OrderStatus.PENDING),
  shipState: z.string().nullable().default(null),
  shipPincode: pincodeSchema.nullable().default(null),
});

/** Product P and L lives here. A multi-line order must split across lines (F8). */
export const orderLineSchema = z.object({
  lineId: uuidSchema,
  orderId: uuidSchema,
  skuId: uuidSchema,
  quantity: z.number().int().positive().default(1),
  unitPrice: moneySchema,
  lineValue: moneySchema,
  isUpsell: z.boolean().default(false),
  isFreeItem: z.boolean().default(false),
});

/** APPEND ONLY. A state machine guards legal transitions. */
export const orderStatusEventSchema = z.object({
  eventId: uuidSchema,
  orderId: uuidSchema,
  fromStatus: pgEnum(OrderStatus).nullable().default(null),
  toStatus: pgEnum(OrderStatus),
  eventAt: z.string().datetime(),
  source: z.string().default('MANUAL'),
});

/** Handles the client caller values "Riya / Divya" and "Riya / Shopify". */
export const orderCreditSplitSchema = z.object({
  splitId: uuidSchema,
  orderId: uuidSchema,
  employeeId: uuidSchema,
  percent: percentSchema,
});

/**
 * Order entry payload. companyBaseValue is deliberately absent - it is resolved
 * server-side from sku.shopify_base_price and must never be accepted from a client.
 */
export const orderWriteSchema = z
  .object({
    customerId: uuidSchema,
    leadId: uuidSchema.optional(),
    sourceId: uuidSchema,
    orderDate: dateOnlySchema,
    lines: z
      .array(
        z.object({
          skuId: uuidSchema,
          quantity: z.number().int().positive(),
          unitPrice: moneySchema,
        }),
      )
      .min(1, 'an order must have at least one line - product revenue is computed from lines'),
    paymentMode: pgEnum(PaymentMode),
    prepaidAmount: moneySchema.default('0'),
    codAmount: moneySchema.default('0'),
    shipState: z.string().optional(),
    shipPincode: pincodeSchema.optional(),
    splits: z.array(z.object({ employeeId: uuidSchema, percent: percentSchema })).optional(),
  })
  .refine((o) => !o.splits || o.splits.reduce((s, x) => s + x.percent, 0) === 100, {
    message: 'credit split percentages must sum to exactly 100',
    path: ['splits'],
  });

export type Order = z.infer<typeof orderSchema>;
export type OrderLine = z.infer<typeof orderLineSchema>;
export type OrderStatusEvent = z.infer<typeof orderStatusEventSchema>;
export type OrderCreditSplit = z.infer<typeof orderCreditSplitSchema>;
export type OrderWrite = z.infer<typeof orderWriteSchema>;
