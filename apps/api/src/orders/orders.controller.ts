import { Body, Controller, Get, Inject, Post, Req, BadRequestException } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { money, sumMoney, mulQuantity, subMoney } from '@razorveda/shared';
import { withRlsContext } from '../db/rls-context.js';
import type { AuthedRequest } from '../auth/session.guard.js';
import { AttributionError, computeAttribution, type AttributionLine, type AttributionRule } from './attribution.js';

/**
 * Order Entry (docs/07 §4).
 *
 * "The rep sees exactly how they are scored, as they sell." That is the whole
 * point of the live credit preview: the F7 leak was invisible to everyone, and a
 * number the rep watches while selling is the opposite of invisible.
 *
 * `company_base_value` is never accepted from the client — `orderWriteSchema` has
 * no field for it, and it is looked up here from `sku.shopify_base_price`.
 */

const lineSchema = z.object({
  skuId: z.string().uuid(),
  quantity: z.number().int().positive().max(99),
  unitPrice: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/),
});

const orderSchema = z.object({
  leadId: z.string().uuid(),
  lines: z.array(lineSchema).min(1, 'An order needs at least one product.'),
  prepaidAmount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).default('0'),
  codAmount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).default('0'),
  /** Which lines arrived in the original cart vs the rep added. */
  upsellSkuIds: z.array(z.string().uuid()).default([]),
});

@Controller('orders')
export class OrdersController {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /** SKUs for the picker, with live pricing. */
  @Get('skus')
  async skus(@Req() request: AuthedRequest) {
    return withRlsContext(this.pool, request.session!, async (client) => {
      const { rows } = await client.query(
        `SELECT s.sku_id, s.sku_code, s.product_name, s.mrp::text, p.name AS product_line,
                s.shopify_base_price::text, s.shopify_base_price_confirmed
           FROM sku s JOIN product_line p ON p.line_id = s.line_id
          WHERE s.is_active ORDER BY p.name, s.product_name`,
      );
      return { ok: true, skus: rows };
    });
  }

  /**
   * The live credit preview. Computes, never saves.
   *
   * Same code path as the real thing, so what the rep sees while selling is what
   * the ledger records — a preview computed a second way would eventually
   * disagree with the payslip, which is exactly the trust problem this replaces.
   */
  @Post('preview')
  async preview(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message };

