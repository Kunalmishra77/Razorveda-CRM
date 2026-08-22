import { Body, Controller, Get, Inject, Post, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AuthedRequest } from '../auth/session.guard.js';
import { MasterDataService } from './master-data.service.js';

/**
 * Master Data (docs/07 §6). ADMIN only — everything here changes how money is
 * calculated or what people are measured against.
 */
@Controller('master')
@UseGuards(AdminGuard)
export class MasterDataController {
  constructor(@Inject(MasterDataService) private readonly master: MasterDataService) {}

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
