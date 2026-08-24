/**
 * Bulk Shopify base-price upload: validation and diffing.
 *
 * WHY BULK AT ALL. The client's Shopify price list changes often, and the
 * one-at-a-time confirm screen means 20+ SKUs retyped every time it moves. That
 * is not a workflow anyone sustains, and the failure mode is silent: prices drift
 * out of date, `company_base_value` is computed from stale figures, and every
 * rep's credit on those products is quietly wrong.
 *
 * WHY IT IS SAFE TO CHANGE A PRICE THAT HAS ALREADY PAID SOMEONE.
 *
 * `order.company_base_value` and `attribution_ledger.company_base_value` are both
 * SNAPSHOTTED when the order is booked, and the ledger is append-only. So a new
 * price applies to future orders only and can never reach back into credit already
 * earned. That property is what makes repeated uploads acceptable rather than
 * terrifying, and there is a test asserting it rather than a comment hoping it.
 *
 * PURE. No database, no session, no clock. Every rule below is decidable from the
 * uploaded rows plus the current SKU table, which is what makes the interesting
 * cases (a 10x typo, a price above MRP, the same SKU twice) testable without a
 * fixture.
 */

/** One row as it arrives from the parsed file. */
export interface UploadedPriceRow {
  readonly skuCode: string;
  readonly basePrice: string;
}

/** What the SKU table currently says. */
export interface CurrentSku {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly mrp: string;
  readonly basePrice: string | null;
  readonly confirmed: boolean;
}

export type PriceRowVerdict =
  | { readonly kind: 'REJECTED'; readonly skuCode: string; readonly reason: string }
  | {
      readonly kind: 'UNCHANGED';
      readonly skuCode: string;
      readonly skuId: string;
      readonly productName: string;
      readonly basePrice: string;
    }
  | {
      readonly kind: 'ACCEPTED';
      readonly skuCode: string;
      readonly skuId: string;
      readonly productName: string;
      readonly from: string | null;
      readonly to: string;
      /** Percent change, absolute, to one decimal. Null when there was no prior price. */
      readonly changePercent: string | null;
      /** Set when the change is large enough to want a human to look at it. */
      readonly warning?: string;
    };

export interface PriceUploadPlan {
  readonly verdicts: readonly PriceRowVerdict[];
  readonly accepted: number;
  readonly unchanged: number;
  readonly rejected: number;
  /** Accepted rows carrying a warning. Committing these needs `acknowledgeWarnings`. */
  readonly needsAcknowledgement: number;
}

/**
 * A change this large is more likely a typo than a repricing.
 *
 * 249 typed as 2490 is a tenfold error that would make the rep's credit negative
 * on every sale of that product; 499 typed as 49 would credit her the whole order.
 * Both are caught by the MRP rule only sometimes, so magnitude is checked too.
 *
 * It WARNS rather than rejects: a genuine 60% price cut is a thing that happens,
 * and refusing it outright would send the admin back to the one-at-a-time screen
 * to do exactly what the upload refused. The admin acknowledges and it applies.
 */
const LARGE_CHANGE_PERCENT = 50;

const MONEY = /^\d{1,8}(\.\d{1,2})?$/;

/**
 * Builds the plan. Nothing is written; this is what the admin sees before deciding.
 *
 * REJECTIONS ARE PER ROW, and the whole file is never abandoned for one bad line.
 * An admin who uploads 40 products and has one unknown SKU code should be able to
 * apply the 39 and fix the one, rather than being told "the file is invalid".
 *
 * The exception is a DUPLICATE SKU inside one file: both copies are rejected,
 * because picking one silently means the price that lands depends on row order.
 */