    return withRlsContext(this.pool, request.session!, async (client) => {
      const context = await this.loadContext(client, parsed.data.leadId, parsed.data.lines, parsed.data.upsellSkuIds);
      return { ok: true, ...this.attribution(context, parsed.data) };
    });
  }

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = orderSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const input = parsed.data;

    return withRlsContext(this.pool, request.session!, async (client) => {
      const context = await this.loadContext(client, input.leadId, input.lines, input.upsellSkuIds);
      const finalValue = sumMoney(input.lines.map((l) => mulQuantity(l.unitPrice, l.quantity)));

      // Payment must reconcile. Two numeric fields, never one free-text box (F5),
      // and a split that does not add up is a data problem now rather than an
      // unmeasurable prepaid ratio later.
      const paid = sumMoney([input.prepaidAmount, input.codAmount]);
      if (paid !== finalValue) {
        throw new BadRequestException(
          `Prepaid ₹${input.prepaidAmount} + COD ₹${input.codAmount} is ₹${paid}, but the order comes to ₹${finalValue}. They must match.`,
        );
      }

      const result = this.attribution(context, input);
      const paymentMode =
        Number(input.prepaidAmount) === 0 ? 'COD'
        : Number(input.codAmount) === 0 ? 'PREPAID'
        : 'PARTIAL_PREPAID';

      const { rows: [order] } = await client.query<{ order_id: string; order_number: string }>(
        `INSERT INTO "order" (order_number, customer_id, lead_id, source_id, booked_by_employee_id,
                              order_date, final_value, company_base_value, payment_mode,
                              prepaid_amount, cod_amount, ship_state, ship_pincode, current_status)
         VALUES ($1,$2,$3,$4, current_employee_id(), CURRENT_DATE, $5, $6, $7::payment_mode,
                 $8,$9,$10,$11,'PENDING')
      RETURNING order_id, order_number`,
        [
          `RV-${Date.now().toString(36).toUpperCase()}`,
          context.customerId, input.leadId, context.sourceId,
          finalValue, result.companyBaseValue, paymentMode,
          input.prepaidAmount, input.codAmount, context.state, context.pincode,
        ],
      );
      if (!order) throw new BadRequestException('Could not create that order.');

      for (const line of input.lines) {
        await client.query(
          `INSERT INTO order_line (order_id, sku_id, quantity, unit_price, line_value, is_upsell)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            order.order_id, line.skuId, line.quantity, line.unitPrice,
            mulQuantity(line.unitPrice, line.quantity),
            input.upsellSkuIds.includes(line.skuId),
          ],
        );
      }

      await client.query(
        `INSERT INTO order_status_event (order_id, from_status, to_status, source)
         VALUES ($1, NULL, 'PENDING', 'ORDER_ENTRY')`,
        [order.order_id],
      );

      // BOOKED_CREDIT only. Credit is earned on DELIVERY (CLAUDE.md rule 3), so
      // this row is provisional and the REALISED_CREDIT entry comes from the
      // status machine when the parcel lands.
      if (result.creditKnown) {
        await client.query(
          `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                           employee_credited_value, rule_applied, period_key, is_realised)
           VALUES ($1, current_employee_id(), 'BOOKED_CREDIT', $2, $3, $4, to_char(CURRENT_DATE,'YYYY-MM'), false)`,
          [order.order_id, result.companyBaseValue, result.employeeCreditedValue, result.ruleApplied],
        );
      }

      await client.query(
        `UPDATE lead SET is_converted = true, converted_order_id = $2, updated_at = now()
          WHERE lead_id = $1`,
        [input.leadId, order.order_id],
      );

      return {
        ok: true,
        orderNumber: order.order_number,
        finalValue,
        ...result,
      };
    });
  }

  /**
   * Attribution, with one deliberate softening.
   *
   * `computeAttribution` REFUSES an unconfirmed base price (D-81), and that is
   * right for the ledger — no money is computed from a guess. But a rep on a call
   * must still be able to record a real sale. An order that happened, happened.
   *
   * So the ORDER is always recordable; only the CREDIT waits. `creditKnown: false`
   * means no ledger row is written, the rep is told her credit is pending, and an
   * admin confirming the price in Master Data completes it.
   */
  private attribution(context: OrderContext, input: z.infer<typeof orderSchema>) {
    const lines: AttributionLine[] = input.lines.map((l) => {
      const sku = context.skus.get(l.skuId)!;
      return {
        skuId: sku.sku_code,
        quantity: l.quantity,
        shopifyBasePrice: sku.shopify_base_price,
        shopifyBasePriceConfirmed: sku.shopify_base_price_confirmed,
        isUpsell: input.upsellSkuIds.includes(l.skuId),
      };
    });

    const finalValue = sumMoney(input.lines.map((l) => mulQuantity(l.unitPrice, l.quantity)));

    try {
      const r = computeAttribution({
        rule: context.attributionRule,
        employeeCreditPercent: context.employeeCreditPercent,
        finalValue,
        lines,
      });
      return {
        creditKnown: true,
        companyBaseValue: r.companyBaseValue,
        employeeCreditedValue: r.employeeCreditedValue,
        ruleApplied: r.ruleApplied,
        note: 'Your credit realises when the order is delivered.',
      };
    } catch (e) {
      if (!(e instanceof AttributionError)) throw e;
      return {
        creditKnown: false,
        companyBaseValue: '0.00',
        employeeCreditedValue: '0.00',
        ruleApplied: 'PENDING_BASE_PRICE',
        // Says what happened and what happens next, without blaming the rep.
        note:
          'Your credit for this order is pending. The base price for one of these products ' +
          'has not been confirmed yet, so it cannot be worked out. Book the order — an admin ' +
          'will confirm the price and your credit will follow.',
      };
    }
  }

  private async loadContext(
    client: PoolClient,
    leadId: string,
    lines: ReadonlyArray<{ skuId: string }>,
    _upsells: readonly string[],
  ): Promise<OrderContext> {
    const { rows: [lead] } = await client.query<{
      customer_id: string; source_id: string; attribution: AttributionRule;
      employee_credit_percent: string; state: string | null; pincode: string | null;
    }>(
      `SELECT l.customer_id, l.source_id, s.attribution, s.employee_credit_percent::text,
              c.state, c.pincode
         FROM lead l
         JOIN lead_source s ON s.source_id = l.source_id
         JOIN customer c ON c.customer_id = l.customer_id
        WHERE l.lead_id = $1`,
      [leadId],
    );
    // RLS returned nothing for another rep's lead — same shape as lead detail.
    if (!lead) throw new BadRequestException('That lead was not found.');

    const { rows: skus } = await client.query<SkuRow>(
      `SELECT sku_id, sku_code, product_name, mrp::text,
              shopify_base_price::text, shopify_base_price_confirmed
         FROM sku WHERE sku_id = ANY($1::uuid[])`,
      [lines.map((l) => l.skuId)],
    );
    if (skus.length !== new Set(lines.map((l) => l.skuId)).size) {
      throw new BadRequestException('One of those products no longer exists.');
    }

    return {
      customerId: lead.customer_id,
      sourceId: lead.source_id,
      attributionRule: lead.attribution,
      employeeCreditPercent: money(lead.employee_credit_percent),
      state: lead.state,
      pincode: lead.pincode,
      skus: new Map(skus.map((s) => [s.sku_id, s])),
    };
  }
}

interface SkuRow {
  sku_id: string;
  sku_code: string;
  product_name: string;
  mrp: string;
  shopify_base_price: string | null;
  shopify_base_price_confirmed: boolean;
}

interface OrderContext {
  customerId: string;
  sourceId: string;
  attributionRule: AttributionRule;
  employeeCreditPercent: string;
  state: string | null;
  pincode: string | null;
  skus: Map<string, SkuRow>;
}
