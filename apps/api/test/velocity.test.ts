import { describe, it, expect } from 'vitest';
import { evaluateVelocity, lockAlertBody } from '../src/security/velocity.js';
import { PII_COPY_VELOCITY_COUNT, PII_COPY_VELOCITY_WINDOW_SEC } from '@razorveda/shared';

/**
 * Copy-velocity detection (docs/05, Phase 5 criterion 2).
 *
 * The boundaries are the whole test. One event either side of the threshold is
 * the difference between locking a rep who was working fast and missing one who
 * was harvesting — and neither failure announces itself.
 */

const NOW = Date.parse('2026-08-22T10:00:00.000Z');
const secondsAgo = (s: number) => NOW - s * 1000;
const copies = (...ages: number[]) => ages.map((a) => ({ at: secondsAgo(a), action: 'COPY' as const }));

describe('the documented rule', () => {
  it('is 4 copies in 90 seconds', () => {
    expect(PII_COPY_VELOCITY_COUNT).toBe(4);
    expect(PII_COPY_VELOCITY_WINDOW_SEC).toBe(90);
  });
});

describe('the threshold', () => {
  it('does not fire on three', () => {
    expect(evaluateVelocity(copies(10, 20, 30), NOW).breached).toBe(false);
  });

  it('fires on the fourth', () => {
    const d = evaluateVelocity(copies(10, 20, 30, 40), NOW);
    expect(d.breached).toBe(true);
    expect(d.count).toBe(4);
  });

  it('counts an event exactly ON the window edge', () => {
    // Inclusive at 90s. Excluding it would make the rule slightly weaker than
    // documented, in the attacker's favour, and nobody would ever notice.
    expect(evaluateVelocity(copies(10, 20, 30, 90), NOW).breached).toBe(true);
  });

  it('does not count an event just outside it', () => {
    expect(evaluateVelocity(copies(10, 20, 30, 91), NOW).breached).toBe(false);
  });
});

describe('what counts as a copy', () => {
  it('a VIEW never counts, however many there are', () => {
    // A rep looking at leads she is about to call is the normal act this whole
    // system is built around. Counting views would lock her for working.
    const views = [10, 20, 30, 40, 50, 60].map((a) => ({ at: secondsAgo(a), action: 'VIEW' as const }));
    expect(evaluateVelocity(views, NOW).breached).toBe(false);
  });

  it('views mixed in do not push copies over the line', () => {
    const mixed = [
      ...copies(10, 20, 30),
      { at: secondsAgo(15), action: 'VIEW' as const },
      { at: secondsAgo(25), action: 'VIEW' as const },
    ];
    expect(evaluateVelocity(mixed, NOW).breached).toBe(false);
  });

  it('a future-dated event is ignored rather than trusted', () => {
    // Clock skew between the app and the database is real. An event stamped in
    // the future must not be able to trip the lock.
    const withFuture = [...copies(10, 20, 30), { at: NOW + 60_000, action: 'COPY' as const }];
    expect(evaluateVelocity(withFuture, NOW).breached).toBe(false);
  });
});

describe('the pace it is actually distinguishing', () => {
  it('a rep working normally is never locked', () => {
    // One number, then four minutes on the phone. Across a whole hour that is
    // ~15 copies and never four in ninety seconds.
    const hour = Array.from({ length: 15 }, (_, i) => ({
      at: secondsAgo(i * 240),
      action: 'COPY' as const,
    }));
    expect(evaluateVelocity(hour, NOW).breached).toBe(false);
  });

  it('a script is caught immediately', () => {
    const script = Array.from({ length: 20 }, (_, i) => ({
      at: secondsAgo(i * 2),
      action: 'COPY' as const,
    }));
    const d = evaluateVelocity(script, NOW);
    expect(d.breached).toBe(true);
    expect(d.count).toBe(20);
  });
});

describe('what the admin is told', () => {
  const decision = evaluateVelocity(copies(5, 10, 15, 20), NOW);

  it('names the rep, the reason and the effect', () => {
    const body = lockAlertBody('Nikita', decision, new Date(NOW));
    expect(body).toContain('Nikita');
    expect(body).toMatch(/sessions have been revoked/i);
    expect(body).toMatch(/cannot sign in/i);
  });

  it('offers the innocent explanations before the guilty one', () => {
    // An alert that reads as an accusation gets a rep in trouble for a stuck key.
    // The admin should arrive at the conversation with the alternatives in mind.
    const body = lockAlertBody('Nikita', decision, new Date(NOW));
    expect(body).toMatch(/innocent explanations/i);
    expect(body).toMatch(/before speaking to her/i);
  });

  it('says nothing at all when there was no breach', () => {
    expect(lockAlertBody('Nikita', evaluateVelocity(copies(10), NOW), new Date(NOW))).toBe('');
  });
});
