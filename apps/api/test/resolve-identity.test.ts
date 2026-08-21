import { describe, it, expect } from 'vitest';
import {
  AUTO_MERGE_CONFIDENCE,
  FUZZY_NAME_SIMILARITY,
  REVIEW_CONFIDENCE,
  resolveIdentity,
  type Candidate,
  type ResolutionInput,
} from '../src/customers/resolve-identity.js';

/**
 * docs/06 §4. This is the logic that has to take the duplicate rate from a
 * measured 39.3% (F1) to under 1%, so the edges matter more than the happy path.
 */

const keyable: ResolutionInput = {
  normalisedPhone: '9876543210',
  name: 'Priyanshi Sharma',
  pincode: '201013',
};

const unkeyable: ResolutionInput = { normalisedPhone: null, name: 'No Phone', pincode: '201013' };

const CUST = 'c1111111-1111-1111-1111-111111111111';
const OTHER = 'c2222222-2222-2222-2222-222222222222';

describe('thresholds match docs/06 §4', () => {
  it('auto-merge 0.95, review 0.80, fuzzy name 0.85', () => {
    expect(AUTO_MERGE_CONFIDENCE).toBe(0.95);
    expect(REVIEW_CONFIDENCE).toBe(0.8);
    expect(FUZZY_NAME_SIMILARITY).toBe(0.85);
  });
});

describe('phone matches', () => {
  it('updates the existing customer on an exact primary_phone hit', () => {
    const c: Candidate = { customerId: CUST, matchedOn: 'PRIMARY_PHONE' };
    expect(resolveIdentity(keyable, [c])).toEqual({
      action: 'UPDATE_EXISTING',
      customerId: CUST,
      confidence: 1,
      matchedOn: 'PRIMARY_PHONE',
    });
  });

  it('updates on an alt-number hit in customer_identifier', () => {
    // Alt numbers are already in use in the client's data, which is one of the
    // reasons phone is a business key and not the primary key (D-01).
    const c: Candidate = { customerId: CUST, matchedOn: 'IDENTIFIER' };
    expect(resolveIdentity(keyable, [c])).toMatchObject({
      action: 'UPDATE_EXISTING',
      matchedOn: 'IDENTIFIER',
    });
  });

  it('prefers a primary-phone match over an identifier match', () => {
    const found = resolveIdentity(keyable, [
      { customerId: OTHER, matchedOn: 'IDENTIFIER' },
      { customerId: CUST, matchedOn: 'PRIMARY_PHONE' },
    ]);
    expect(found).toMatchObject({ customerId: CUST, matchedOn: 'PRIMARY_PHONE' });
  });

  it('prefers any phone match over a perfect fuzzy score', () => {
    // D-15: one customer per mobile number. A name that disagrees with a phone
    // match is not evidence against the match — the recipient name belongs on the
    // order, not on a second customer record.
    const found = resolveIdentity(keyable, [
      { customerId: OTHER, matchedOn: 'FUZZY', nameSimilarity: 1, pincodeMatches: true },
      { customerId: CUST, matchedOn: 'IDENTIFIER' },
    ]);
    expect(found).toMatchObject({ customerId: CUST, matchedOn: 'IDENTIFIER' });
  });
});

