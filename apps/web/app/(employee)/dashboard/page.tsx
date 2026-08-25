'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * A REP'S DASHBOARD — today, and everything before today.
 *
 * The client was explicit: this must not show only today. She should be able to
 * see previous assignments, previous completed work, lifetime totals, and daily /
 * weekly / monthly performance without leaving the page.
 *
 * So the page is ordered the way she reads it, not the way the tables are shaped:
 *
 *   1. what is left to do right now
 *   2. what she has done today
 *   3. day / week / month side by side
 *   4. where her leads come from and where her calls go
 *   5. everything she has ever been given
 *
 * One request. Eight endpoints would render in pieces, and a card that has not
 * answered yet looks exactly like a card with nothing in it.
 */

interface Row { [k: string]: string }
interface Payload {
  me: { name: string; monthlyTarget: string };
  today: Row;
  lifetime: Row;
  periods: Record<string, Row>;
  outcomes: { label: string; category: string; n: string }[];
  sources: { source: string; n: string; open: string }[];
  daily: { day: string; calls: string; orders: string }[];
  recent: {
    occurred_at: string; type: string; connected: boolean | null;
    remark_raw: string | null; disposition: string | null; full_name: string | null; lead_id: string;
  }[];
}

const n = (v: string | undefined): number => Number(v ?? '0');
const money = (v: string | number): string =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const TONE: Record<string, string> = {
  POSITIVE: T.vine, NEGATIVE: T.clay, CONNECTED: T.indigo,
  NOT_CONNECTED: T.faint, CLOSED: T.brass,
};

