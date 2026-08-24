import { Body, Controller, Get, Inject, Post, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { PendingCreditService } from './pending-credit.service.js';
import { MasterDataService } from './master-data.service.js';

/**
 * Master Data (docs/07 §6). ADMIN only — everything here changes how money is
 * calculated or what people are measured against.
 */
@Controller('master')
@UseGuards(AdminGuard)
export class MasterDataController {
  constructor(
    @Inject(MasterDataService) private readonly master: MasterDataService,
    @Inject(PendingCreditService) private readonly pendingCredit: PendingCreditService,
  ) {}

  @Get('skus')
  async skus(@Req() request: AuthedRequest) {
    const skus = await this.master.skus(request.session!);
    const unconfirmed = skus.filter((s) => !s.shopify_base_price_confirmed).length;
    return {
      ok: true,
      skus,
      unconfirmed,
      ...(unconfirmed > 0
        ? {
            warning:
              `${unconfirmed} active product(s) have no confirmed Shopify base price. Orders on ` +
              `them book normally and the rep earns NOTHING until a price is confirmed here.`,
          }
        : {}),
    };
  }

  @Post('skus/confirm-price')
  async confirmPrice(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = priceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return { ok: true, ...(await this.master.confirmBasePrice(request.session!, parsed.data)) };
  }

  /** What the file would do. Writes nothing. */
  @Post('skus/price-upload/preview')
  async previewPriceUpload(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = priceUploadSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return { ok: true, ...(await this.master.previewPriceUpload(request.session!, parsed.data.rows)) };
  }

  /**
   * Applies it, then completes any credit the new prices unblock.
   *
   * The two are joined ON PURPOSE. Confirming a price is only half of what the rep
   * was promised - "an admin will confirm the price and your credit will follow"
   * (D-124) - and for as long as completion was a separate button nobody knew
   * existed, the credit never followed. Doing it here means the promise is kept by
   * the same action that makes it keepable.
   *
   * Completion is idempotent, so an admin uploading the same file twice pays
   * nobody twice.
   */
  @Post('skus/price-upload/apply')
  async applyPriceUpload(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = priceUploadSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);

    const result = await this.master.applyPriceUpload(
      request.session!, parsed.data.rows, parsed.data.acknowledgeWarnings,
    );
    const credit = await this.pendingCredit.complete(request.session!);
    return { ok: true, ...result, credit };
  }

  /** Orders booked against an unconfirmed price, and why each is still waiting. */
  @Get('credit/pending')
  async pendingCreditList(@Req() request: AuthedRequest) {
    const orders = await this.pendingCredit.list(request.session!);
    return {
      ok: true,
      orders,
      waiting: orders.length,
      blocked: orders.filter((o) => o.blockedBy !== null).length,
    };
  }

  /** Completes what can be completed, without touching prices. */
  @Post('credit/complete')
  async completePendingCredit(@Req() request: AuthedRequest) {
    return { ok: true, ...(await this.pendingCredit.complete(request.session!)) };
  }

  @Post('skus/usage-days')
  async usageDays(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = usageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return this.master.setUsageDays(request.session!, parsed.data.skuId, parsed.data.usageDays ?? null);
  }

  @Get('incentive')
  async incentive(@Req() request: AuthedRequest) {
    return { ok: true, ...(await this.master.incentiveScheme(request.session!)) };
  }

  @Post('incentive/slabs')
  async slabs(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = slabsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return {
      ok: true,
      ...(await this.master.replaceSlabs(
        request.session!, parsed.data.effectiveFrom, parsed.data.slabs, parsed.data.confirmed,
      )),
    };
  }

  @Post('incentive/modifier')
  async modifier(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = modifierSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return {
      ok: true,
      ...(await this.master.replaceModifier(
        request.session!, parsed.data.modifierId, parsed.data.value,
        parsed.data.effectiveFrom, parsed.data.confirmed,
      )),
    };
  }

  @Get('roster')
  async roster(@Req() request: AuthedRequest) {
    return { ok: true, employees: await this.master.roster(request.session!) };
  }

  @Post('roster/target')
  async target(@Body() body: unknown, @Req() request: AuthedRequest) {
    const parsed = targetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return {
      ok: true,
      ...(await this.master.setTarget(request.session!, parsed.data.employeeId, parsed.data.monthlyTarget)),
    };
  }
}

const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Enter a number, like 500 or 499.50.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Give a date as YYYY-MM-DD.');

const priceSchema = z.object({ skuId: z.string().uuid(), basePrice: money });
/**
 * The uploaded rows.
 *
 * The FILE is parsed in the browser and posted as rows, the same shape ingestion
 * uses. Capped at 500: the client sells 20 SKUs, so anything near that bound is a
 * wrong file rather than a big catalogue, and it should be refused with a sentence
 * rather than accepted and audited 500 times.
 */
const priceUploadSchema = z.object({
  rows: z
    .array(z.object({ skuCode: z.string().min(1).max(64), basePrice: z.string().min(1).max(20) }))
    .max(500, 'That is more products than this catalogue has. Check the file.'),
  // Separate boolean, deliberately. A large price move applies only when the
  // admin has said in a distinct field that they meant it - not as a side effect
  // of clicking the same button twice.
  acknowledgeWarnings: z.boolean().optional().default(false),
});

const usageSchema = z.object({ skuId: z.string().uuid(), usageDays: z.number().int().nullable().optional() });
const targetSchema = z.object({ employeeId: z.string().uuid(), monthlyTarget: money });

const slabsSchema = z.object({
  effectiveFrom: isoDate,
  confirmed: z.boolean(),
  slabs: z.array(z.object({
    minValue: money,
    maxValue: money.nullable(),
    percent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'A percentage, like 2 or 2.50.'),
  })).min(1),
});

const modifierSchema = z.object({
  modifierId: z.string().uuid(),
  value: z.string().regex(/^-?\d{1,6}(\.\d{1,4})?$/, 'Enter a number.'),
  effectiveFrom: isoDate,
  confirmed: z.boolean(),
});
