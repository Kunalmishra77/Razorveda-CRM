import { describe, it, expect } from 'vitest';
import { ledgerEffectOf, nextStatuses, canTransition } from '../src/orders/status-machine.js';
import { addMoney, money } from '@razorveda/shared';
import type { OrderStatus } from '@razorveda/shared';

/**
 * PHASE 3 EXIT CRITERIA 2 AND 3, at order grain.
 *
 * Criterion 2 is stated carefully in the task file, and the care matters: realised
 * credit is `<=` booked credit PER ORDER, never per period. Per period it is
 * simply false — an order booked in March and delivered in April realises in a
 * month that booked nothing, so April's realised legitimately exceeds April's
 * booked. Calling that impossible was defect F10, and D-13 corrected it. A test
 * asserting the period version would "fail" on correct behaviour and push someone
 * to break the ledger to satisfy it.
 *
 * These are property tests over generated histories rather than a handful of
 * examples, because the interesting cases are the paths nobody thinks to write
 * down: OFD -> FAILED_DELIVERY -> OFD -> DELIVERED -> RTO, and the NDR loops that
 * can visit a state several times.
 */

/** The signed credit a transition writes, given the order's booked credit. */
function creditFor(from: OrderStatus, to: OrderStatus, booked: string): string {
  const effect = ledgerEffectOf(from, to);
  if (effect === 'REALISED_CREDIT') return booked;
  if (effect === 'CLAWBACK') return `-${booked}`;
  return '0.00';
}

/**
 * Every legal path through the status graph, up to a bounded length.
 *
 * Bounded because the NDR states form cycles — OFD -> FAILED_DELIVERY -> OFD is
 * legal and real, a courier reattempting a delivery — so the graph has infinitely
 * many walks. Depth 8 covers every shape that matters: a delivery, a return after
 * a delivery, and several failed attempts before either.
 */
function allPaths(from: OrderStatus, depth: number): OrderStatus[][] {
  if (depth === 0) return [[from]];
  const paths: OrderStatus[][] = [[from]];
  for (const next of nextStatuses(from)) {
    for (const tail of allPaths(next, depth - 1)) paths.push([from, ...tail]);
  }
  return paths;
}

const PATHS = allPaths('PENDING', 8);

/** Replay a path and total what the ledger would hold for that order. */
function replay(path: readonly OrderStatus[], booked: string) {
  let realised = money('0.00');
  let clawed = money('0.00');
  let net = money('0.00');

  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const effect = ledgerEffectOf(from, to);
    const amount = creditFor(from, to, booked);
    net = addMoney(net, amount);
    if (effect === 'REALISED_CREDIT') realised = addMoney(realised, amount);
    if (effect === 'CLAWBACK') clawed = addMoney(clawed, amount);
  }
  return { realised, clawed, net };
}

describe('the generated paths are worth testing', () => {
  it('covers a lot of distinct histories, and every one is legal', () => {
    // Guard the guard: if the graph or the generator broke, the properties below
    // would pass over an empty or trivial set and prove nothing.
    expect(PATHS.length).toBeGreaterThan(200);
    for (const path of PATHS) {
      for (let i = 0; i < path.length - 1; i += 1) {
        expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
      }
    }
  });

  it('includes the paths that actually pay and claw back', () => {
    const delivered = PATHS.filter((p) => p.includes('DELIVERED'));
    const returned = PATHS.filter(
      (p) => p.includes('DELIVERED') && (p.includes('RTO') || p.includes('RETURNED')),
    );
    expect(delivered.length).toBeGreaterThan(0);
    expect(returned.length).toBeGreaterThan(0);
  });
});

