/**
 * Pre-assign warnings and the Suggested Split (docs/07 §3, tasks/phase-1 item 5).
 *
 * D-02: there is no auto-assignment. Everything here is ADVISORY. Nothing in this
 * file may move a lead, and the Suggested Split returns a proposal the admin
 * applies with a button — it never assigns on its own.
 *
 * Warnings never block. An admin who knows something the system does not must be
 * able to proceed; the override is logged on the append-only `lead_assignment`
 * row, which is a better control than a modal nobody reads.
 */

export type WarningCode =
  | 'REP_OVERLOADED'
  | 'REP_ON_LEAVE'
  | 'REP_NOT_ACTIVE'
  | 'EXISTING_CUSTOMER_OWNERSHIP'
  | 'AGEING_LEADS_IN_POOL'
  | 'LEADS_PAST_VALIDITY';

export interface Warning {
  readonly code: WarningCode;
  readonly message: string;
  /** How many leads or units the warning is about, for sorting by weight. */
  readonly count: number;
}

export interface RepSnapshot {
  readonly employeeId: string;
  readonly fullName: string;
  readonly status: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'EXITED';
  readonly wipCap: number;
  /** Open, unconverted leads currently held. */
  readonly openLeads: number;
  /** Delivered value per assigned lead, last month. Drives the Suggested Split. */
  readonly yieldPerLead: number;
}

export interface PoolLead {
  readonly leadId: string;
  readonly customerId: string;
  /** Hours since the lead arrived in the pool. */
  readonly ageHours: number;
  /** True when the lead is past `valid_till`. */
  readonly pastValidity: boolean;
  /** Set when another rep already owns this customer. */
  readonly ownedByEmployeeId: string | null;
}

/** docs/07 §3 shows "61 leads in the pool are older than 24 hours". */
export const AGEING_THRESHOLD_HOURS = 24;

/**
 * Warnings for assigning `selected` to `rep`.
 *
 * Ordered most-actionable first: things about the destination rep, then things
 * about the leads. An admin reads the first line and little else.
 */
export function preAssignWarnings(
  rep: RepSnapshot,
  selected: readonly PoolLead[],
  pool: readonly PoolLead[],
): readonly Warning[] {
  const warnings: Warning[] = [];

  if (rep.status === 'ON_LEAVE') {
    warnings.push({
      code: 'REP_ON_LEAVE',
      count: selected.length,
      message: `${rep.fullName} is on leave. These ${selected.length} leads will sit untouched until she returns.`,
    });
  } else if (rep.status !== 'ACTIVE') {
    warnings.push({
      code: 'REP_NOT_ACTIVE',
      count: selected.length,
      message: `${rep.fullName} is ${rep.status.toLowerCase().replace('_', ' ')} and cannot work leads.`,
    });
  }

  const after = rep.openLeads + selected.length;
  if (after > rep.wipCap) {
    warnings.push({
      code: 'REP_OVERLOADED',
      count: after - rep.wipCap,
      message: `${rep.fullName} already has ${rep.openLeads} open leads. This takes her to ${after}, over her cap of ${rep.wipCap}.`,
    });
  }

  // The client's data has one customer in eight different tabs (F1). Splitting a
  // customer across reps is how that happened, and it is also how two reps end up
  // calling the same person on the same day.
  const owned = selected.filter(
    (l) => l.ownedByEmployeeId !== null && l.ownedByEmployeeId !== rep.employeeId,
  );
  if (owned.length > 0) {
    warnings.push({
      code: 'EXISTING_CUSTOMER_OWNERSHIP',
      count: owned.length,
      message: `${owned.length} of these belong to customers another rep already owns. Assigning them here splits the relationship.`,
    });
  }

  const expired = selected.filter((l) => l.pastValidity);
  if (expired.length > 0) {
    warnings.push({
      code: 'LEADS_PAST_VALIDITY',
      count: expired.length,
      message: `${expired.length} of these are past their validity date. They are unlikely to convert.`,
    });
  }

  // About the pool, not the selection: assign the oldest first.
  const ageing = pool.filter((l) => l.ageHours > AGEING_THRESHOLD_HOURS);
  if (ageing.length > 0) {
    warnings.push({
      code: 'AGEING_LEADS_IN_POOL',
      count: ageing.length,
      message: `${ageing.length} leads in the pool are older than ${AGEING_THRESHOLD_HOURS} hours. Assign these first.`,
    });
  }

  return warnings;
}

