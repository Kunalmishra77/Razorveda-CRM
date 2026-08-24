'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { loginSchema } from '@razorveda/shared';
import { api, ApiError, type LoginResponse } from '../../lib/api';
import { s, T } from '../../lib/ui';

/**
 * Sign in.
 *
 * The same Zod schema the API validates with (`@razorveda/shared`), so the form
 * and the endpoint cannot disagree about what a valid login looks like. The
 * client check is for speed of feedback only — the server never trusts it.
 */
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsTotp, setNeedsTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  // Two-factor setup, for an admin signing in for the first time.
  const [enrol, setEnrol] = useState<{ token: string; secret: string; qr: string } | null>(null);
  const [enrolCode, setEnrolCode] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = loginSchema.safeParse({
      email,
      password,
      ...(totp ? { totp } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form and try again.');
      return;
    }

    setBusy(true);
    try {
      const result = await api.post<LoginResponse>('/auth/login', parsed.data);
      if (!result.ok) {
        // TOTP_REQUIRED is not a failure to shout about — it is the next step.
        if (result.reason === 'TOTP_REQUIRED') {
          setNeedsTotp(true);
          // "Required but not set up yet" is a first login, not a wrong code.
          // Offer setup rather than an error the admin cannot act on.
          if (/not set up yet/i.test(result.message ?? '')) {
            const start = await api.post<{
              ok: boolean; message?: string; enrolmentToken?: string; secret?: string; qrDataUri?: string;
            }>('/auth/totp/start', { email, password });
            if (start.ok && start.enrolmentToken) {
              setEnrol({ token: start.enrolmentToken, secret: start.secret!, qr: start.qrDataUri! });
              setError(null);
              return;
            }
          }
        }
        setError(result.message ?? 'That did not work.');
        return;
      }
      // Each role lands where their work is. An employee sent to the Upload
      // Centre would see a 401 section and read it as being locked out.
      //
      // Admins land on Today rather than the Upload Centre: opening the product
      // on a file picker answers a question nobody asked. Today answers the one
      // they did — is anything wrong, and what do I do about it.
      router.push(result.user?.role === 'EMPLOYEE' ? '/dashboard' : '/today');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something unexpected happened.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrolment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; message?: string }>('/auth/totp/confirm', {
        enrolmentToken: enrol?.token,
        code: enrolCode,
      });
      if (!r.ok) { setError(r.message ?? 'That code was not accepted.'); return; }
      // Enrolled. Send them back to sign in properly with their new code.
      setEnrol(null);
      setEnrolCode('');
      setTotp('');
      setNeedsTotp(true);
      setError('Authenticator linked. Enter the current 6-digit code to sign in.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be confirmed.');
    } finally {
      setBusy(false);
    }
  }

  if (enrol) {
    return (
      <main style={{ ...s.page, maxWidth: 400, paddingTop: 56 }}>
        <h1 style={s.h1}>Set up two-factor</h1>
        <p style={s.sub}>
          Admin accounts need an authenticator app. This is a one-time setup.
        </p>

        <form onSubmit={confirmEnrolment} style={s.card}>
          <ol style={{ fontSize: 13, color: T.muted, paddingLeft: 18, margin: '0 0 12px' }}>
            <li>Open Google Authenticator, Authy or similar.</li>
            <li>Scan this code, or type the key below.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enrol.qr} alt="QR code for your authenticator app"
            style={{ display: 'block', margin: '0 auto 10px', border: `1px solid ${T.line}`, borderRadius: 3 }}
          />

          <p style={{ ...s.sub, fontSize: 11.5, textAlign: 'center', margin: '0 0 4px' }}>
            Cannot scan? Type this key instead:
          </p>
          <p style={{ ...s.mono, textAlign: 'center', wordBreak: 'break-all', fontSize: 12, margin: '0 0 14px' }}>
            {enrol.secret}
          </p>

          <label style={s.label} htmlFor="enrolCode">6-digit code</label>
          <input
            id="enrolCode" inputMode="numeric" maxLength={6} value={enrolCode}
            onChange={(e) => setEnrolCode(e.target.value.replace(/\D/g, ''))}
            style={{ ...s.input, ...s.mono, letterSpacing: '3px', marginBottom: 12 }}
          />

          <button type="submit" disabled={busy || enrolCode.length !== 6}
            style={busy || enrolCode.length !== 6 ? s.btnDisabled : { ...s.btnPrimary, width: '100%' }}>
            {busy ? 'Checking…' : 'Link authenticator'}
          </button>

          {error && <p role="alert" style={{ color: T.clay, fontSize: 13, marginTop: 12, marginBottom: 0 }}>{error}</p>}
        </form>

        <p style={{ ...s.sub, fontSize: 12 }}>
          Keep this app. If you lose it, an admin has to reset two-factor for you — it cannot be
          re-linked from this screen.
        </p>
      </main>
    );
  }

  return (
    <main style={{ ...s.page, maxWidth: 380, paddingTop: 64 }}>
      <h1 style={s.h1}>Razorveda CRM</h1>
      <p style={s.sub}>Sign in to continue.</p>

      <form onSubmit={onSubmit} style={s.card}>
        <label style={s.label} htmlFor="email">Email</label>
        <input
          id="email" type="email" autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)} style={{ ...s.input, marginBottom: 12 }}
        />

        <label style={s.label} htmlFor="password">Password</label>
        <input
          id="password" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} style={{ ...s.input, marginBottom: 12 }}
        />

        {needsTotp && (
          <>
            <label style={s.label} htmlFor="totp">
              6-digit code from your authenticator
            </label>
            <input
              id="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              style={{ ...s.input, ...s.mono, marginBottom: 12, letterSpacing: '3px' }}
            />
          </>
        )}

        <button type="submit" disabled={busy} style={busy ? s.btnDisabled : { ...s.btnPrimary, width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error && (
          // Says what happened and what to do next. Never "Something went wrong".
          <p role="alert" style={{ color: T.clay, fontSize: 13, marginTop: 12, marginBottom: 0 }}>
            {error}
          </p>
        )}
      </form>

      <p style={{ ...s.sub, fontSize: 12 }}>
        Admins and the owner need a 6-digit code. Ask an admin if you are locked out.
      </p>
    </main>
  );
}
