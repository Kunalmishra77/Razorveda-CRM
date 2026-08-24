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

        {/*
          A REP HAD NO WAY TO GET ANYWHERE.
          The shell was a logo and a sign-out button, so the only screen she could
          reach was whichever one she happened to land on. Everything she owns —
          her customers, her orders, how she is doing — existed in the database
          and nowhere she could click.

          Four items, and it stays four. This is the whole product for the person
          who uses it most, and a rail of a dozen links would be the admin's
          problem transplanted onto her.
        */}
        <nav aria-label="Your sections" style={{ display: 'flex', gap: 2, marginLeft: 18, flex: 1 }}>
          {REP_NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} style={repLink(active)}>
                {item.label}
              </Link>
            );
          })}
        </nav>

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

/** Named for what she calls them, not for what the tables are called. */
const REP_NAV = [
  { href: '/worklist', label: 'My day' },
  { href: '/my-customers', label: 'My customers' },
  { href: '/my-orders', label: 'My orders' },
  { href: '/how-am-i-doing', label: 'How am I doing' },
] as const;

const repLink = (active: boolean): React.CSSProperties => ({
  padding: '7px 12px',
  borderRadius: 3,
  color: active ? '#fff' : '#C9CFDA',
  background: active ? '#2A3040' : 'transparent',
  textDecoration: 'none',
  fontSize: 13.5,
  fontWeight: active ? 600 : 400,
  whiteSpace: 'nowrap',
});