export default function Dashboard() {
  const [d, setD] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api.get<Payload>('/me/dashboard'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your dashboard.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!d) return <main style={s.page}><p style={s.empty}>Loading your dashboard…</p></main>;

  const { today, lifetime, periods } = d;
  const target = n(d.me.monthlyTarget);
  const monthValue = n(periods['month']?.['delivered_value']);
  const pct = target > 0 ? Math.round((monthValue / target) * 100) : 0;

  const connectRate = (p?: Row): string => {
    const c = n(p?.['calls']); return c === 0 ? '—' : `${Math.round((n(p?.['connected']) / c) * 100)}%`;
  };
  /**
   * Conversion %, as docs/03 defines it: DELIVERED orders over LEADS ASSIGNED.
   *
   * The first version divided booked orders by connected calls — arithmetic
   * invented here rather than read from the dictionary, which rule 10 forbids —
   * and it printed 675% for a rep whose orders arrived by import with no calls
   * attached. Two populations that have nothing to do with each other.
   */
  const conversion = (p?: Row): string => {
    const given = n(p?.['assigned']);
    return given === 0 ? '—' : `${Math.round((n(p?.['delivered']) / given) * 100)}%`;
  };

  const maxCalls = Math.max(1, ...d.daily.map((x) => n(x.calls)));

  return (
    <main style={s.page}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ ...s.h1, margin: 0 }}>Dashboard</h1>
        <span style={{ ...s.sub, margin: 0 }}>
          {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
        </span>
        <Link href="/worklist" style={{ ...s.btnPrimary, textDecoration: 'none', marginLeft: 'auto' }}>
          Start calling →
        </Link>
      </div>

      {/* 1 — what is still to do */}
      <Zone title="1 · What is left today" why="The only numbers that change what you do next." />
      <div style={grid4}>
        <Kpi v={n(today['open_total'])} k="Open with you" note="your live pipeline" />
        <Kpi v={n(today['to_call'])} k="To call today"
          note="open, not parked for later"
          tone={n(today['to_call']) > 0 ? T.clay : T.text} />
        <Kpi v={n(today['followups_due'])} k="Follow-ups due today"
          note={n(today['overdue']) > 0 ? `${n(today['overdue'])} already overdue` : 'none overdue'}
          tone={n(today['overdue']) > 0 ? T.clay : T.text} />
        <Kpi v={n(today['pending'])} k="Never called" note="no attempt logged yet" />
        <Kpi v={n(today['repeat_due'])} k="Ready to reorder" note="past buyers, due now" tone={T.vine} />
        <Kpi v={n(today['at_risk'])} k="About to be taken back" note="untouched 48h" tone={T.brass} />
      </div>

      {/* 2 — what she has done today */}
      <Zone title="2 · What you have done today" why="Self-reported — you dial from your own handset." />
      <div style={grid4}>
        <Kpi v={n(today['assigned_today'])} k="Given to you today" note="by an admin" />
        <Kpi v={n(today['worked_today'])} k="Leads worked" />
        <Kpi v={n(today['connected_today'])} k="They answered" note={connectRate(periods['today'])} />
        <Kpi v={n(periods['today']?.['orders'])} k="Orders booked"
          note={`₹${money(periods['today']?.['delivered_value'] ?? 0)} delivered`} tone={T.vine} />
      </div>

      {/* 3 — day / week / month, the comparison the client asked for */}
      <Zone title="3 · Day, week and month" why="The same four habits, over three windows." />
      <div style={{ ...s.card, overflowX: 'auto' }}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th} />
              <th style={{ ...s.th, textAlign: 'right' }}>Today</th>
              <th style={{ ...s.th, textAlign: 'right' }}>This week</th>
              <th style={{ ...s.th, textAlign: 'right' }}>This month</th>
              <th style={{ ...s.th, textAlign: 'right' }}>All time</th>
            </tr>
          </thead>
          <tbody>
            {([
              ['Calls logged', (p?: Row) => String(n(p?.['calls']))],
              ['They answered', (p?: Row) => String(n(p?.['connected']))],
              ['Answer rate', connectRate],
              ['Leads worked', (p?: Row) => String(n(p?.['leads_worked']))],
              ['Orders booked', (p?: Row) => String(n(p?.['orders']))],
              ['Leads given to you', (p?: Row) => String(n(p?.['assigned']))],
              ['Conversion %', conversion],
              ['Delivered value', (p?: Row) => `₹${money(p?.['delivered_value'] ?? 0)}`],
            ] as const).map(([label, fn]) => (
              <tr key={label}>
                <td style={s.td}>{label}</td>
                {(['today', 'week', 'month', 'all'] as const).map((p) => (
                  <td key={p} style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{fn(periods[p])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* month against target */}
      <div style={{ ...s.card, marginTop: 10 }}>
        <div style={s.cardHead}>
          <span>This month against target</span>
          <span style={s.pill(pct >= 100 ? 'ok' : 'flat')}>
            {target === 0 ? 'no target set' : pct >= 100 ? `met · ${pct}%` : `${pct}%`}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <span style={{ ...s.mono, fontSize: 24, fontWeight: 600, color: pct >= 100 ? T.vine : T.text }}>
            ₹{money(monthValue)}
          </span>
          <span style={{ color: T.muted, fontSize: 13 }}>
            delivered{target > 0 ? `, of ₹${money(target)}` : ' this month'}
          </span>
        </div>
        {target > 0 && (
          <div style={{ height: 6, background: T.line2, borderRadius: 3, marginTop: 9, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: pct >= 100 ? T.vine : T.indigo }} />
          </div>
        )}
        <p style={{ ...s.sub, margin: '9px 0 0', fontSize: 12.5 }}>
          Only delivered orders count. A return takes its credit back with it.
        </p>
      </div>

      {/* 4 — where leads come from, where calls go */}
      <Zone title="4 · Where your work comes from, and where it goes" />
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(300px,1fr))' }}>
        <div style={s.card}>
          <div style={s.cardHead}><span>Your leads by source</span><span style={s.pill('flat')}>{d.sources.length} sources</span></div>
          {d.sources.length === 0 ? <p style={s.empty}>Nothing assigned yet.</p> : d.sources.map((r) => (
            <div key={r.source} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
              <span style={{ minWidth: 150, fontSize: 13.5 }}>{r.source}</span>
              <span style={{ ...s.mono, minWidth: 44, textAlign: 'right' }}>{r.n}</span>
              <span style={{ ...s.sub, margin: 0, fontSize: 12 }}>{r.open} open</span>
            </div>
          ))}
        </div>

        <div style={s.card}>
          <div style={s.cardHead}><span>Where your calls went</span><span style={s.pill('flat')}>all time</span></div>
          {d.outcomes.length === 0 ? <p style={s.empty}>No calls logged yet.</p> : d.outcomes.map((o) => {
            const max = Math.max(...d.outcomes.map((x) => n(x.n)));
            return (
              <div key={o.label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                <span style={{ minWidth: 150, fontSize: 13.5 }}>{o.label}</span>
                <span style={{ ...s.mono, minWidth: 44, textAlign: 'right' }}>{o.n}</span>
                <span style={{ flex: 1, height: 6, background: T.line2, borderRadius: 3, overflow: 'hidden' }}>
                  <span style={{
                    display: 'block', height: '100%',
                    width: `${(n(o.n) / max) * 100}%`,
                    background: TONE[o.category] ?? T.faint,
                  }} />
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* last 14 days */}
      <div style={{ ...s.card, marginTop: 10 }}>
        <div style={s.cardHead}><span>Last 14 days</span><span style={s.pill('flat')}>calls per day</span></div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 84, marginTop: 8 }}>
          {d.daily.map((x) => (
            <div key={x.day} style={{ flex: 1, textAlign: 'center' }} title={`${x.day}: ${x.calls} calls, ${x.orders} orders`}>
              <div style={{
                height: `${Math.max(2, (n(x.calls) / maxCalls) * 62)}px`,
                background: n(x.orders) > 0 ? T.vine : T.indigo, borderRadius: 2,
              }} />
              <div style={{ ...s.mono, fontSize: 9, color: T.faint, marginTop: 4 }}>{x.day.slice(0, 2)}</div>
            </div>
          ))}
        </div>
        <p style={{ ...s.sub, margin: '8px 0 0', fontSize: 12 }}>Green means at least one order that day.</p>
      </div>

      {/* 5 — the history the client asked for */}
      <Zone title="5 · Everything you have ever been given" why="Your full history, not just today." />
      <div style={grid4}>
        <Kpi v={n(lifetime['total_assigned'])} k="Leads assigned, ever" />
        <Kpi v={n(lifetime['total_worked'])} k="Leads you worked"
          note={`${n(lifetime['total_calls'])} calls in total`} />
        <Kpi v={n(lifetime['total_orders'])} k="Orders booked"
          note={`${n(lifetime['delivered'])} delivered`} tone={T.vine} />
        <Kpi v={n(lifetime['rto'])} k="Came back" note="RTO or returned"
          tone={n(lifetime['rto']) > 0 ? T.clay : undefined} />
      </div>
      <div style={{ ...s.card, marginTop: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 26 }}>
          <Figure label="Closed leads" value={String(n(lifetime['closed']))} />
          <Figure label="Answer rate, all time" value={connectRate(periods['all'])} />
          <Figure label="Delivered value, all time" value={`₹${money(lifetime['delivered_value'] ?? 0)}`} tone={T.vine} />
        </div>
      </div>

      {/* recent activity */}
      <Zone title="6 · What you did most recently" why="So you can pick up where you left off." />
      <div style={s.card}>
        {d.recent.length === 0 ? <p style={s.empty}>Nothing logged yet.</p> : d.recent.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 11, padding: '6px 0', borderBottom: i < d.recent.length - 1 ? `1px solid ${T.line2}` : 0, flexWrap: 'wrap' }}>
            <span style={{ ...s.mono, color: T.faint, fontSize: 11.5, minWidth: 96 }}>
              {new Date(r.occurred_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
              {' '}
              {new Date(r.occurred_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <Link href={`/leads/${r.lead_id}`} style={{ fontWeight: 500, minWidth: 140, color: T.text }}>
              {r.full_name ?? 'Customer'}
            </Link>
            <span style={{ color: r.connected ? T.vine : T.muted, fontSize: 13, minWidth: 120 }}>
              {r.disposition ?? r.type.toLowerCase()}
            </span>
            {r.remark_raw && (
              <span style={{ color: T.muted, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }}>
                “{r.remark_raw}”
              </span>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

const grid4: React.CSSProperties = {
  display: 'grid', gap: 10,
  gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))',
};

function Zone({ title, why }: { title: string; why?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', margin: '18px 0 7px' }}>
      <h2 style={{ ...s.h1, fontSize: 13, margin: 0 }}>{title}</h2>
      {why && <span style={{ color: T.faint, fontSize: 12.5 }}>{why}</span>}
    </div>
  );
}

function Kpi({ v, k, note, tone }: {
  v: number; k: string;
  // `| undefined` spelled out: the project runs with exactOptionalPropertyTypes,
  // and these are passed as `tone={cond ? T.clay : undefined}`.
  note?: string | undefined; tone?: string | undefined;
}) {
  return (
    <div style={s.kpiCard}>
      <div style={{ ...s.kpiValue, color: tone ?? T.text }}>{v}</div>
      <div style={s.kpiLabel}>{k}</div>
      {note && <div style={s.kpiNote}>{note}</div>}
    </div>
  );
}

function Figure({ label, value, tone }: {
  label: string; value: string; tone?: string | undefined;
}) {
  return (
    <div>
      <div style={{ ...s.mono, fontSize: 20, fontWeight: 600, color: tone ?? T.text }}>{value}</div>
      <div style={{ font: '600 10.5px/1 var(--font-display), "Barlow Condensed", sans-serif', textTransform: 'uppercase', letterSpacing: '1.2px', color: T.muted, marginTop: 4 }}>{label}</div>
    </div>
  );
}
