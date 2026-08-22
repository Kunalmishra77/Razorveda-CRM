import { Body, Controller, Get, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { loginSchema } from '@razorveda/shared';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from './session-policy.js';
import { AuthService } from './auth.service.js';
import { Public, type AuthedRequest } from './session.guard.js';
import QRCode from 'qrcode';

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

  /**
   * Two-factor setup, step 1 (docs/05). Public because an admin who cannot sign
   * in yet is exactly who needs it — the password is the gate, not a session.
   */
  @Public()
  @Post('totp/start')
  async startEnrolment(@Body() body: { email?: string; password?: string }) {
    if (!body?.email || !body?.password) {
      return { ok: false, message: 'Enter your email and password first.' };
    }
    const r = await this.auth.startTotpEnrolment(body.email, body.password);
    if (!r.ok) return r;
    return {
      ok: true,
      enrolmentToken: r.enrolmentToken,
      // Shown for manual entry, because a QR is useless on the phone you are
      // already holding the screen with.
      secret: r.secret,
      qrDataUri: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 220 }),
    };
  }

  /** Step 2. Nothing is saved until a real code from the app arrives. */
  @Public()
  @Post('totp/confirm')
  async confirmEnrolment(@Body() body: { enrolmentToken?: string; code?: string }) {
    if (!body?.enrolmentToken || !body?.code) {
      return { ok: false, message: 'Enter the 6-digit code from your authenticator.' };
    }
    return this.auth.confirmTotpEnrolment(body.enrolmentToken, body.code);
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
