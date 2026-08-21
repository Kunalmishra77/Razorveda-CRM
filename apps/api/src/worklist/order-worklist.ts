/**
 * Employee worklist ordering (docs/07 §4).
 *
 * "Worklist ordering is fixed and not user-sortable."
 *
 * That is a product decision with teeth. A rep who can sort by value works the
 * big-ticket leads and lets follow-ups rot — which is how the client's data ended
 * up with 174 leads sitting untouched for a full validity window. The order below
 * puts the promise the rep already made at the top, every morning.
 *
 *   1  Overdue follow-ups        (red)
 *   2  Due today                 (amber)
 *   3  Repeat-purchase due       (green — highest conversion)
 *   4  Fresh assigned today      (neutral)
 *   5  Ageing, validity expiring (grey)
 */

export type WorklistBand =
  | 'OVERDUE_FOLLOWUP'
  | 'DUE_TODAY'
  | 'REPEAT_DUE'
  | 'FRESH'
  | 'AGEING';

export const BAND_ORDER: readonly WorklistBand[] = [
  'OVERDUE_FOLLOWUP',
  'DUE_TODAY',
  'REPEAT_DUE',
  'FRESH',
  'AGEING',
];

/** Status is never encoded by colour alone — always paired with a label (docs/07 §6). */
export const BAND_LABEL: Readonly<Record<WorklistBand, string>> = {
  OVERDUE_FOLLOWUP: 'Overdue',
  DUE_TODAY: 'Due today',
  REPEAT_DUE: 'Repeat due',
  FRESH: 'New today',
  AGEING: 'Ageing',
};

export const BAND_TOKEN: Readonly<Record<WorklistBand, string>> = {
  OVERDUE_FOLLOWUP: 'clay',
  DUE_TODAY: 'brass',
  REPEAT_DUE: 'vine',
  FRESH: 'ink',
  AGEING: 'faint',
};

export interface WorklistLead {
  readonly leadId: string;
  /** ISO instant, or null when no follow-up is promised. */
  readonly nextFollowupAt: string | null;
  /** customer.next_due_date — delivered_date + sku.usage_days - 5. */
  readonly repeatDueDate: string | null;
  readonly assignedAt: string | null;
  readonly validTill: string | null;
  readonly isConverted: boolean;
  readonly closedAt: string | null;
}

export interface BandedLead {
  readonly lead: WorklistLead;
  readonly band: WorklistBand;
  /** Within a band: most urgent first. Lower sorts earlier. */
  readonly sortKey: number;
}

const dayOf = (iso: string): string => iso.slice(0, 10);

/**
 * Bands are evaluated in priority order and the FIRST match wins.
 *
 * A lead can be several things at once — a repeat-due customer whose follow-up is
 * also overdue. Ranking by the most urgent truth rather than the most recent field
 * is what stops a promise the rep made from being buried under a system-generated
 * nudge.
 */
export function bandOf(lead: WorklistLead, nowIso: string): WorklistBand | null {
  // A converted or closed lead is off the worklist entirely. Chasing it is exactly
  // the wasted effort the untouched-lead alert exists to surface.
  if (lead.isConverted || lead.closedAt) return null;

  const today = dayOf(nowIso);

  if (lead.nextFollowupAt) {
    const due = dayOf(lead.nextFollowupAt);
    if (due < today) return 'OVERDUE_FOLLOWUP';
    if (due === today) return 'DUE_TODAY';
  }

  // Repeat buyers convert several times better than a cold lead and cost nothing
  // to acquire — the highest-ROI automation in the build.
  if (lead.repeatDueDate && dayOf(lead.repeatDueDate) <= today) return 'REPEAT_DUE';

  if (lead.assignedAt && dayOf(lead.assignedAt) === today) return 'FRESH';

  return 'AGEING';
}

/**
 * Within a band, most urgent first:
 *   overdue      — longest overdue first
 *   due today    — earliest time first
 *   repeat due   — longest due first
 *   fresh        — earliest assigned first (first in, first worked)
 *   ageing       — closest to validity expiry first, so decaying leads get a last chance
 */
function sortKeyFor(lead: WorklistLead, band: WorklistBand, nowMs: number): number {
  const ms = (iso: string | null): number => (iso ? Date.parse(iso) : Number.MAX_SAFE_INTEGER);

  switch (band) {
    case 'OVERDUE_FOLLOWUP':
    case 'DUE_TODAY':
      return ms(lead.nextFollowupAt);
    case 'REPEAT_DUE':
      return ms(lead.repeatDueDate);
    case 'FRESH':
      return ms(lead.assignedAt);
    case 'AGEING':
      return lead.validTill ? Date.parse(lead.validTill) : nowMs + 3.15e10; // no expiry: last
  }
}

export function bandLeads(leads: readonly WorklistLead[], nowIso: string): BandedLead[] {
  const nowMs = Date.parse(nowIso);
  const out: BandedLead[] = [];

  for (const lead of leads) {
    const band = bandOf(lead, nowIso);
    if (band === null) continue;
    out.push({ lead, band, sortKey: sortKeyFor(lead, band, nowMs) });
  }

  return out.sort((a, b) => {
    const byBand = BAND_ORDER.indexOf(a.band) - BAND_ORDER.indexOf(b.band);
    if (byBand !== 0) return byBand;
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    // Stable tiebreak, so the same worklist does not reshuffle between refreshes.
    return a.lead.leadId < b.lead.leadId ? -1 : 1;
  });
}

/** Counts per band, for the My Day header. */
export function bandCounts(banded: readonly BandedLead[]): Record<WorklistBand, number> {
  const counts = Object.fromEntries(BAND_ORDER.map((b) => [b, 0])) as Record<WorklistBand, number>;
  for (const b of banded) counts[b.band] += 1;
  return counts;
}
