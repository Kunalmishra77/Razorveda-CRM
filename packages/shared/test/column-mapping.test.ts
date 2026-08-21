import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MIN_AUTO_APPLY_CONFIDENCE,
  belowConfidenceFloor,
  canAutoApply,
  isDenied,
  mergeAiProposal,
  proposeMappingFromAliases,
  type TargetField,
} from '../src/ingestion/column-mapping.js';

const headerRow = (name: string): string[] =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8')
    .split(/\r?\n/)[0]!
    .split(',');

const mapOf = (headers: readonly string[]): Record<string, string | null> =>
  Object.fromEntries(
    proposeMappingFromAliases(headers).columns.map((c) => [c.sourceHeader, c.targetField]),
  );

describe('the deterministic pass handles the client real headers — no AI', () => {
  it.each([
    'shopify_orders_sample.csv',
    'meta_ads_sample.csv',
    'wa_campaign_sample.csv',
    'delivered_data_sample.csv',
    'rto_sample.csv',
    'nc_refused_sample.csv',
    'edge_cases.csv',
  ])('maps every column of %s', (file) => {
    // F6's variants are a list, not a language problem. If this ever needs a model
    // to read `ProductDeatil`, something has gone wrong.
    const proposal = proposeMappingFromAliases(headerRow(file));
    expect(proposal.unmapped, `unmapped in ${file}: ${proposal.unmapped.join(', ')}`).toEqual([]);
    expect(proposal.complete).toBe(true);
  });

  it('resolves the F6 phone variants to one field', () => {
    for (const h of ['Number', 'Phone no', 'Phoneno', 'phone_number', 'PHONE NO']) {
      expect(mapOf([h])[h.trim()], h).toBe('primary_phone');
    }
  });

  it('resolves the F6 name variants to one field', () => {
    for (const h of ['Name', 'Customer name', 'CustomerName', 'full_name']) {
      expect(mapOf([h])[h.trim()], h).toBe('full_name');
    }
  });

  it('resolves the F6 misspelling ProductDeatil', () => {
    expect(mapOf(['ProductDeatil'])['ProductDeatil']).toBe('product_text');
  });

  it('resolves the F6 caller variants', () => {
    for (const h of ['Agent', 'Caller name', 'CallerName', 'Agent Name']) {
      expect(mapOf([h])[h.trim()], h).toBe('caller_name');
    }
  });

  it('auto-applies a fully deterministic mapping', () => {
    expect(canAutoApply(proposeMappingFromAliases(headerRow('rto_sample.csv')))).toBe(true);
  });
});

describe('the B8 deny-list — "Final amount" is NOT the order total', () => {
  it('maps Total amount to final_value', () => {
    expect(mapOf(['Total amount'])['Total amount']).toBe('final_value');
  });

  it('maps Final amount to legacy_credit_value, never final_value', () => {
    // The sheet's "Final amount" is the manually typed employee credit. The words
    // are inverted, and a mapper matching on "final" corrupts every historical
    // order while quietly changing what every rep is paid.
    expect(mapOf(['Final amount'])['Final amount']).toBe('legacy_credit_value');
  });

  it('maps both correctly when they appear together, as in the Shopify fixture', () => {
    const m = mapOf(headerRow('shopify_orders_sample.csv'));
    expect(m['Total amount']).toBe('final_value');
    expect(m['Final amount']).toBe('legacy_credit_value');
  });

  it('blocks the pairing outright', () => {
    expect(isDenied('Final amount', 'final_value')).toBe(true);
    expect(isDenied('final value', 'final_value')).toBe(true);
    expect(isDenied('Total amount', 'final_value')).toBe(false);
  });

  it('REFUSES an AI suggestion that maps Final amount to final_value', () => {
    // A hard block, not a ranking preference. Confidence is no defence against
    // being confidently wrong about which column is the money.
    const deterministic = proposeMappingFromAliases(['Order id', 'Mystery amount']);
    const merged = mergeAiProposal(
      deterministic,
      new Map([['Mystery amount', { targetField: 'final_value' as TargetField, confidence: 0.99 }]]),
    );
    // This one is allowed — it is not on the deny-list.
    expect(merged.columns.find((c) => c.sourceHeader === 'Mystery amount')?.targetField)
      .toBe('final_value');

    const denied = mergeAiProposal(
      proposeMappingFromAliases(['Order id', 'Final amount']),
      new Map([['Final amount', { targetField: 'final_value' as TargetField, confidence: 0.99 }]]),
    );
    // "Final amount" already resolved to legacy_credit_value deterministically and
    // could never be overridden to final_value regardless.
    expect(denied.columns.find((c) => c.sourceHeader === 'Final amount')?.targetField)
      .toBe('legacy_credit_value');
  });
});