export function planPriceUpload(
  rows: readonly UploadedPriceRow[],
  current: readonly CurrentSku[],
): PriceUploadPlan {
  const bySkuCode = new Map(current.map((s) => [s.skuCode.trim().toUpperCase(), s]));

  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = (r.skuCode ?? '').trim().toUpperCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  const verdicts: PriceRowVerdict[] = rows.map((r): PriceRowVerdict => {
    const code = (r.skuCode ?? '').trim();
    const key = code.toUpperCase();
    const price = (r.basePrice ?? '').trim();

    if (!code) return { kind: 'REJECTED', skuCode: code, reason: 'This row has no product code.' };

    if ((seen.get(key) ?? 0) > 1) {
      return {
        kind: 'REJECTED',
        skuCode: code,
        reason:
          `${code} appears more than once in this file with no way to tell which price is meant. ` +
          `Remove the duplicate and upload again.`,
      };
    }

    const sku = bySkuCode.get(key);
    if (!sku) {
      return {
        kind: 'REJECTED',
        skuCode: code,
        // Never silently skipped. An unknown code usually means the file is from a
        // different catalogue, or a product was renamed — both worth knowing.
        reason: `There is no active product with the code ${code}. Check the code, or add the product first.`,
      };
    }

    if (!MONEY.test(price)) {
      return {
        kind: 'REJECTED',
        skuCode: code,
        reason: `"${price}" is not a price. Use a number like 500 or 499.50.`,
      };
    }

    if (Number(price) <= 0) {
      return {
        kind: 'REJECTED',
        skuCode: code,
        reason:
          `A base price of ${price} for ${sku.productName} would credit the rep the entire ` +
          `order value. If this product genuinely has no committed value, leave it unset.`,
      };
    }

    // Same rule as the single-SKU screen, and for the same reason: a base above
    // MRP means the company committed more than the customer pays, so the rep's
    // credit is negative. Refused rather than clamped — clamping hides a typo.
    if (Number(price) > Number(sku.mrp)) {
      return {
        kind: 'REJECTED',
        skuCode: code,
        reason:
          `${price} is more than the ${sku.mrp} MRP for ${sku.productName}, so the rep's ` +
          `credit would be negative. Check the figure.`,
      };
    }

    // Already exactly this, and already confirmed: nothing to do. Reported rather
    // than hidden, so the counts in the preview add up to the file the admin sent.
    if (sku.confirmed && sku.basePrice !== null && Number(sku.basePrice) === Number(price)) {
      return { kind: 'UNCHANGED', skuCode: code, skuId: sku.skuId, productName: sku.productName, basePrice: price };
    }

    const from = sku.basePrice;
    const changePercent =
      from !== null && Number(from) > 0
        ? (Math.abs((Number(price) - Number(from)) / Number(from)) * 100).toFixed(1)
        : null;

    // Only a CONFIRMED price is worth warning about moving.
    //
    // An unconfirmed figure is a suggestion reverse-engineered from the client's
    // order data (O-02/D-81) that nobody has vouched for. Replacing it is the
    // entire point of the upload, so a large move there is expected rather than
    // suspicious — and warning on it would put a warning on almost every row of
    // the first upload, which is how an admin learns to click straight through.
    const warning =
      sku.confirmed && changePercent !== null && Number(changePercent) >= LARGE_CHANGE_PERCENT
        ? `${sku.productName} moves from ${from} to ${price} — a ${changePercent}% change. ` +
          `Large moves are usually a typo. Confirm this is a real repricing.`
        : undefined;

    return {
      kind: 'ACCEPTED',
      skuCode: code,
      skuId: sku.skuId,
      productName: sku.productName,
      from,
      to: price,
      changePercent,
      ...(warning ? { warning } : {}),
    };
  });

  const accepted = verdicts.filter((v) => v.kind === 'ACCEPTED');

  return {
    verdicts,
    accepted: accepted.length,
    unchanged: verdicts.filter((v) => v.kind === 'UNCHANGED').length,
    rejected: verdicts.filter((v) => v.kind === 'REJECTED').length,
    needsAcknowledgement: accepted.filter((v) => v.kind === 'ACCEPTED' && v.warning !== undefined).length,
  };
}
