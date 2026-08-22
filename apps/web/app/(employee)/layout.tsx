'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, type Session } from '../../lib/api';
import { s, T } from '../../lib/ui';

/**
 * Employee portal shell.
 *
 * Deliberately smaller than the admin rail: a rep has one job today, and every
 * extra link is a way to not do it. docs/05 also removes several things on
 * purpose — no export, no customer search, no bulk list view — so there is
 * genuinely little to navigate to.
 */
export default function EmployeeLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ session: Session }>('/auth/me')
      .then((r) => {
        if (cancelled) return;
        // An admin who lands here is sent to their own console rather than shown
        // an empty worklist they will read as a bug.
        if (r.session.role !== 'EMPLOYEE') { router.replace('/upload'); return; }
        setSession(r.session);
      })
      .catch((e) => {
        if (cancelled) return;
        const reason = e instanceof ApiError ? e.message : 'Sign in to continue.';
        router.replace(`/login?reason=${encodeURIComponent(reason)}`);
      })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [router, pathname]);

  async function signOut() {
    await api.post('/auth/logout').catch(() => undefined);
    router.push('/login');
  }

  if (checking) return <main style={s.page}><p style={s.empty}>Checking your session…</p></main>;
  if (!session) return null;

  return (
    <div style={{ minHeight: '100vh', background: T.paper }}>
      <header style={bar}>
        <Link href="/worklist" style={{ ...brand, textDecoration: 'none', color: '#fff' }}>
          RAZORVEDA
        </Link>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ ...s.mono, color: '#C9CFDA', fontSize: 12 }}>{session.role}</span>
          <button type="button" onClick={signOut} style={{ ...s.btn, background: 'transparent', color: '#fff', borderColor: '#3A4150' }}>
            Sign out
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

const bar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '10px 24px',
  background: T.ink,
  color: '#fff',
};

const brand: React.CSSProperties = {
  font: '600 17px/1 "Barlow Condensed", system-ui, sans-serif',
  letterSpacing: '2px',
};
