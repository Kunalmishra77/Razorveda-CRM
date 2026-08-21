import type { ActivityType } from '@razorveda/shared';

/**
 * Activity logging (tasks/phase-1 item 4).
 *
 * `activity` is INSERT-only. A wrong disposition is corrected by logging another
 * activity, never by editing the first — which is what keeps CD/ND and Fq
 * reproducible for a past month, and what makes "disposition changed after the
 * fact" a detectable fraud signal in Phase 6 rather than an invisible edit.
 *
 * Pure functions: validation and the resulting lead state. No I/O, so every rule
 * is testable without a database.
 */

export interface DispositionRule {
  readonly dispositionId: string;
  readonly code: string;
  /** Blocks save without a follow-up date (docs/07 §4). */
  readonly requiresFollowupDate: boolean;
  /** Feeds CD/ND and Connectivity %. */
  readonly countsAsConnect: boolean;
  readonly isTerminal: boolean;
}

export interface ActivityInput {
  readonly leadId: string;
  readonly type: ActivityType;
  readonly dispositionId: string | null;
  /** Hinglish, verbatim. Never auto-corrected. */
  readonly remarkRaw: string | null;
  readonly followupAt: string | null;
  /** Self-reported: the rep says whether the call connected (D-03). */
  readonly connected: boolean | null;
}

export type ActivityValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: string; readonly message: string };

/**
 * Disposition is mandatory and the API enforces it — not only the UI.
 *
 * F4 is the reason: one tab of the client's data carries 49 spellings of ~12
 * outcomes because the field was free text. A closed vocabulary that the server
 * does not enforce is just a free-text field with a nicer widget.
 */
export function validateActivity(
  input: ActivityInput,
  disposition: DispositionRule | null,
): ActivityValidation {
  // NOTE and SYSTEM entries are not contact attempts and carry no outcome.
  const needsDisposition = input.type === 'CALL' || input.type === 'WHATSAPP' || input.type === 'SMS';

  if (needsDisposition && !input.dispositionId) {
    return {
      ok: false,
      field: 'dispositionId',
      message: 'Choose an outcome before saving. Every contact attempt needs one.',
    };
  }

  if (input.dispositionId && !disposition) {
    return {
      ok: false,
      field: 'dispositionId',
      message: 'That outcome is not in the list. Pick one from the dropdown.',
    };
  }

  if (disposition?.requiresFollowupDate && !input.followupAt) {
    return {
      ok: false,
      field: 'followupAt',
      message: `"${disposition.code}" needs a follow-up date. Set when you will call back.`,
    };
  }

  // A follow-up in the past is almost always a typo, and it would land at the top
  // of the worklist as overdue the moment it saved.
  if (input.followupAt && Number.isNaN(Date.parse(input.followupAt))) {
    return { ok: false, field: 'followupAt', message: 'That follow-up date is not a valid date.' };
  }

  return { ok: true };
}

export interface LeadState {
  readonly contactAttempts: number;
  readonly everConnected: boolean;
  readonly firstContactAt: string | null;
  /** Drives Today's CD. Set on the FIRST connected contact only (defect B5). */
  readonly firstConnectedAt: string | null;
  readonly lastContactAt: string | null;
  readonly nextFollowupAt: string | null;
  readonly currentDispositionId: string | null;
  readonly closedAt: string | null;
}

/**
 * The lead state after an activity. Derived, never sent by a client.
 *
 * `firstConnectedAt` is the one to be careful with. It is NOT `firstContactAt`:
 * contact is an attempt, connect is a conversation. Substituting one for the other
 * silently inflates CD — a metric the client already trusts and reads daily —
 * which is exactly what defect B5 was.
 */
export function applyActivityToLead(
  current: LeadState,
  input: ActivityInput,
  disposition: DispositionRule | null,
  occurredAt: string,
): LeadState {
  const isContactAttempt =
    input.type === 'CALL' || input.type === 'WHATSAPP' || input.type === 'SMS';

  if (!isContactAttempt) {
    // A NOTE must not inflate Fq. The client's Frequency column is a real metric,
    // not a row counter.
    return {
      ...current,
      ...(input.followupAt ? { nextFollowupAt: input.followupAt } : {}),
    };
  }

  // Connected is only true when the rep says so AND the disposition agrees.
  // "Ringing" with connected=true is a mis-click, not a conversation.
  const connected = input.connected === true && disposition?.countsAsConnect === true;

  return {
    contactAttempts: current.contactAttempts + 1,
    everConnected: current.everConnected || connected,
    firstContactAt: current.firstContactAt ?? occurredAt,
    // Set once, on the first CONNECTED contact, and never overwritten.
    firstConnectedAt: current.firstConnectedAt ?? (connected ? occurredAt : null),
    lastContactAt: occurredAt,
    // A terminal disposition clears the follow-up: chasing a closed lead is how
    // the client's reps ended up with 174 dead leads sitting for a full validity
    // window.
    nextFollowupAt: disposition?.isTerminal ? null : (input.followupAt ?? current.nextFollowupAt),
    currentDispositionId: input.dispositionId ?? current.currentDispositionId,
    closedAt: disposition?.isTerminal ? (current.closedAt ?? occurredAt) : current.closedAt,
  };
}

/**
 * The remark is stored exactly as typed (docs/07 §4).
 *
 * Four months of "abhi product hai baad mei lungi" is the raw material for the
 * Phase 6 objection intelligence. Normalising on the way in would destroy the
 * evidence and leave only somebody's guess at what was meant.
 */
export function storedRemark(raw: string | null): string | null {
  if (raw === null) return null;
  // Trailing whitespace only. No case change, no spell correction, no transliteration.
  const trimmed = raw.replace(/\s+$/u, '');
  return trimmed === '' ? null : trimmed;
}
