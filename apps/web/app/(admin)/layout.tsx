'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, type Session } from '../../lib/api';
import { s, T } from '../../lib/ui';

/**
 * Admin shell (docs/07 §1): dark left rail, top bar, workspace.
 *
 * Every admin screen sits under this, and it does one job beyond navigation: it
 * asks the API who you are. If the session has ended — logged out elsewhere, idle
 * timeout, revoked — the answer is a 401 and you land back on the login page with
 * the REASON, not a blank screen.
 */

const NAV = [
  { href: '/upload', label: 'Upload Centre', hint: 'Nine channels, batch history' },
  { href: '/assignment', label: 'Lead Assignment', hint: 'The unassigned pool' },
  { href: '/reports', label: 'Reports & MIS', hint: 'Daily, weekly, month close' },
  { href: '/security', label: 'Audit & Security', hint: 'Locks, copy log, sessions' },
  { href: '/orders', label: 'Orders & RTO', hint: 'Dispatch, delivery, returns' },
  { href: '/master', label: 'Master Data', hint: 'Prices, incentive, targets' },
] as const;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ ok: boolean; session: Session }>('/auth/me')
      .then((r) => {
        if (!cancelled) setSession(r.session);
      })
      .catch((e) => {
        if (cancelled) return;
        const reason = e instanceof ApiError ? e.message : 'Sign in to continue.';
        router.replace(`/login?reason=${encodeURIComponent(reason)}`);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [router, pathname]);

  async function signOut() {
    await api.post('/auth/logout').catch(() => undefined);
    router.push('/login');
  }

  if (checking) {
    return <main style={s.page}><p style={s.empty}>Checking your session…</p></main>;
  }
  if (!session) return null;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: T.paper }}>
      <nav style={rail} aria-label="Admin sections">
        <div style={{ padding: '18px 16px 22px' }}>
          <div style={brand}>RAZORVEDA</div>
          <div style={{ color: T.faint, fontSize: 11, letterSpacing: '1px' }}>CRM &amp; MIS</div>
        </div>

        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} style={navLink(active)}>
              <span>{item.label}</span>
              <span style={{ display: 'block', color: T.faint, fontSize: 11, marginTop: 2 }}>
                {item.hint}
              </span>
            </Link>
          );
        })}

        {/* Named rather than hidden. A section that does not exist yet is more
            honest as a disabled label than as a link that 404s. */}
        <div style={{ padding: '18px 16px 6px', color: T.faint, fontSize: 10, letterSpacing: '1.4px' }}>
          NOT BUILT YET
        </div>
        {['Customer 360'].map((label) => (
          <div key={label} style={{ ...navLink(false), color: T.faint, cursor: 'default' }}>{label}</div>
        ))}
      </nav>

      <div style={{ flex: 1, minWidth: 0 }}>
        <header style={topbar}>
          <span style={{ ...s.mono, color: T.muted, fontSize: 12 }}>
            {session.role}
          </span>
          <button type="button" onClick={signOut} style={s.btn}>Sign out</button>
        </header>
        {children}
      </div>
    </div>
  );
}

const rail: React.CSSProperties = {
  width: 208,
  background: T.ink,
  color: '#fff',
  flexShrink: 0,
  paddingBottom: 24,
};

const brand: React.CSSProperties = {
  font: '600 17px/1 "Barlow Condensed", system-ui, sans-serif',
  letterSpacing: '2px',
};

const navLink = (active: boolean): React.CSSProperties => ({
  display: 'block',
  padding: '10px 16px',
  color: active ? '#fff' : '#C9CFDA',
  background: active ? T.ink2 : 'transparent',
  borderLeft: `2px solid ${active ? T.brass : 'transparent'}`,
  textDecoration: 'none',
  fontSize: 13,
});

const topbar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: 12,
  padding: '10px 24px',
  background: T.card,
  borderBottom: `1px solid ${T.line}`,
};
