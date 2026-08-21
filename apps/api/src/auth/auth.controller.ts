import { Body, Controller, Get, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { loginSchema } from '@razorveda/shared';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from './session-policy.js';
import { AuthService } from './auth.service.js';
import { Public, type AuthedRequest } from './session.guard.js';

/**
 * Auth routes.
 *
 * Tokens go into HttpOnly cookies, never into a JSON body the browser can read.
 * docs/05 requires no API tokens for the EMPLOYEE role, and a token in
 * localStorage is an API token that any script on the page can take.
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body() body: unknown,
    @Req() request: AuthedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      // Field-level messages, because the form shows them against the field.
      return {
        ok: false,
        reason: 'INVALID_INPUT',
        message: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
      };
    }

    const outcome = await this.auth.login({
      email: parsed.data.email,
      password: parsed.data.password,
      totp: parsed.data.totp,
      ipAddress: request.ip ?? null,
      localTime: localTimeInIst(),
    });

    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason, message: outcome.message };
    }

    setAuthCookies(response, outcome.accessToken, outcome.refreshToken);
    return { ok: true, user: outcome.user };
  }

  @Public()
  @Post('refresh')
  async refresh(@Req() request: AuthedRequest, @Res({ passthrough: true }) response: Response) {
    const token = (request.cookies as Record<string, string> | undefined)?.['rv_refresh'];
    if (!token) throw new UnauthorizedException('Sign in to continue.');

    const outcome = await this.auth.refresh(token);
    if (!outcome.ok) {
      clearAuthCookies(response);
      throw new UnauthorizedException(outcome.message);
    }

    setAuthCookies(response, outcome.accessToken, outcome.refreshToken);
    return { ok: true };
  }

  @Post('logout')
  async logout(@Req() request: AuthedRequest, @Res({ passthrough: true }) response: Response) {
    if (request.sessionId) await this.auth.logout(request.sessionId);
    clearAuthCookies(response);
    return { ok: true };
  }

  /** Who am I? The web app calls this on load to decide what to render. */
  @Get('me')
  me(@Req() request: AuthedRequest) {
    return { ok: true, session: request.session };
  }
}

/**
 * The shift window is checked against office time, not the server's timezone or
 * the browser's. A rep travelling does not get a different shift.
 */
function localTimeInIst(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

function setAuthCookies(response: Response, accessToken: string, refreshToken: string): void {
  const secure = process.env['NODE_ENV'] === 'production';
  response.cookie('rv_access', accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: ACCESS_TOKEN_TTL_MS,
    path: '/',
  });
  response.cookie('rv_refresh', refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    maxAge: REFRESH_TOKEN_TTL_MS,
    // Only ever sent to the refresh route, so an XSS on any other page cannot
    // reach the long-lived token even if it could read cookies.
    path: '/auth/refresh',
  });
}

function clearAuthCookies(response: Response): void {
  response.clearCookie('rv_access', { path: '/' });
  response.clearCookie('rv_refresh', { path: '/auth/refresh' });
}
