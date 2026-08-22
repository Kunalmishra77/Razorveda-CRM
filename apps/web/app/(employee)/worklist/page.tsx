'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * My Day + Worklist (docs/07 §4).
 *
 * The order is fixed and NOT user-sortable. There is deliberately no column
 * header to click: a rep who can sort by value works the big tickets and lets
 * follow-ups rot, which is how 174 of the client's leads sat untouched for a full
 * validity window.
 */

interface WorklistLead {
  leadId: string;
  band: string;
  bandLabel: string;
  fullName: string | null;
  phone: string | null;
  source: string;
  interest: string | null;
  attempts: number;
  disposition: string | null;
  followupAt: string | null;
  lifetimeOrders: number;
}

interface Payload {
  myDay: {
    monthlyTarget: string;
    realisedThisMonth: string;
    dialsToday: number;
    connectsToday: number;
    selfReported: boolean;
  };
  counts: Record<string, number>;
  bands: Array<{ band: string; label: string }>;
  leads: WorklistLead[];
}

const TONE: Record<string, string> = {
  OVERDUE_FOLLOWUP: T.clay,
  DUE_TODAY: T.brass,
  REPEAT_DUE: T.vine,
  FRESH: T.ink,
  AGEING: T.faint,
};

export default function Worklist() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Payload>('/worklist'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace(`/login?reason=${encodeURIComponent(e.message)}`);
        return;
      }
      setError(e instanceof ApiError ? e.message : 'Could not load your worklist.');
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  if (error) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!data) return <main style={s.page}><p style={s.empty}>Loading your day…</p></main>;

  const { myDay, counts, bands, leads } = data;
  const balance = Number(myDay.monthlyTarget) - Number(myDay.realisedThisMonth);

  return (
    <main style={s.page}>
      <h1 style={s.h1}>My day</h1>
      <p style={s.sub}>Work from the top. The order is the plan.</p>

      <section style={s.card} aria-label="My day">
        <div style={{ display: 'flex', gap: 30, flexWrap: 'wrap' }}>
          <Figure label="Target" value={`₹${fmt(myDay.monthlyTarget)}`} />
          {/* Realised, not booked — the only basis for score and incentive. */}
          <Figure label="Realised" value={`₹${fmt(myDay.realisedThisMonth)}`} tone={T.vine} />
          <Figure label="Balance" value={`₹${fmt(String(balance))}`} tone={balance > 0 ? T.clay : T.vine} />
          <Figure label="Dials today *" value={String(myDay.dialsToday)} />
          <Figure label="Connects today *" value={String(myDay.connectsToday)} />
        </div>
        {myDay.selfReported && (
          // docs/04: self-reported columns must be marked so nobody mistakes them
          // for measured values. Reps dial from their own handsets (D-03).
          <p style={{ ...s.sub, margin: '12px 0 0', fontSize: 11.5 }}>
            * Self-reported. You dial from your own handset, so these count what you logged.
          </p>
        )}
      </section>

      <section style={s.card} aria-label="Worklist summary">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {bands.map(({ band, label }) => (
            <span key={band} style={{ ...s.pill('flat'), borderColor: TONE[band], color: TONE[band] }}>
              {label} {counts[band] ?? 0}
            </span>
          ))}
        </div>
      </section>

      <section style={s.card} aria-label="Worklist">
        <div style={s.cardHead}>
          <span>Worklist</span>
          <span style={{ ...s.mono, textTransform: 'none', letterSpacing: 0 }}>
            {leads.length} to work
          </span>
        </div>

        {leads.length === 0 ? (
          <p style={s.empty}>
            No leads assigned yet. Ask your admin to assign some from the pool.
          </p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['', 'Customer', 'Mobile', 'Source', 'Interest', 'Tries', 'Last outcome', ''].map((h, i) => (
                  <th key={i} scope="col" style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.leadId}>
                  <td style={s.td}>
                    {/* Never colour alone — the band always carries its word. */}
                    <span style={{ ...s.pill('flat'), borderColor: TONE[l.band], color: TONE[l.band] }}>
                      {l.bandLabel}
                    </span>
                  </td>
                  <td style={s.td}>
                    {l.fullName ?? <span style={{ color: T.faint }}>Unknown</span>}
                    {l.lifetimeOrders > 0 && (
                      <span style={{ ...s.mono, color: T.vine, fontSize: 11, marginLeft: 6 }}>
                        {l.lifetimeOrders}× buyer
                      </span>
                    )}
                  </td>
                  <td style={{ ...s.td, ...s.mono }}>{l.phone ?? '—'}</td>
                  <td style={s.td}>{l.source}</td>
                  <td style={s.td}>{l.interest ?? '—'}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{l.attempts}</td>
                  <td style={{ ...s.td, color: T.muted }}>{l.disposition ?? '—'}</td>
                  <td style={s.td}>
                    <Link href={`/leads/${l.leadId}`} style={{ ...s.btn, textDecoration: 'none' }}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function Figure({ label, value, tone = T.text }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div style={{ ...s.mono, fontSize: 19, color: tone }}>{value}</div>
      <div style={{ fontSize: 11, color: T.muted, textTransform: 'uppercase', letterSpacing: '1px' }}>
        {label}
      </div>
    </div>
  );
}

const fmt = (v: string): string =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
