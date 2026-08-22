import type { NextFunction, Request, Response } from 'express';

/**
 * Security response headers (Phase 5 deliverable 7).
 *
 * Hand-written rather than pulled from a library. Six headers is not enough code
 * to justify a dependency, and this codebase already carries fifteen npm audit
 * findings it did not choose (D-170) — every avoided dependency is one fewer
 * thing to patch at three in the morning.
 *
 * The Content-Security-Policy here is for the API, which serves JSON and one
 * XLSX. It is therefore as tight as a policy can be: nothing loads, nothing
 * frames it, nothing runs. The WEB app needs its own, looser policy in
 * next.config, because it genuinely does load scripts and styles.
 */

export interface HeaderOptions {
  /** HSTS is only meaningful over TLS, and harmful in local development. */
  readonly production: boolean;
}

export function securityHeaders({ production }: HeaderOptions) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // Nothing here is ever a document, so the policy denies everything. If a
    // response is ever coerced into being rendered — a stored XSS reflected
    // through an error message, say — there is nothing it is allowed to do.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );

    // Stops a browser guessing that a JSON error body is HTML and rendering it.
    // The single most useful header on an API.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Belt and braces with frame-ancestors above, for anything that still reads
    // the older header.
    res.setHeader('X-Frame-Options', 'DENY');

    // Customer names and ids appear in URLs. Without this they travel in the
    // Referer to any third party a page later links to.
    res.setHeader('Referrer-Policy', 'no-referrer');

    // The API needs none of these. Denying them costs nothing and shrinks the
    // surface if a response is ever embedded somewhere it should not be.
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');

    // Only over TLS. Sending HSTS from a local http server teaches the developer's
    // browser to refuse http://localhost for the next two years, which is a
    // genuinely annoying thing to inflict on someone.
    if (production) {
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }

    next();
  };
}

/**
 * Origin checking, as the second CSRF defence.
 *
 * The first is `SameSite=strict` on both cookies, which a browser enforces before
 * a request is even sent. This is here because SameSite is a browser promise: a
 * non-browser client, or a browser with an unusual configuration, does not make
 * it. Two independent controls, and the residual gap is stated rather than
 * implied — a client that sends no Origin at all is allowed through, because
 * curl, the digest scheduler and the test suite all do exactly that.
 */
export function requireKnownOrigin(allowed: readonly string[]) {
  const permitted = new Set(allowed);

  return (req: Request, res: Response, next: NextFunction): void => {
    // Safe methods cannot change anything, and CSRF is about state change.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string' && !permitted.has(origin)) {
      res.status(403).json({
        ok: false,
        message:
          'That request came from an unrecognised origin and was refused. If you are ' +
          'running the app on a different address, set WEB_ORIGIN and restart the API.',
      });
      return;
    }

    next();
  };
}