describe('criterion 2 — realised credit never exceeds booked credit, per order', () => {
  const BOOKED = '1500.00';

  it('holds over every generated order history', () => {
    for (const path of PATHS) {
      const { realised } = replay(path, BOOKED);
      // Realised is the sum of REALISED_CREDIT entries. An order can only be
      // delivered once per visit to DELIVERED, and the graph allows returning to
      // it only via a fresh dispatch cycle, so this bounds the total.
      expect(
        Number(realised) <= Number(BOOKED),
        `path ${path.join(' -> ')} realised ${realised} against booked ${BOOKED}`,
      ).toBe(true);
    }
  });

  it('an order that never reaches DELIVERED realises nothing at all', () => {
    for (const path of PATHS.filter((p) => !p.includes('DELIVERED'))) {
      expect(replay(path, BOOKED).realised).toBe('0.00');
    }
  });

  it('a straight-to-RTO order writes no clawback — there is nothing to reverse', () => {
    // Writing one here would double-count the loss and push the ledger negative:
    // the company never paid the credit, so reversing it invents a debt.
    const path: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'RTO'];
    const { realised, clawed, net } = replay(path, BOOKED);
    expect({ realised, clawed, net }).toEqual({
      realised: '0.00',
      clawed: '0.00',
      net: '0.00',
    });
  });
});

describe('criterion 3 — deliver then RTO, and the ledger nets to zero', () => {
  const BOOKED = '1500.00';

  it('nets to exactly zero for that order, by both routes back', () => {
    for (const back of ['RTO', 'RETURNED'] as const) {
      const path: OrderStatus[] = [
        'PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'OFD', 'DELIVERED', back,
      ];
      const { realised, clawed, net } = replay(path, BOOKED);
      expect(realised).toBe('1500.00');
      expect(clawed).toBe('-1500.00');
      // Exactly zero, not approximately: the clawback is the negation of the
      // credit, not a recomputation of it, so no rounding can creep in.
      expect(net).toBe('0.00');
    }
  });

  it('nets to zero for awkward values a percentage split would round', () => {
    for (const booked of ['1000.01', '333.33', '0.01', '99999.99']) {
      const path: OrderStatus[] = [
        'PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'OFD', 'DELIVERED', 'RTO',
      ];
      expect(replay(path, booked).net, `booked ${booked}`).toBe('0.00');
    }
  });

  it('holds for EVERY generated history, not just the obvious one', () => {
    // The general invariant: an order that has come back from delivery is square,
    // and one that has not is either owed its credit or owed nothing.
    for (const path of PATHS) {
      const { net } = replay(path, BOOKED);
      const cameBack =
        path.includes('DELIVERED') &&
        path.indexOf('DELIVERED') < Math.max(path.lastIndexOf('RTO'), path.lastIndexOf('RETURNED'));

      if (cameBack) expect(net, `path ${path.join(' -> ')}`).toBe('0.00');
      else expect(Number(net) >= 0, `path ${path.join(' -> ')} went negative`).toBe(true);
    }
  });
});

describe('what "nets to zero" means, so nobody sums the wrong rows', () => {
  /**
   * Three entry types live in this table and only two of them are money that was
   * ever owed. BOOKED_CREDIT is provisional — rule 3: never pay or score on booked
   * value — and Booked Value is status-independent by definition (docs/03 §2), so
   * an RTO must NOT erase it. The booking really happened.
   *
   * Summing every row for an RTO'd order therefore gives the booked figure, not
   * zero, and that number is correct for what it measures and catastrophic as an
   * incentive base: it would pay a rep in full for a parcel that came back. This
   * fixes the reading before an incentive query is written against it.
   */
  const ENTRIES = [
    { type: 'BOOKED_CREDIT', value: '2500.00', isRealised: false },
    { type: 'REALISED_CREDIT', value: '2500.00', isRealised: true },
    { type: 'CLAWBACK', value: '-2500.00', isRealised: true },
  ] as const;

  const net = (rows: readonly { value: string }[]): string =>
    rows.reduce((sum, r) => addMoney(sum, r.value), money('0.00'));

  it('the realised entries net to zero — the rep is owed nothing', () => {
    expect(net(ENTRIES.filter((e) => e.isRealised))).toBe('0.00');
  });

  it('the booking survives the return, because it is not a payment', () => {
    expect(net(ENTRIES.filter((e) => !e.isRealised))).toBe('2500.00');
  });

  it('summing EVERY row would pay in full for a returned parcel', () => {
    // Asserted deliberately, as the shape of the mistake rather than as desired
    // behaviour: an incentive query that forgets `WHERE is_realised` pays 2500
    // on an order that was refunded.
    expect(net(ENTRIES)).toBe('2500.00');
    expect(net(ENTRIES)).not.toBe('0.00');
  });
});
