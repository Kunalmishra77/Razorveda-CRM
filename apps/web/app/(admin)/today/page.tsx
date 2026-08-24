'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * WHAT NEEDS AN ADMIN TODAY.
 *
 * Before this, signing in as an admin landed you on the Upload Centre — a file
 * picker. Nothing anywhere answered the question an admin actually opens the
 * product with, which is not "where do I upload" but "is anything wrong, and what
 * do I have to do about it".
 *
 * Seven screens existed and each one was a place you had to already know to look.
 * The pool could sit full for a week, twenty products could be blocking every
 * rep's credit, an account could be locked out, and nothing would say so unless
 * somebody happened to click the right thing.
 *
 * So this page is a LIST OF WORK, not a dashboard. Every card is a thing that is
 * waiting, written as a sentence, with the button that resolves it. When nothing
 * is waiting, it says so plainly instead of showing zeroes in boxes — an empty
 * queue is good news, and good news should look like good news.
 *
 * Each check loads independently. One slow or failing endpoint greys out its own
 * card and leaves the rest of the page usable, because an admin who cannot see
 * the pool should still be able to see that someone is locked out.
 */

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error' };

interface Item {
  /** The headline number. */
  count: number;
  /** What it means, as a sentence. Written for the count it describes. */
  says: string;
  /** Where to go and what the button says there. */
  href: string;
  action: string;
  /** How loudly to shout. */
  tone: 'urgent' | 'attention' | 'calm';
}