export interface SplitProposal {
  readonly employeeId: string;
  readonly fullName: string;
  readonly leadCount: number;
  readonly reason: string;
}

/**
 * Suggested Split — ADVISORY ONLY (docs/07 §3, D-02).
 *
 * Proposes a distribution from current open workload and last month's yield. The
 * admin applies it with one button, edits it, or ignores it. It never assigns.
 *
 * Deliberately simple and explainable: headroom against the WIP cap, weighted by
 * yield. An admin who cannot predict what the button will do will not press it,
 * and the whole point of D-02 is that the human keeps the decision.
 */
export function suggestSplit(
  reps: readonly RepSnapshot[],
  leadCount: number,
): readonly SplitProposal[] {
  const eligible = reps.filter((r) => r.status === 'ACTIVE' && r.openLeads < r.wipCap);
  if (eligible.length === 0 || leadCount <= 0) return [];

  // A rep with no track record — a new joiner, or anyone with no delivered orders
  // last month — is treated as a quarter of the team median until they have one.
  //
  // An absolute floor does not work here: against a team yielding ₹800/lead, a
  // floor of 0.1 is numerically indistinguishable from zero, so a new joiner is
  // proposed nothing, never builds a record, and stays at nothing. A floor
  // RELATIVE to the team is the only version that self-corrects. (Tier 2)
  const positiveYields = eligible.map((r) => r.yieldPerLead).filter((y) => y > 0).sort((a, b) => a - b);
  const median = positiveYields.length
    ? (positiveYields[Math.floor((positiveYields.length - 1) / 2)] as number)
    : 1;
  const NEW_JOINER_SHARE = 0.25;
  const yieldFloor = median * NEW_JOINER_SHARE;

  // Headroom caps the proposal; yield decides who gets more of what is left.
  const weights = eligible.map((r) => {
    const headroom = r.wipCap - r.openLeads;
    const weight = headroom * Math.max(r.yieldPerLead, yieldFloor);
    return { rep: r, headroom, weight };
  });

  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);

  // Largest-remainder again, so the proposal sums to exactly leadCount and the
  // admin is never told to assign 59 of 60.
  const raw = weights.map((w) => ({ ...w, exact: (leadCount * w.weight) / totalWeight }));
  const proposals = raw.map((w) => ({ ...w, floor: Math.min(Math.floor(w.exact), w.headroom) }));

  let remaining = leadCount - proposals.reduce((s, p) => s + p.floor, 0);
  const byRemainder = [...proposals].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)),
  );

  const counts = new Map(proposals.map((p) => [p.rep.employeeId, p.floor]));
  for (const p of byRemainder) {
    if (remaining <= 0) break;
    const current = counts.get(p.rep.employeeId) ?? 0;
    if (current < p.headroom) {
      counts.set(p.rep.employeeId, current + 1);
      remaining--;
    }
  }
  // Second pass: headroom may have blocked the first round.
  while (remaining > 0) {
    const next = byRemainder.find((p) => (counts.get(p.rep.employeeId) ?? 0) < p.headroom);
    if (!next) break; // every rep is at cap; the admin will see the shortfall
    counts.set(next.rep.employeeId, (counts.get(next.rep.employeeId) ?? 0) + 1);
    remaining--;
  }

  return proposals
    .map((p) => ({
      employeeId: p.rep.employeeId,
      fullName: p.rep.fullName,
      leadCount: counts.get(p.rep.employeeId) ?? 0,
      reason: `${p.headroom} slots free, yield ₹${p.rep.yieldPerLead.toFixed(0)}/lead`,
    }))
    .filter((p) => p.leadCount > 0);
}
