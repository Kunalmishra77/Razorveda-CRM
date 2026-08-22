/**
 * The rule a set of incentive slabs must satisfy (docs/03 §6).
 *
 * Extracted from `MasterDataService.replaceSlabs` because a mutation check proved
 * it was untested: deleting the gap check entirely broke nothing, since the only
 * way to exercise it was through a service that needs a database and an admin
 * session. A money rule nobody can test without standing up Postgres is a money
 * rule nobody tests.
 */

export interface SlabInput {
  readonly minValue: string;
  readonly maxValue: string | null;
  readonly percent: string;
}

export type SlabVerdict =
  | { readonly ok: true; readonly sorted: readonly SlabInput[] }
  | { readonly ok: false; readonly message: string };

export function validateSlabs(slabs: readonly SlabInput[]): SlabVerdict {
  if (slabs.length === 0) return { ok: false, message: 'Give at least one slab.' };

  const sorted = [...slabs].sort((a, b) => Number(a.minValue) - Number(b.minValue));

  // The lowest band must start at zero, or a rep below it has no slab and her
  // statement refuses to calculate (D-153) at month end rather than here.
  if (Number(sorted[0]!.minValue) !== 0) {
    return {
      ok: false,
      message:
        `The lowest slab must start at 0, or a rep below ₹${sorted[0]!.minValue} has no slab. ` +
        `Use 0% if nothing is payable at that level.`,
    };
  }

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const upper = sorted[i]!.maxValue;
    if (upper === null) {
      return { ok: false, message: 'Only the highest slab may have an open top end.' };
    }
    // Bands are half-open: a slab's top is the next one's bottom. Equal rather
    // than adjacent, because "0–99,999 then 100,000+" leaves every value between
    // 99,999 and 100,000 uncovered — which sounds pedantic until a rep lands on
    // 99,999.50.
    if (Number(upper) !== Number(sorted[i + 1]!.minValue)) {
      return {
        ok: false,
        message:
          `There is a gap between ₹${upper} and ₹${sorted[i + 1]!.minValue}. A rep landing in ` +
          `it would have no slab at all, and her statement would refuse to calculate.`,
      };
    }
  }

  return { ok: true, sorted };
}
