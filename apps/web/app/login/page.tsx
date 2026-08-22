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
        if (result.reason === 'TOTP_REQUIRED') setNeedsTotp(true);
        setError(result.message ?? 'That did not work.');
        return;
      }
      // Each role lands where their work is. An employee sent to the Upload
      // Centre would see a 401 section and read it as being locked out.
      router.push(result.user?.role === 'EMPLOYEE' ? '/worklist' : '/upload');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something unexpected happened.');
    } finally {
      setBusy(false);
    }
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
