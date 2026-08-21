import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { RlsSession } from '../db/rls-context.js';
import { AuthService } from './auth.service.js';
import { verifyAccessToken } from './jwt.js';

/**
 * Turns a request into an RLS session, or refuses it.
 *
 * Two checks, not one. The signature proves the token was issued by us; the
 * session row proves it is still allowed to act. A JWT alone cannot be taken
 * back, and docs/05 requires immediate revocation — so a valid signature over a
 * revoked session must fail.
 */

export const PUBLIC = 'PUBLIC_ROUTE';
/** Marks a route as reachable without a session. Used only by login and health. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

export interface AuthedRequest extends Request {
  session?: RlsSession;
  sessionId?: string;
}

@Injectable()
export class SessionGuard implements CanActivate {
  /**
   * Dependencies are named with @Inject rather than reflected from the parameter
   * types.
   *
   * esbuild — which tsx uses — does not implement `emitDecoratorMetadata`, so
   * `design:paramtypes` is never written and Nest's reflective DI resolves every
   * parameter to undefined. It fails at REQUEST time, not at boot, which made it
   * look like a guard bug rather than a build one. Explicit tokens work under any
   * transpiler and say out loud what is being injected.
   */
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readToken(request);
    if (!token) {
      throw new UnauthorizedException('Sign in to continue.');
    }

    const verified = await verifyAccessToken(token);
    if (!verified.ok) {
      // Deliberately vague to the caller: a precise reason tells an attacker
      // which part of their forgery failed.
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }

    const live = await this.auth.validateSession(verified.claims.sid);
    if (!live.ok) {
      // This message IS specific, because it is for the legitimate user: "you
      // signed in on another device" is what they need to hear (docs/07 §5).
      throw new UnauthorizedException(live.message);
    }

    request.session = { userId: verified.claims.sub, role: verified.claims.role };
    request.sessionId = verified.claims.sid;
    return true;
  }
}

/**
 * Cookie first, Authorization header second.
 *
 * The browser gets an HttpOnly cookie so the token is never readable by script
 * (docs/05). The header path exists for the isolation tests and for curl.
 */
function readToken(request: AuthedRequest): string | null {
  const cookie = (request.cookies as Record<string, string> | undefined)?.['rv_access'];
  if (cookie) return cookie;

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return null;
}

/** Routes only an admin or the owner may reach. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const role = request.session?.role;
    if (role !== 'ADMIN' && role !== 'OWNER') {
      // 404 rather than 403 would be better for record-scoped routes, but for a
      // whole console section the user genuinely needs to know it is not for them.
      throw new UnauthorizedException('This section is for admins.');
    }
    return true;
  }
}
