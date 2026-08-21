import { describe, it, expect } from 'vitest';
import { OrderStatus } from '@razorveda/shared';
import {
  IllegalTransitionError, assertTransition, canTransition, dateFieldFor, everDispatched,
  isTerminal, ledgerEffectOf, nextStatuses,
} from '../src/orders/status-machine.js';

const ALL = Object.values(OrderStatus);

describe('the graph covers the enum', () => {
  it('has an entry for every order_status value', () => {
    // If someone adds a status to db/schema.sql, the enum-parity test catches the
    // TypeScript mirror — this catches the transition table, which is the other
    // place a new status would be silently unreachable.
    for (const s of ALL) {
      expect(nextStatuses(s), `no transitions defined for ${s}`).toBeDefined();
    }
  });

  it('only ever targets real statuses', () => {
    for (const s of ALL) {
      for (const t of nextStatuses(s)) expect(ALL).toContain(t);
    }
  });

  it('never allows a self-transition', () => {
    // A repeated courier webhook must be a no-op, not an event.
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });
});

describe('the happy path', () => {
  it('walks booking to delivery', () => {
    const path: OrderStatus[] = [
      'PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'IN_TRANSIT', 'OFD', 'DELIVERED',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(
        canTransition(path[i] as OrderStatus, path[i + 1] as OrderStatus),
        `${path[i]} -> ${path[i + 1]}`,
      ).toBe(true);
    }
  });

  it('refuses to skip fulfilment', () => {
    // A pending order cannot simply become delivered. If it did, an order could
    // realise credit without ever having been dispatched.
    expect(canTransition('PENDING', 'DELIVERED')).toBe(false);
    expect(canTransition('CONFIRMED', 'DELIVERED')).toBe(false);
  });
});

describe('terminal statuses', () => {
  it('treats RTO, RETURNED and CANCELLED as final', () => {
    for (const s of ['RTO', 'RETURNED', 'CANCELLED'] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(nextStatuses(s)).toEqual([]);
    }
  });

  it('explains that a final order is corrected by an adjustment, not a status change', () => {
    // order_status_event is append-only, so there is no edit path. The message has
    // to point at the one that exists.
    try {
      assertTransition('RTO', 'DELIVERED');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransitionError);
      expect((e as Error).message).toMatch(/already RTO, which is final/);
      expect((e as Error).message).toMatch(/adjustment entry/);
    }
  });

  it('lists what IS allowed when refusing a non-terminal transition', () => {
    try {
      assertTransition('PENDING', 'DISPATCHED');
      expect.unreachable('should have thrown');
    } catch (e) {
      // Says what happened and what to do next (docs/07 §5).
      expect((e as Error).message).toContain('CONFIRMED');
    }
  });
});

describe('NDR recovery paths stay open', () => {
  it('lets a failed delivery be reattempted', () => {
    // NDR is a failed attempt that may still be recovered — the whole reason the
    // NC_REFUSED and RTO_RECOVERY channels exist (docs/06).
    expect(canTransition('FAILED_DELIVERY', 'OFD')).toBe(true);
    expect(canTransition('NO_RESPONSE', 'OFD')).toBe(true);
    expect(canTransition('REFUSED', 'OFD')).toBe(true);
  });

  it('lets every NDR state fall through to RTO', () => {
    for (const s of ['FAILED_DELIVERY', 'NO_RESPONSE', 'REFUSED'] as const) {
      expect(canTransition(s, 'RTO')).toBe(true);
    }
  });
});

describe('ledger effects (D-13, CLAUDE.md rule 3)', () => {
  it('realises credit on delivery, and only there', () => {
    expect(ledgerEffectOf('OFD', 'DELIVERED')).toBe('REALISED_CREDIT');
    expect(ledgerEffectOf('PENDING', 'CONFIRMED')).toBe('NONE');
    expect(ledgerEffectOf('PROCESSING', 'DISPATCHED')).toBe('NONE');
  });

  it('claws back when a DELIVERED order comes back', () => {
    expect(ledgerEffectOf('DELIVERED', 'RETURNED')).toBe('CLAWBACK');
    expect(ledgerEffectOf('DELIVERED', 'RTO')).toBe('CLAWBACK');
  });

  it('does NOT claw back an order that never realised', () => {
    // The subtle one. An order that goes straight to RTO never wrote a
    // REALISED_CREDIT, so a clawback would double-count the loss and push the
    // rep's ledger negative for a sale they were never credited.
    expect(ledgerEffectOf('OFD', 'RTO')).toBe('NONE');
    expect(ledgerEffectOf('IN_TRANSIT', 'RTO')).toBe('NONE');
    expect(ledgerEffectOf('REFUSED', 'RTO')).toBe('NONE');
    expect(ledgerEffectOf('PROCESSING', 'CANCELLED')).toBe('NONE');
  });

  it('keeps realised credit reachable only through a legal path', () => {
    // Every transition that realises credit must also be legal, or the ledger
    // could be written by a route the guard rejects.
    for (const from of ALL) {
      if (ledgerEffectOf(from, 'DELIVERED') === 'REALISED_CREDIT') {
        expect(canTransition(from, 'DELIVERED'), `${from} -> DELIVERED realises but is illegal`)
          .toBe(true);
      }
    }
  });
});

describe('date stamping and RTO denominators', () => {
  it('stamps the right column', () => {
    expect(dateFieldFor('DISPATCHED')).toBe('dispatch_date');
    expect(dateFieldFor('DELIVERED')).toBe('delivered_date');
    expect(dateFieldFor('RTO')).toBe('rto_date');
    expect(dateFieldFor('CONFIRMED')).toBeNull();
  });

  it('counts an order as dispatched once it has shipped', () => {
    // RTO% is measured over orders DISPATCHED in the period (docs/03 §3), so an
    // order that never shipped belongs in neither numerator nor denominator.
    expect(everDispatched(['PENDING', 'CONFIRMED', 'PROCESSING'])).toBe(false);
    expect(everDispatched(['PENDING', 'CONFIRMED', 'CANCELLED'])).toBe(false);
    expect(everDispatched(['PENDING', 'DISPATCHED', 'RTO'])).toBe(true);
    expect(everDispatched(['OFD', 'DELIVERED'])).toBe(true);
  });
});

describe('an illegal transition has no ledger consequence', () => {
  it('does not realise credit on a transition the guard would reject', () => {
    // Found by the "reachable only through a legal path" test above: the first
    // version keyed purely on the destination, so an illegal PENDING -> DELIVERED
    // still returned REALISED_CREDIT. A caller that computed the effect before
    // asserting the transition would have written money against an order that was
    // never dispatched — into an append-only ledger, so uncorrectable by edit.
    expect(ledgerEffectOf('PENDING', 'DELIVERED')).toBe('NONE');
    expect(ledgerEffectOf('CONFIRMED', 'DELIVERED')).toBe('NONE');
    expect(ledgerEffectOf('RTO', 'DELIVERED')).toBe('NONE');
  });

  it('does not claw back from a terminal state', () => {
    expect(ledgerEffectOf('RETURNED', 'RTO')).toBe('NONE');
  });
});
