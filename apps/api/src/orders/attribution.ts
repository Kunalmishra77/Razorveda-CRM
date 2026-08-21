import {
  cmpMoney, money, mulQuantity, percentOfMoney, splitMoney, subMoney, sumMoney,
} from '@razorveda/shared';

/**
 * The attribution engine (docs/03 §4). The fix for F7: 16 of 52 Shopify upsell
 * rows credit the rep the FULL order value because a human forgot the subtraction,
 * leaking 31% of upsell attribution.
 *
 * `company_base_value` is looked up, never typed and never accepted from a client
 * — `orderWriteSchema` has no field for it at all, so the leak is unreachable from
 * the API rather than merely discouraged.
 */

export type AttributionRule = 'FULL_CREDIT' | 'UPSELL_DELTA' | 'SPLIT_PERCENT';

export interface AttributionLine {
  readonly skuId: string;
  readonly quantity: number;
  /**
   * `sku.shopify_base_price`. NULL where the SKU has no configured base price —
   * which is normal for a SKU that is never a Shopify cart item.
   */
  readonly shopifyBasePrice: string | null;
  /**
   * `sku.shopify_base_price_confirmed`. False means the value is the inferred
   * seed suggestion, not a price a human has stood behind (O-02, D-81).
   */
  readonly shopifyBasePriceConfirmed: boolean;
  /**
   * False = arrived in the original cart. True = the rep added it.
   * This is what separates committed value from earned value.
   */
  readonly isUpsell: boolean;
}

export interface AttributionInput {
  readonly rule: AttributionRule;
  /** `lead_source.employee_credit_percent`. 100 for every source in v1 (D-16, O-11). */
  readonly employeeCreditPercent: string;
  readonly finalValue: string;
  readonly lines: readonly AttributionLine[];
  /**
   * WA_CAMPAIGN only: the order value imported with the campaign lead. Shopify
   * derives its base from SKU prices; a campaign order arrives with a value.
   */
  readonly importedOrderValue?: string | null;
  /** Ordered (employeeId, percent). Must sum to 100. The "Riya / Divya" case. */
  readonly splits?: readonly { readonly employeeId: string; readonly percent: string }[];
}

export interface AttributionResult {
  readonly companyBaseValue: string;
  readonly employeeCreditedValue: string;
  readonly ruleApplied: string;
  readonly perEmployee: readonly { readonly employeeId: string; readonly creditedValue: string }[];
}

/** Thrown rather than defaulting to zero. See below — this is the whole point. */
export class AttributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributionError';
  }
}

/**
 * Company base for an UPSELL_DELTA order = the value already committed before the
 * rep touched it: the non-upsell lines, priced at their Shopify base price.
 *
 * A non-upsell line whose SKU has no `shopify_base_price` is an ERROR, never a
 * silent zero. Defaulting to zero would credit the rep the entire order value —
 * which is exactly the F7 defect, reproduced faithfully in code. Failing loudly
 * sends the row to the exception queue where a human decides. O-02 is resolved as
 * a MECHANISM, not a list: the admin fills prices in Master Data, so this firing
 * on a fresh install is the workflow starting, not a defect (D-81).
 */
function upsellBaseValue(lines: readonly AttributionLine[]): string {
  const committed = lines.filter((l) => !l.isUpsell);
  if (committed.length === 0) return money('0');

  const missing = committed.filter((l) => l.shopifyBasePrice === null);
  if (missing.length > 0) {
    throw new AttributionError(
      `Cannot compute company base value: ${missing.length} non-upsell line(s) ` +
        `have no shopify_base_price (sku ${missing.map((m) => m.skuId).join(', ')}). ` +
        `Set the base price in Master Data, or mark the line as an upsell. ` +
        `Defaulting to zero would credit the rep the entire order value (F7).`,
    );
  }

  // A price nobody has confirmed is a guess, and this number decides what a rep
  // is paid. The seeded 899 / 849 / 949 were reverse-engineered from order data;
  // they are a suggestion for the admin, not an input to payroll. Refusing here
  // routes the order to the exception queue where an admin confirms the price and
  // retries — which is the workflow, not a failure. (O-02, D-81)
  const unconfirmed = committed.filter((l) => !l.shopifyBasePriceConfirmed);
  if (unconfirmed.length > 0) {
    throw new AttributionError(
      `Cannot compute company base value: ${unconfirmed.length} line(s) use an ` +
        `UNCONFIRMED base price (sku ${unconfirmed.map((m) => m.skuId).join(', ')}). ` +
        `The seeded value is inferred from historical orders, not a confirmed price. ` +
        `An admin must confirm it in Master Data before it can decide anyone's credit.`,
    );
  }

  return sumMoney(committed.map((l) => mulQuantity(l.shopifyBasePrice as string, l.quantity)));
}

export function computeAttribution(input: AttributionInput): AttributionResult {
  const finalValue = money(input.finalValue);

  let companyBaseValue: string;
  let ruleApplied: string;

  switch (input.rule) {
    case 'UPSELL_DELTA': {
      companyBaseValue =
        input.importedOrderValue != null
          ? money(input.importedOrderValue) // WA_CAMPAIGN: order arrived with the lead
          : upsellBaseValue(input.lines); // SHOPIFY: derived from sku.shopify_base_price
      ruleApplied = input.importedOrderValue != null ? 'UPSELL_DELTA_IMPORTED' : 'UPSELL_DELTA_SKU';
      break;
    }
    case 'FULL_CREDIT':
    case 'SPLIT_PERCENT':
      companyBaseValue = money('0');
      ruleApplied = input.rule;
      break;
  }

  // A base above the final value would mean a negative credit — the rep
  // discounted below the committed cart. Clamp to zero rather than paying a
  // negative: a clawback is an event on the ledger, not an arithmetic accident.
  if (cmpMoney(companyBaseValue, finalValue) > 0) {
    companyBaseValue = finalValue;
    ruleApplied += '_CLAMPED';
  }

  const delta = subMoney(finalValue, companyBaseValue);
  // employee_credit_percent is 100 for every source in v1, so this is usually a
  // no-op — but it is a seed value, so changing it must never require a code
  // change (D-16, O-11).
  const employeeCreditedValue = percentOfMoney(delta, money(input.employeeCreditPercent));

  const splits = input.splits ?? [];
  const perEmployee =
    splits.length === 0
      ? []
      : splitMoney(
          employeeCreditedValue,
          splits.map((s) => s.percent),
        ).map((creditedValue, i) => ({
          employeeId: (splits[i] as { employeeId: string }).employeeId,
          creditedValue,
        }));

  return { companyBaseValue, employeeCreditedValue, ruleApplied, perEmployee };
}

/**
 * Product-line revenue comes from `order_line`, never from a single product
 * column (F8). Skinwise reports ₹0 against ₹2,51,698 of actual sales precisely
 * because a multi-line order could not split across categories.
 */
export function splitLineRevenue(
  lines: readonly { readonly lineId: string; readonly lineValue: string; readonly productLine: string }[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    out.set(l.productLine, sumMoney([out.get(l.productLine) ?? '0', l.lineValue]));
  }
  return out;
}
