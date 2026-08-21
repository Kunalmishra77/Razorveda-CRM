import type { OrderStatus } from '@razorveda/shared';

/**
 * Order status transitions (tasks/phase-1 item 3: "order_status_event append-only,
 * with a state machine guarding legal transitions").
 *
 * `order_status_event` is INSERT-only, so a wrong status is corrected by a new
 * row, never an UPDATE. That is what makes a March report reproducible in
 * December — and it is also why the guard matters: a nonsense transition cannot
 * be quietly edited away afterwards.
 *
 * The transition table is a Tier 2 decision. docs/ specifies the statuses and the
 * clawback rule but not the graph, so this encodes the courier lifecycle a
 * pan-India COD business actually has, with NDR recovery paths kept open.
 */

const TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['IN_TRANSIT', 'OFD', 'RTO', 'FAILED_DELIVERY'],
  IN_TRANSIT: ['OFD', 'RTO', 'FAILED_DELIVERY'],
  OFD: ['DELIVERED', 'FAILED_DELIVERY', 'NO_RESPONSE', 'REFUSED', 'RTO'],
  // NDR states are NOT terminal. A failed attempt may still be recovered, and the
  // RTO_RECOVERY and NC_REFUSED channels exist precisely to work them (docs/06).
  FAILED_DELIVERY: ['OFD', 'NO_RESPONSE', 'REFUSED', 'RTO'],
  NO_RESPONSE: ['OFD', 'RTO'],
  REFUSED: ['OFD', 'RTO'],
  // A delivered parcel can still come back. Both paths write a clawback.
  DELIVERED: ['RETURNED', 'RTO'],
  RTO: [],
  RETURNED: [],
  CANCELLED: [],
} as const;

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['RTO', 'RETURNED', 'CANCELLED'];

export const isTerminal = (s: OrderStatus): boolean => TERMINAL_STATUSES.includes(s);

export const nextStatuses = (from: OrderStatus): readonly OrderStatus[] => TRANSITIONS[from];

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  TRANSITIONS[from].includes(to);

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(
      isTerminal(from)
        ? `Order is already ${from}, which is final. Correct it with an adjustment entry, not a status change.`
        : `Cannot move an order from ${from} to ${to}. Allowed from ${from}: ${
            TRANSITIONS[from].join(', ') || 'nothing'
          }.`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * What a transition means for the attribution ledger (docs/03 §4, D-13).
 *
 *   REALISED_CREDIT  on delivery — the only basis for score and incentive
 *   CLAWBACK         when a delivered order later comes back
 *
 * Nothing is written on booking beyond the provisional BOOKED_CREDIT that already
 * exists, because credit is earned on delivery, not on booking (CLAUDE.md rule 3).
 */
export type LedgerEffect = 'REALISED_CREDIT' | 'CLAWBACK' | 'NONE';

export function ledgerEffectOf(from: OrderStatus, to: OrderStatus): LedgerEffect {
  // An impossible transition has no ledger consequence. Without this an illegal
  // PENDING -> DELIVERED would still hand back REALISED_CREDIT, so any caller that
  // computed the effect before asserting the transition would write money against
  // an order that was never dispatched. Belt and braces: the guard and the ledger
  // must agree about what happened, and the ledger is append-only.
  if (!canTransition(from, to)) return 'NONE';

  if (to === 'DELIVERED') return 'REALISED_CREDIT';
  // Only a transition OUT of DELIVERED claws anything back. An order that goes
  // straight to RTO never realised, so there is nothing to reverse — writing a
  // clawback there would double-count the loss and push the ledger negative.
  if (from === 'DELIVERED' && (to === 'RTO' || to === 'RETURNED')) return 'CLAWBACK';
  return 'NONE';
}

/** Which date column a transition stamps. */
export function dateFieldFor(to: OrderStatus): 'dispatch_date' | 'delivered_date' | 'rto_date' | null {
  switch (to) {
    case 'DISPATCHED':
      return 'dispatch_date';
    case 'DELIVERED':
      return 'delivered_date';
    case 'RTO':
      return 'rto_date';
    default:
      return null;
  }
}

/**
 * RTO% is measured over orders DISPATCHED in the period (docs/03 §3), so an order
 * that never shipped belongs in neither the numerator nor the denominator.
 */
export const everDispatched = (history: readonly OrderStatus[]): boolean =>
  history.some((s) => s === 'DISPATCHED' || s === 'IN_TRANSIT' || s === 'OFD' || s === 'DELIVERED');