describe('fuzzy matches need BOTH signals', () => {
  it('queues a strong name + matching pincode for review', () => {
    const c: Candidate = {
      customerId: CUST,
      matchedOn: 'FUZZY',
      nameSimilarity: 0.88,
      pincodeMatches: true,
    };
    expect(resolveIdentity(keyable, [c])).toEqual({
      action: 'MERGE_CANDIDATE',
      customerId: CUST,
      confidence: 0.88,
      matchedOn: 'FUZZY',
    });
  });

  it('creates new when the name is strong but the pincode differs', () => {
    // "Aarti" in Meerut and "Aarti" in Mysuru are different people, and the
    // client's data is full of single-word names.
    const c: Candidate = {
      customerId: CUST,
      matchedOn: 'FUZZY',
      nameSimilarity: 0.99,
      pincodeMatches: false,
    };
    expect(resolveIdentity(keyable, [c])).toEqual({ action: 'CREATE_NEW', confidence: 1 });
  });

  it('creates new when the pincode matches but the name is weak', () => {
    const c: Candidate = {
      customerId: CUST,
      matchedOn: 'FUZZY',
      nameSimilarity: 0.6,
      pincodeMatches: true,
    };
    expect(resolveIdentity(keyable, [c])).toMatchObject({ action: 'CREATE_NEW' });
  });

  it('auto-merges only above 0.95', () => {
    const at = (s: number): Candidate => ({
      customerId: CUST,
      matchedOn: 'FUZZY',
      nameSimilarity: s,
      pincodeMatches: true,
    });
    expect(resolveIdentity(keyable, [at(0.96)])).toMatchObject({ action: 'UPDATE_EXISTING' });
    expect(resolveIdentity(keyable, [at(0.95)])).toMatchObject({ action: 'UPDATE_EXISTING' });
    expect(resolveIdentity(keyable, [at(0.94)])).toMatchObject({ action: 'MERGE_CANDIDATE' });
  });

  it('holds the review band open at exactly 0.85 and 0.80', () => {
    // 0.85 is the fuzzy floor; anything between it and 0.95 is a human decision,
    // never an automatic merge. Silently merging two real customers is far more
    // expensive to undo than reviewing 26 rows on a 500-row day.
    const at = (s: number): Candidate => ({
      customerId: CUST,
      matchedOn: 'FUZZY',
      nameSimilarity: s,
      pincodeMatches: true,
    });
    expect(resolveIdentity(keyable, [at(0.85)])).toMatchObject({ action: 'MERGE_CANDIDATE' });
    expect(resolveIdentity(keyable, [at(0.84)])).toMatchObject({ action: 'CREATE_NEW' });
  });

  it('picks the strongest fuzzy candidate when several qualify', () => {
    const found = resolveIdentity(keyable, [
      { customerId: OTHER, matchedOn: 'FUZZY', nameSimilarity: 0.86, pincodeMatches: true },
      { customerId: CUST, matchedOn: 'FUZZY', nameSimilarity: 0.93, pincodeMatches: true },
    ]);
    expect(found).toMatchObject({ customerId: CUST, confidence: 0.93 });
  });
});

describe('un-keyable rows are parked, never discarded (F2)', () => {
  it('parks a row with no valid phone and no confident match', () => {
    const r = resolveIdentity(unkeyable, []);
    expect(r).toMatchObject({ action: 'PARK' });
    if (r.action === 'PARK') {
      // Says what to do next (docs/07 §5), because a parked row is an admin task.
      expect(r.reason).toContain('Parked for review');
      expect(r.reason).toMatch(/add a number|merge/i);
    }
  });

  it('still resolves a phone-less row when name and pincode match strongly', () => {
    // 236 of 2,159 client rows have no usable number. Parking all of them
    // unconditionally would strand customers we can actually identify.
    const c: Candidate = {
      customerId: CUST,
      matchedOn: 'FUZZY',
      nameSimilarity: 0.97,
      pincodeMatches: true,
    };
    expect(resolveIdentity(unkeyable, [c])).toMatchObject({ action: 'UPDATE_EXISTING' });
  });

  it('creates a new customer for a keyable row with no candidates', () => {
    expect(resolveIdentity(keyable, [])).toEqual({ action: 'CREATE_NEW', confidence: 1 });
  });

  it('never returns CREATE_NEW for an un-keyable row', () => {
    // The failure mode this prevents: a row with no number creating a fresh
    // unreachable customer on every single upload, which is one of the ways the
    // client's sheets reached a 1.71 redundancy factor.
    for (const weak of [0.5, 0.7, 0.84]) {
      const r = resolveIdentity(unkeyable, [
        { customerId: CUST, matchedOn: 'FUZZY', nameSimilarity: weak, pincodeMatches: true },
      ]);
      expect(r.action).toBe('PARK');
    }
  });
});
