import type { NextFunction, Request, Response } from 'express';

/**
 * Rate limiting (Phase 5 deliverable 7).
 *
 * IN-MEMORY, AND THAT IS A REAL LIMITATION, STATED UP FRONT.
 *
 * The counters live in this process. One API instance is the deployed shape
 * (CLAUDE.md rule 9: one Postgres, one API, one worker pool), so today this is
 * accurate. The moment a second instance runs, each keeps its own count and the
 * effective limit doubles. Redis is already a dependency for BullMQ and is where
 * this belongs if the API is ever scaled out — noted here rather than discovered
 * when it stops working.
 *
 * The limits that matter are on `/auth/login`. Password guessing is the only
 * fully unauthenticated attack surface with a prize behind it, and 2FA covers
 * admins but not reps.
 */

interface Bucket {
  /** Request timestamps inside the window, oldest first. */
  hits: number[];
}

export interface LimitRule {
  readonly max: number;
  readonly windowMs: number;
  /** Shown to the caller. Says what to do, not just what happened. */
  readonly message: string;
}

/** Tightest first — the first prefix that matches wins. */
export const DEFAULT_RULES: ReadonlyArray<readonly [string, LimitRule]> = [
  [
    '/auth/login',
    {
      max: 10,
      windowMs: 5 * 60_000,
      message:
        'Too many sign-in attempts from this address. Wait five minutes and try again. ' +
        'If you have forgotten your password, an admin can reset it.',
    },
  ],
  [
    '/auth/totp',
    {
      // Enrolment binds an authenticator to an account. Slower than login on
      // purpose: a six-digit code is guessable at volume and nothing else stands
      // between an attacker and a permanent second factor of their own.
      max: 5,
      windowMs: 5 * 60_000,
      message: 'Too many two-factor attempts. Wait five minutes and try again.',
    },
  ],
  [
    '/pii/copy',
    {
      // Not a brute-force defence — the velocity lock is. This is the backstop
      // for a client hammering the endpoint faster than a human could copy, which
      // would otherwise fill pii_access_log rather than being caught by it.
      max: 60,
      windowMs: 60_000,
      message: 'Too many requests. Slow down.',
    },
  ],
];

export const GLOBAL_RULE: LimitRule = {
  max: 600,
  windowMs: 60_000,
  message: 'Too many requests from this address. Wait a minute and try again.',
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rules: ReadonlyArray<readonly [string, LimitRule]> = DEFAULT_RULES,
    private readonly globalRule: LimitRule = GLOBAL_RULE,
  ) {}

  private ruleFor(path: string): { key: string; rule: LimitRule } {
    for (const [prefix, rule] of this.rules) {
      if (path.startsWith(prefix)) return { key: prefix, rule };
    }
    return { key: '*', rule: this.globalRule };
  }

  /**
   * Returns null when the request is allowed, or the rule that refused it.
   *
   * Separated from the middleware so the decision is testable without an HTTP
   * server or a clock.
   */
  check(ip: string, path: string, now: number): LimitRule | null {
    const { key, rule } = this.ruleFor(path);
    const bucketKey = `${ip}|${key}`;

    const bucket = this.buckets.get(bucketKey) ?? { hits: [] };
    const since = now - rule.windowMs;

    // Sliding window, not a fixed one. A fixed window lets an attacker send `max`
    // at 11:59:59 and `max` again at 12:00:00 — double the limit across a second.
    bucket.hits = bucket.hits.filter((t) => t > since);

    if (bucket.hits.length >= rule.max) {
      this.buckets.set(bucketKey, bucket);
      return rule;
    }

    bucket.hits.push(now);
    this.buckets.set(bucketKey, bucket);
    return null;
  }

  /**
   * Drops buckets nothing has touched for an hour.
   *
   * Without this the map grows with every distinct IP for as long as the process
   * lives, which is a slow memory leak with an attacker-controlled key. Called on
   * a timer by the middleware factory.
   */
  sweep(now: number): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.length === 0 || bucket.hits[bucket.hits.length - 1]! < now - 3_600_000) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Whether the limiter is active.
 *
 * The live test suite signs in as several people several times from one address
 * and trips the login rule legitimately — the control is working, and it is
 * working on the wrong target. So there is an explicit off switch for that one
 * situation, and the API SAYS SO at boot every time it is used.
 *
 * Not `NODE_ENV !== 'production'`. A developer running the app locally should
 * have rate limiting on, because that is when its rough edges get found. This has
 * to be asked for by name.
 */
export const rateLimitDisabled = (): boolean => process.env['RATE_LIMIT_DISABLED'] === '1';

export function rateLimit(limiter: RateLimiter = new RateLimiter()) {
  if (rateLimitDisabled()) {
    console.warn(
      'api      RATE LIMITING IS OFF (RATE_LIMIT_DISABLED=1). Login brute-force protection ' +
        'is disabled. This must never be set in production.',
    );
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  // unref so a long-lived timer never holds the process open during shutdown or
  // in a test run.
  const timer = setInterval(() => limiter.sweep(Date.now()), 10 * 60_000);
  timer.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    // req.ip honours trust proxy. Behind Coolify that must be configured, or every
    // request appears to come from the reverse proxy and one rep's burst rate
    // limits the whole company. See main.ts.
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const refused = limiter.check(ip, req.path, Date.now());

    if (refused) {
      res.setHeader('Retry-After', String(Math.ceil(refused.windowMs / 1000)));
      res.status(429).json({ ok: false, message: refused.message });
      return;
    }
    next();
  };
}
