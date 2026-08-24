'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, type Session } from '../../lib/api';
import { s, T } from '../../lib/ui';

/**
 * Admin shell (docs/07 §1): dark left rail, top bar, workspace.
 *
 * Every admin screen sits under this, and it does two jobs beyond navigation.
 *
 * ONE: it asks the API who you are. If the session has ended — logged out
 * elsewhere, idle timeout, revoked — the answer is a 401 and you land back on the
 * login page with the REASON, not a blank screen.
 *
 * TWO: it checks that WHO YOU ARE may be here at all. It did not, and an E2E test
 * found it on the first run: a rep who opened /security was served the complete
 * admin shell — the rail listing all seven admin screens, the page heading, the
 * description — with an EMPLOYEE badge in the corner. No data leaked, because the
 * API refuses every request behind it and RLS refuses anything that gets past
 * that. What she got was an admin console with empty tables and no explanation,
 * which reads as a broken product rather than a boundary, and violates the
 * definition of done: error states say what happened and what to do next.
 *
 * It also advertised the whole admin surface — every screen name and what it does
 * — to someone with no business seeing it.
 *
 * NOT A REDIRECT. Bouncing her silently to /worklist would leave a rep who
 * followed a stale bookmark or a link from an admin wondering what she did wrong.
 * She is told plainly, once, with the way back.
 *
 * This is a UI boundary and nothing more. The authorisation that MATTERS is on the
 * API and in the policies; this stops the product lying to her about it.
 */

const NAV = [
  // First, because it is the only screen that tells you whether anything is
  // wrong. Every other entry is a place you have to already know to look.
  { href: '/today', label: 'Today', hint: 'What is waiting on you' },
  { href: '/upload', label: 'Upload Centre', hint: 'Nine channels, batch history' },
  { href: '/assignment', label: 'Lead Assignment', hint: 'Share out and move work' },
  { href: '/team', label: 'Team', hint: 'Each rep, and what she is holding' },
  { href: '/reports', label: 'Reports & MIS', hint: 'Daily, weekly, month close' },
  { href: '/security', label: 'Audit & Security', hint: 'Locks, copy log, sessions' },
  { href: '/customers', label: 'Customer 360', hint: 'One person, whole history' },
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

  // Two roles only (CLAUDE.md rule 7): ADMIN and EMPLOYEE, plus OWNER. Written as
  // "is not an admin" rather than "is an employee" so a role added later is
  // refused by default rather than admitted by omission.
  if (session.role !== 'ADMIN' && session.role !== 'OWNER') {
    return (
      <main style={{ ...s.page, maxWidth: 460, paddingTop: 72 }}>
        <h1 style={s.h1}>This is an admin screen</h1>
        <p style={s.sub}>
          Your account is a rep account, so this section is not yours to open. Nothing has gone
          wrong and you are still signed in.
        </p>
        <p style={s.sub}>
          Your work is on your worklist — today&rsquo;s calls, follow-ups and repeat customers.
        </p>
        <p style={{ marginTop: 20 }}>
          <Link href="/worklist" style={{ ...s.btnPrimary, textDecoration: 'none' }}>
            Go to my worklist
          </Link>
        </p>
      </main>
    );
  }

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
