/**
 * Column mapping (docs/06 stage 2).
 *
 * The order is deliberate and AI is last:
 *
 *   1. saved template by header signature   ~95% of days, no AI at all
 *   2. deterministic alias dictionary       the client's known header variants
 *   3. AI proposal, admin confirms          genuinely unseen headers only
 *
 * ADR-004: AI is never on the critical path. If the provider is down, steps 1 and
 * 2 still run and anything left goes to manual mapping — ingestion completes
 * either way.
 *
 * F6 measured the variants: `Number` / `Phone no` / `Phoneno`, `Customer name` /
 * `CustomerName` / `Name`, `Product detail` / `ProductDeatil`, `Amount` /
 * `Total amount`, `Agent` / `Caller name` / `CallerName`. None of that needs a
 * language model — it needs a list, which is what this is.
 */

/** Never auto-apply an AI mapping below this (docs/06 stage 2). */
export const MIN_AUTO_APPLY_CONFIDENCE = 0.9;

/** Confidence assigned to an exact hit in the alias dictionary. */
export const ALIAS_CONFIDENCE = 1;

export type TargetField =
  | 'external_ref' | 'order_date' | 'delivered_date' | 'rto_date'
  | 'full_name' | 'primary_phone' | 'alt_phone'
  | 'product_text' | 'product_line_text'
  | 'final_value' | 'legacy_credit_value' | 'payment_mode_text'
  | 'address' | 'city' | 'state' | 'pincode'
  | 'caller_name' | 'campaign_name' | 'ad_name' | 'platform'
  | 'awb_number' | 'courier_partner' | 'status_text' | 'remark' | 'reason'
  | 'customer_category' | 'source_note';

const canon = (h: string): string => h.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Known header text to target field. Keys are canonicalised on lookup, so
 * `Phone no`, `PHONE NO` and `phone  no` all land here.
 */
const ALIASES: ReadonlyArray<readonly [string, TargetField]> = [
  // identity
  ['number', 'primary_phone'], ['phone no', 'primary_phone'], ['phoneno', 'primary_phone'],
  ['phone number', 'primary_phone'], ['phone_number', 'primary_phone'], ['mobile', 'primary_phone'],
  ['alt number', 'alt_phone'], ['alt no', 'alt_phone'], ['alternate number', 'alt_phone'],
  ['name', 'full_name'], ['customer name', 'full_name'], ['customername', 'full_name'],
  ['full_name', 'full_name'], ['client name', 'full_name'],

  // order
  ['order id', 'external_ref'], ['order no', 'external_ref'], ['orderid', 'external_ref'],
  ['date', 'order_date'], ['order date', 'order_date'], ['created_time', 'order_date'],
  ['delivered date', 'delivered_date'], ['rto date', 'rto_date'],

  // product
  ['product', 'product_text'], ['product detail', 'product_text'],
  ['productdeatil', 'product_text'], ['product details', 'product_text'],
  ['item', 'product_text'],
  ['typ', 'product_line_text'], ['type', 'product_line_text'],

  // money — see the deny-list below, this is where B8 bites
  ['amount', 'final_value'], ['total amount', 'final_value'], ['order value', 'final_value'],
  ['final amount', 'legacy_credit_value'],
  ['payment mode', 'payment_mode_text'], ['paymentmode', 'payment_mode_text'],
  ['payment', 'payment_mode_text'],

  // geography
  ['address', 'address'], ['city', 'city'], ['state', 'state'],
  ['pincode', 'pincode'], ['pin code', 'pincode'], ['pin', 'pincode'],

  // attribution and channel
  ['agent', 'caller_name'], ['caller name', 'caller_name'], ['callername', 'caller_name'],
  ['agent name', 'caller_name'], ['bde', 'caller_name'],
  ['campaign_name', 'campaign_name'], ['campaign', 'campaign_name'],
  ['ad_name', 'ad_name'], ['platform', 'platform'],

  // logistics and outcome
  ['awb', 'awb_number'], ['awb no', 'awb_number'], ['courier', 'courier_partner'],
  ['status', 'status_text'], ['order status', 'status_text'],
  ['remark', 'remark'], ['remarks', 'remark'], ['reason', 'reason'],

  // free-text columns that exist but carry no typed meaning
  ['client category', 'customer_category'], ['category', 'customer_category'],
  ['data resource', 'source_note'], ['data source', 'source_note'],
];

const ALIAS_MAP: ReadonlyMap<string, TargetField> = new Map(ALIASES);

