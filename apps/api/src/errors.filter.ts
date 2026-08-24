import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * TURNS "Internal server error" INTO SOMETHING A PERSON CAN ACT ON.
 *
 * The database stopped on a development machine and every screen showed
 * "Internal server error". That message says three things, all useless: something
 * broke, it was our fault, and you cannot do anything. It took reading the API's
 * stack trace to find `ECONNREFUSED 127.0.0.1:5433` — the database was simply not
 * running.
 *
 * The definition of done in CLAUDE.md is explicit: error states say what happened
 * and what to do next. A generic 500 fails both halves, and it fails them for the
 * people least able to work around it — a rep at 10am and an admin mid-upload.
 *
 * So the failures this system can actually have are named. Everything genuinely
 * unexpected still becomes a 500, because inventing a friendly explanation for a
 * bug nobody understands is worse than admitting it is a bug.
 *
 * WHAT IS DELIBERATELY NOT LEAKED: the connection string, the SQL, the stack. The
 * log gets all of that. The response gets a sentence.
 */

const log = new Logger('Errors');

interface Named {
  readonly status: HttpStatus;
  readonly message: string;
}

/**
 * Postgres and Node connection failures, mapped to what they mean to a user.
 *
 * Codes rather than message matching: `ECONNREFUSED` is stable, the text around
 * it is not.
 */
function nameIt(e: unknown): Named | null {
  const err = e as { code?: string; routine?: string; message?: string };
  const code = err?.code;

  // The database is not reachable at all: not running, wrong port, network gone.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message:
        'The database is not responding, so nothing can be read or saved right now. ' +
        'This is not something you did. Tell whoever runs the server — if you are running ' +
        'it yourself, start it with `npm run pg:start`.',
    };
  }

  // Connected once, then the connection died underneath a query.
  if (code === 'ECONNRESET' || code === '57P01' || code === '08006' || code === '08003') {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message:
        'The connection to the database dropped while this was running. Nothing was ' +
        'half-saved — try again in a moment.',
    };
  }

  // Timed out waiting for a connection from the pool: usually the database is up
  // but overwhelmed, or every connection is held by something slow.
  if (code === 'ETIMEDOUT' || /timeout exceeded when trying to connect/i.test(err?.message ?? '')) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message:
        'The database took too long to answer. It is probably busy rather than broken — ' +
        'wait a few seconds and try again.',
    };
  }

  // Postgres refused the write. Almost always a real rule doing its job, and the
  // trigger's own message is far better than anything generic.
  if (code === 'P0001' && err.message) {
    return { status: HttpStatus.BAD_REQUEST, message: err.message };
  }

  // Unique violation — a duplicate the caller can fix.
  if (code === '23505') {
    return {
      status: HttpStatus.BAD_REQUEST,
      message: 'That already exists. Check whether it was added a moment ago, then try again.',
    };
  }

  // RLS or a missing GRANT refused it outright.
  if (code === '42501') {
    return {
      status: HttpStatus.FORBIDDEN,
      message: 'Your account is not allowed to do that. If you think it should be, ask an admin.',
    };
  }

  return null;
}

@Catch()
export class ErrorsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{ method?: string; url?: string }>();

    // Anything the application raised deliberately already carries its own status
    // and a message someone wrote on purpose. Left completely alone.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { ok: false, message: body } : body);
      return;
    }

    const named = nameIt(exception);
    const where = `${req?.method ?? '?'} ${req?.url ?? '?'}`;

    if (named) {
      // Logged as a warning, not an error: an unreachable database is an
      // operational fact, and burying it in a stack trace is how it took a
      // stack trace to diagnose last time.
      log.warn(`${where} → ${named.status}: ${(exception as Error)?.message ?? 'unknown'}`);
      res.status(named.status).json({ ok: false, message: named.message });
      return;
    }

    // Genuinely unexpected. The full detail goes to the log; the caller is told
    // it is a bug rather than being handed a plausible-sounding guess.
    log.error(`${where} → unhandled`, (exception as Error)?.stack ?? String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      ok: false,
      message:
        'Something went wrong at our end and it has been logged. Nothing you did caused it. ' +
        'Try again, and tell an admin if it keeps happening.',
    });
  }
}
