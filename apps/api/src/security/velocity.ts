import { PII_COPY_VELOCITY_COUNT, PII_COPY_VELOCITY_WINDOW_SEC } from '@razorveda/shared';

/**
 * Copy-velocity detection (docs/05, Phase 5 deliverable 3).
 *
 * "≥4 copy events in 90 s → auto-lock + admin alert."
 *
 * WHY THIS EXISTS AT ALL. Reps dial from their own handsets, so they must see
 * full phone numbers (CLAUDE.md rule 8). Prevention is therefore off the table
 * and the entire control is detection plus attribution. This is the detection.
 *
 * WHY THE THRESHOLD IS WHAT IT IS. A human working leads copies one number, then
 * talks for four minutes. Four numbers inside ninety seconds is not a person
 * selling — it is a person harvesting, or a script. The gap between the two
 * behaviours is wide enough that the rule does not need to be clever.
 *
 * Pure: no database, no clock. The events and `now` are passed in, so every
 * boundary can be tested exactly rather than by sleeping.
 */

export interface AccessEvent {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly action: 'VIEW' | 'COPY';
}

export type VelocityDecision =
  | { readonly breached: false; readonly count: number }
  | {
      readonly breached: true;
      readonly count: number;
      readonly windowSeconds: number;
      readonly reason: string;
    };

/**
 * Only COPY counts.
 *
 * A VIEW is a rep looking at the lead she is about to call — the normal act this
 * system is built around, and counting it would lock a rep for working quickly.
 * A COPY is the number leaving the application, which is the event with
 * exfiltration value. They are logged separately for exactly this reason.
 */
export function evaluateVelocity(
  events: readonly AccessEvent[],
  now: number,
  threshold: number = PII_COPY_VELOCITY_COUNT,
  windowSeconds: number = PII_COPY_VELOCITY_WINDOW_SEC,
): VelocityDecision {
  const since = now - windowSeconds * 1000;

  // Inclusive at the window edge: an event exactly 90s old is still inside a
  // 90-second window. Excluding it would make the rule slightly weaker than
  // documented, in the attacker's favour.
  const recent = events.filter((e) => e.action === 'COPY' && e.at >= since && e.at <= now);

  if (recent.length < threshold) return { breached: false, count: recent.length };

  return {
    breached: true,
    count: recent.length,
    windowSeconds,
    reason:
      `${recent.length} phone numbers copied within ${windowSeconds} seconds. ` +
      `A rep working leads copies one number then talks for minutes; this pace is ` +
      `machine-like. The account is locked pending review.`,
  };
}

/** What an admin is told, in words they can act on. */
export function lockAlertBody(repName: string, decision: VelocityDecision, at: Date): string {
  if (!decision.breached) return '';
  return [
    `${repName}'s account has been locked automatically.`,
    '',
    `Reason: ${decision.reason}`,
    `Detected at: ${at.toISOString()}`,
    '',
    'What this means: her sessions have been revoked and she cannot sign in until an admin unlocks the account.',
    '',
    'What to do:',
    '  1. Look at her copy history in the security console before speaking to her.',
    '  2. There are innocent explanations — a stuck key, a browser extension, a rep',
    '     copying numbers into her own phone in a batch before a call block.',
    '  3. Unlock from Master Data once you are satisfied. The lock and the unlock are',
    '     both on the audit trail.',
  ].join('\n');
}
