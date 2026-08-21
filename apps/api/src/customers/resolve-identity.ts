/**
 * Identity resolution (docs/06 §4). The fix for F1: 954 unique mobiles spread
 * across 1,627 row-instances, 375 customers appearing in more than one tab, one
 * in eight.
 *
 * DESIGN NOTE — this module does NOT compute name similarity.
 *
 * Similarity is `pg_trgm` in Postgres (D-14). Reimplementing trigram scoring in
 * TypeScript would create a second source of truth for the most consequential
 * number in dedupe, and the two would drift the first time either side changed.
 * So the caller runs the SQL and passes the scores in, and this file is the pure
 * DECISION over scored candidates — every branch testable without a database, and
 * no drift possible by construction.
 */

/** docs/06 §4: auto-merge above 0.95, review 0.80–0.95, create below. */
export const AUTO_MERGE_CONFIDENCE = 0.95;
export const REVIEW_CONFIDENCE = 0.8;
/** Fuzzy match needs BOTH a name score this high AND a matching pincode. */
export const FUZZY_NAME_SIMILARITY = 0.85;

export type MatchedOn = 'PRIMARY_PHONE' | 'IDENTIFIER' | 'FUZZY';

export interface ResolutionInput {
  /** Output of normalisePhone: 10 digits starting 6-9, or null if un-keyable. */
  readonly normalisedPhone: string | null;
  readonly name: string | null;
  readonly pincode: string | null;
}

export interface Candidate {
  readonly customerId: string;
  readonly matchedOn: MatchedOn;
  /** pg_trgm similarity(customer.full_name, input.name). FUZZY candidates only. */
  readonly nameSimilarity?: number;
  /** FUZZY candidates only. */
  readonly pincodeMatches?: boolean;
}

export type Resolution =
  | {
      readonly action: 'UPDATE_EXISTING';
      readonly customerId: string;
      readonly confidence: number;
      readonly matchedOn: MatchedOn;
    }
  | {
      /** 0.80–0.95. Goes to the review queue, shown side by side with the differences. */
      readonly action: 'MERGE_CANDIDATE';
      readonly customerId: string;
      readonly confidence: number;
      readonly matchedOn: MatchedOn;
    }
  | { readonly action: 'CREATE_NEW'; readonly confidence: number }
  | {
      /** Un-keyable. Kept and queued for an admin, never discarded (F2). */
      readonly action: 'PARK';
      readonly reason: string;
    };

/**
 * A phone match is exact, so it carries full confidence. A fuzzy match carries
 * its name score.
 *
 * D-15 is what makes the phone cases unambiguous: one customer per mobile number.
 * A different recipient name on an order is an ordering fact stored on the order,
 * not a second customer — so a name that disagrees with a phone match is not
 * evidence against the match.
 */
function confidenceOf(candidate: Candidate): number {
  switch (candidate.matchedOn) {
    case 'PRIMARY_PHONE':
    case 'IDENTIFIER':
      return 1;
    case 'FUZZY':
      return candidate.nameSimilarity ?? 0;
  }
}

/** Phone matches first, then the strongest fuzzy score. */
function rank(a: Candidate, b: Candidate): number {
  const weight = (c: Candidate) => (c.matchedOn === 'PRIMARY_PHONE' ? 2 : c.matchedOn === 'IDENTIFIER' ? 1 : 0);
  const byKind = weight(b) - weight(a);
  return byKind !== 0 ? byKind : confidenceOf(b) - confidenceOf(a);
}

export function resolveIdentity(
  input: ResolutionInput,
  candidates: readonly Candidate[],
): Resolution {
  // A fuzzy candidate needs BOTH signals. Name alone is not enough: "Aarti" and
  // "Aarti" in different states are different people, and the client's data has
  // many single-word names.
  const usable = candidates.filter(
    (c) => c.matchedOn !== 'FUZZY' || (c.pincodeMatches === true && (c.nameSimilarity ?? 0) >= FUZZY_NAME_SIMILARITY),
  );

  const best = [...usable].sort(rank)[0];

  if (best) {
    const confidence = confidenceOf(best);
    if (confidence >= AUTO_MERGE_CONFIDENCE) {
      return {
        action: 'UPDATE_EXISTING',
        customerId: best.customerId,
        confidence,
        matchedOn: best.matchedOn,
      };
    }
    if (confidence >= REVIEW_CONFIDENCE) {
      return {
        action: 'MERGE_CANDIDATE',
        customerId: best.customerId,
        confidence,
        matchedOn: best.matchedOn,
      };
    }
  }

  // No usable match. A row with a valid phone becomes a new customer; a row
  // without one cannot be keyed, so it is parked rather than creating an
  // unreachable duplicate on every future upload (F2 — 10.9% of the client's rows).
  if (!input.normalisedPhone) {
    return {
      action: 'PARK',
      reason:
        'No valid mobile number, and no confident match on name and pincode. ' +
        'Parked for review — add a number or merge into an existing customer.',
    };
  }

  return { action: 'CREATE_NEW', confidence: 1 };
}