describe('ambiguity is refused, not guessed', () => {
  it('leaves both columns unmapped when two claim the same field', () => {
    // "Phone no" and "Number" in one file means somebody merged two exports.
    // Picking one silently would drop half the numbers.
    const p = proposeMappingFromAliases(['Phone no', 'Number']);
    expect(p.columns[0]?.targetField).toBe('primary_phone');
    expect(p.columns[1]?.targetField).toBeNull();
    expect(p.unmapped).toEqual(['Number']);
    expect(p.complete).toBe(false);
  });

  it('does not auto-apply an incomplete mapping', () => {
    expect(canAutoApply(proposeMappingFromAliases(['Phone no', 'Some New Column']))).toBe(false);
  });

  it('ignores empty header cells, which Excel adds freely', () => {
    const p = proposeMappingFromAliases(['Number', '', '   ']);
    expect(p.complete).toBe(true);
    expect(p.columns).toHaveLength(1);
  });
});

describe('the AI path is last, and never self-applies', () => {
  const unseen = proposeMappingFromAliases(['Number', 'Lead Temperature Score']);

  it('only offers the AI columns the dictionary could not place', () => {
    expect(unseen.unmapped).toEqual(['Lead Temperature Score']);
  });

  it('accepts a confident suggestion for an unseen column', () => {
    const merged = mergeAiProposal(
      unseen,
      new Map([['Lead Temperature Score', { targetField: 'remark' as TargetField, confidence: 0.95 }]]),
    );
    expect(merged.complete).toBe(true);
    expect(merged.columns.find((c) => c.via === 'AI')?.targetField).toBe('remark');
  });

  it('STILL requires a human, however confident the model claims to be', () => {
    // docs/06 sets a 0.9 floor for auto-applying, but a saved template is
    // permanent and gets reused every day thereafter — so an AI column is always
    // confirmed by an admin before the template is written.
    const merged = mergeAiProposal(
      unseen,
      new Map([['Lead Temperature Score', { targetField: 'remark' as TargetField, confidence: 1 }]]),
    );
    expect(canAutoApply(merged)).toBe(false);
  });

  it('flags suggestions below the 0.9 floor as not even worth offering', () => {
    const merged = mergeAiProposal(
      unseen,
      new Map([['Lead Temperature Score', { targetField: 'remark' as TargetField, confidence: 0.4 }]]),
    );
    expect(belowConfidenceFloor(merged)).toHaveLength(1);
    expect(MIN_AUTO_APPLY_CONFIDENCE).toBe(0.9);
  });

  it('will not let AI steal a field the dictionary already assigned', () => {
    const merged = mergeAiProposal(
      proposeMappingFromAliases(['Number', 'Some Other Phone']),
      new Map([['Some Other Phone', { targetField: 'primary_phone' as TargetField, confidence: 0.99 }]]),
    );
    expect(merged.columns.find((c) => c.sourceHeader === 'Some Other Phone')?.targetField).toBeNull();
  });

  it('completes without AI at all when the provider is unavailable', () => {
    // ADR-004: if the provider is down, ingestion still completes and unseen
    // headers go to manual mapping. Passing an empty map is that outage.
    const merged = mergeAiProposal(unseen, new Map());
    expect(merged.unmapped).toEqual(['Lead Temperature Score']);
    expect(merged.columns.find((c) => c.sourceHeader === 'Number')?.targetField)
      .toBe('primary_phone');
  });
});