/**
 * Headers that must NEVER be mapped to a given field, whatever a heuristic or a
 * language model proposes (docs/06 money mapping, defect B8).
 *
 * The sheet's `Final amount` is NOT the order total — it is the manually typed
 * employee credit. The words are inverted. A mapper matching on "final" would
 * corrupt every historical order and quietly change what every rep is paid, so
 * the rule is a hard block rather than a ranking preference.
 */
const DENY: ReadonlyArray<readonly [string, TargetField]> = [
  ['final amount', 'final_value'],
  ['final value', 'final_value'],
  ['credit', 'final_value'],
  ['employee credit', 'final_value'],
];

export function isDenied(header: string, target: TargetField): boolean {
  const c = canon(header);
  return DENY.some(([h, t]) => h === c && t === target);
}

export interface ColumnProposal {
  readonly sourceHeader: string;
  readonly targetField: TargetField | null;
  readonly confidence: number;
  readonly via: 'ALIAS' | 'AI' | 'UNMAPPED';
}

export interface MappingProposal {
  readonly columns: readonly ColumnProposal[];
  readonly unmapped: readonly string[];
  /** True when every column resolved deterministically — no AI needed at all. */
  readonly complete: boolean;
}

/**
 * Step 2: the deterministic pass. No I/O, no AI, no network.
 *
 * Anything it cannot place is returned in `unmapped` for the AI adapter, or for a
 * human if the provider is unavailable.
 */
export function proposeMappingFromAliases(headers: readonly string[]): MappingProposal {
  const columns: ColumnProposal[] = [];
  const unmapped: string[] = [];
  const used = new Set<TargetField>();

  for (const header of headers) {
    const trimmed = String(header ?? '').trim();
    if (trimmed === '') continue;

    const target = ALIAS_MAP.get(canon(trimmed));

    // A duplicate target means two columns claim the same field — the file is
    // ambiguous, so neither is applied and a human decides.
    if (!target || used.has(target) || isDenied(trimmed, target)) {
      columns.push({ sourceHeader: trimmed, targetField: null, confidence: 0, via: 'UNMAPPED' });
      unmapped.push(trimmed);
      continue;
    }

    used.add(target);
    columns.push({
      sourceHeader: trimmed,
      targetField: target,
      confidence: ALIAS_CONFIDENCE,
      via: 'ALIAS',
    });
  }

  return { columns, unmapped, complete: unmapped.length === 0 };
}

/**
 * Merge an AI proposal into a deterministic one.
 *
 * The AI only ever gets a say about columns the dictionary could not place, and
 * the deny-list is re-applied to its output. A model that confidently maps
 * "Final amount" to `final_value` is exactly the failure this guards against, and
 * confidence is no defence against being confidently wrong.
 */
export function mergeAiProposal(
  deterministic: MappingProposal,
  ai: ReadonlyMap<string, { targetField: TargetField; confidence: number }>,
): MappingProposal {
  const used = new Set<TargetField>(
    deterministic.columns.filter((c) => c.targetField).map((c) => c.targetField as TargetField),
  );

  const columns = deterministic.columns.map((col): ColumnProposal => {
    if (col.targetField !== null) return col;

    const suggestion = ai.get(col.sourceHeader);
    if (!suggestion) return col;
    if (isDenied(col.sourceHeader, suggestion.targetField)) return col;
    if (used.has(suggestion.targetField)) return col;

    used.add(suggestion.targetField);
    return {
      sourceHeader: col.sourceHeader,
      targetField: suggestion.targetField,
      confidence: suggestion.confidence,
      via: 'AI',
    };
  });

  const unmapped = columns.filter((c) => c.targetField === null).map((c) => c.sourceHeader);
  return { columns, unmapped, complete: unmapped.length === 0 };
}

/**
 * May this proposal be applied without an admin confirming it?
 *
 * Only when every mapped column came from the deterministic dictionary. An AI
 * suggestion is ALWAYS confirmed by a human before the template is saved, however
 * confident it claims to be — docs/06: "never auto-apply a mapping below 0.9
 * confidence", and a saved template is permanent, so the bar here is higher still.
 */
export function canAutoApply(proposal: MappingProposal): boolean {
  return (
    proposal.complete &&
    proposal.columns.every((c) => c.via === 'ALIAS' && c.confidence >= MIN_AUTO_APPLY_CONFIDENCE)
  );
}

/** Columns an AI suggestion is too weak to even offer to the admin. */
export function belowConfidenceFloor(proposal: MappingProposal): readonly ColumnProposal[] {
  return proposal.columns.filter(
    (c) => c.via === 'AI' && c.confidence < MIN_AUTO_APPLY_CONFIDENCE,
  );
}