export default function Today() {
  const [pool, setPool] = useState<Load<number>>({ state: 'loading' });
  const [untouched, setUntouched] = useState<Load<number>>({ state: 'loading' });
  const [prices, setPrices] = useState<Load<number>>({ state: 'loading' });
  const [credit, setCredit] = useState<Load<number>>({ state: 'loading' });
  const [locked, setLocked] = useState<Load<number>>({ state: 'loading' });
  const [team, setTeam] = useState<Load<number>>({ state: 'loading' });

  const load = useCallback(() => {
    const grab = <T,>(
      path: string,
      pick: (r: never) => number,
      set: (v: Load<number>) => void,
    ) => {
      api
        .get<never>(path)
        .then((r) => set({ state: 'ok', data: pick(r) }))
        .catch(() => set({ state: 'error' }));
    };

    // Each endpoint's own COUNT field, never the length of the array it happens
    // to return. Those arrays are capped pages; reading their length would make
    // this page quietly under-report the moment a cap is hit.
    grab('/assignment/pool', (r: never) => (r as { total: number }).total ?? 0, setPool);
    grab('/leads/followup/untouched', (r: never) => (r as { count: number }).count ?? 0, setUntouched);
    grab('/master/skus', (r: never) => (r as { unconfirmed: number }).unconfirmed ?? 0, setPrices);
    grab('/master/credit/pending', (r: never) => (r as { waiting: number }).waiting ?? 0, setCredit);
    grab('/security/locked', (r: never) => (r as { accounts?: unknown[] }).accounts?.length ?? 0, setLocked);
    grab('/master/roster', (r: never) => {
      const rows = (r as { roster?: unknown[] }).roster ?? (r as unknown as unknown[]);
      return Array.isArray(rows) ? rows.length : 0;
    }, setTeam);
  }, []);

  useEffect(() => { load(); }, [load]);

  const n = (l: Load<number>): number | null => (l.state === 'ok' ? l.data : null);

  const items: Item[] = [
    {
      count: n(locked) ?? 0,
      says: (n(locked) ?? 0) === 1
        ? 'person cannot sign in and is waiting on you'
        : 'people cannot sign in and are waiting on you',
      href: '/security',
      action: 'Review and unlock',
      tone: 'urgent',
    },
    {
      count: n(pool) ?? 0,
      says: 'leads have nobody working them',
      href: '/assignment',
      action: 'Share them out',
      tone: 'urgent',
    },
    {
      count: n(untouched) ?? 0,
      says: 'assigned leads have gone 48 hours untouched — at 72 they go back to the pool',
      href: '/assignment',
      action: 'See who is sitting on them',
      tone: 'attention',
    },
    {
      count: n(prices) ?? 0,
      says: 'products have no confirmed price, so reps earn nothing on them',
      href: '/master',
      action: 'Upload the price list',
      tone: 'attention',
    },
    {
      count: n(credit) ?? 0,
      says: 'orders are waiting for credit that has not been worked out yet',
      href: '/master',
      action: 'Complete their credit',
      tone: 'attention',
    },
  ];

  const checks = [pool, untouched, prices, credit, locked];
  const waiting = items.filter((i) => i.count > 0);
  const stillChecking = checks.some((l) => l.state === 'loading');
  const anyFailed = checks.some((l) => l.state === 'error');
  const pending = checks.filter((l) => l.state === 'loading').length;

  // A CHECK THAT HAS NOT ANSWERED IS NOT A CHECK THAT FOUND NOTHING.
  //
  // The first version dropped any card whose count was zero, and a still-loading
  // check reads as zero. So a slow endpoint made its card vanish, and the page
  // looked calm while nobody knew whether it was. That is the same defect as an
  // empty test passing: absence presented as an answer.
  //
  // "Nothing is waiting" is now only ever said once every check has replied.

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Today</h1>
      <p style={s.sub}>Everything below is waiting on an admin. Nothing else needs you right now.</p>

      {!anyFailed && !stillChecking && waiting.length === 0 && (
        <section style={{ ...s.card, padding: '34px 20px', textAlign: 'center' }}>
          <p style={{ font: '600 18px/1.3 "IBM Plex Sans", sans-serif', margin: '0 0 6px', color: T.vine }}>
            Nothing is waiting.
          </p>
          <p style={{ ...s.sub, margin: 0 }}>
            Every lead has an owner, every price is confirmed and nobody is locked out.
            {n(team) !== null && ` ${n(team)} people on the roster.`}
          </p>
        </section>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {waiting.map((i) => {
          const tone = i.tone === 'urgent' ? T.clay : i.tone === 'attention' ? T.brass : T.indigo;
          return (
            <section
              key={i.href + i.says}
              style={{
                ...s.card,
                borderLeft: `3px solid ${tone}`,
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  ...s.mono,
                  fontSize: 28,
                  fontWeight: 600,
                  color: tone,
                  minWidth: 62,
                  textAlign: 'right',
                }}
              >
                {i.count}
              </span>
              <span style={{ flex: '1 1 320px', fontSize: 14.5 }}>{i.says}</span>
              <Link
                href={i.href}
                style={{ ...s.btnPrimary, textDecoration: 'none', whiteSpace: 'nowrap' }}
              >
                {i.action}
              </Link>
            </section>
          );
        })}
      </div>

      {stillChecking && (
        <p style={{ ...s.sub, margin: '0 0 10px', fontSize: 13 }}>
          Still checking {pending} more {pending === 1 ? 'thing' : 'things'}…
        </p>
      )}

      {anyFailed && (
        <p style={{ ...s.sub, marginTop: 14, color: T.muted, fontSize: 12.5 }}>
          Some checks could not be read just now. Reload the page to try again — the rest of this
          list is still accurate.
        </p>
      )}

      {/* The routine work, separated from the exceptions above. An admin who has
          nothing waiting still comes here to upload the day's files. */}
      <section style={{ ...s.card, marginTop: 22 }}>
        <div style={s.cardHead}>
          <span>Routine</span>
          <span style={{ ...s.sub, margin: 0, fontSize: 12 }}>the things you do every day anyway</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {[
            { href: '/upload', label: 'Upload today’s files' },
            { href: '/orders', label: 'Update dispatch & delivery' },
            { href: '/reports', label: 'Look at the numbers' },
            { href: '/customers', label: 'Find a customer' },
            { href: '/master', label: 'Prices, incentive, roster' },
          ].map((l) => (
            <Link key={l.href} href={l.href} style={{ ...s.btn, textDecoration: 'none' }}>
              {l.label}
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
