'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError } from '../../../../lib/api';
import { s, T } from '../../../../lib/ui';

/**
 * ONE REP, SEEN BY AN ADMIN.
 *
 * The figures are the SAME ONES SHE SEES. Not recomputed for this screen —
 * `rep-metrics.sql.ts` on the API is the single definition and both endpoints
 * read it (CLAUDE.md rule 10). If an admin and a rep could disagree about how
 * many calls she made this week, the conversation that follows is about the
 * software instead of the work, and neither number is trusted again.
 *
 * Two things here that her own dashboard does not have, because they are an
 * admin's business and not hers:
 *
 *   MOVEMENTS   every transfer in or out, with the reason someone typed. This is
 *               the answer to "why is this on Nikita's list?" and to its more
 *               pointed cousin, "who took my lead?".
 *   THE ROSTER  status, target, cap, joining date — the facts that decide what
 *               she is measured against.
 *
 * What is NOT here: any way to edit her numbers. Targets live in Master Data
 * behind the owner-only rule, and nothing on an admin screen should be able to
 * change what a person is paid on.
 */

interface Row { [k: string]: string }
interface Payload {
  rep: {
    employee_id: string; emp_code: string; full_name: string; status: string;
    monthly_target: string; wip_cap: number; joined_on: string | null; email: string;
  };
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
  movements: {
    assigned_at: string; method: string; reason: string | null;
    from_rep: string | null; to_rep: string | null; customer: string | null;
  }[];
}

const n = (v: string | undefined): number => Number(v ?? '0');
const money = (v: string | number): string =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const TONE: Record<string, string> = {
  POSITIVE: T.vine, NEGATIVE: T.clay, CONNECTED: T.indigo,
  NOT_CONNECTED: T.faint, CLOSED: T.brass,
};

const dt = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export default function TeamMember() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await api.get<Payload>(`/team/${id}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load that rep.');
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!d) return <main style={s.page}><p style={s.empty}>Loading…</p></main>;

  const { rep, today, lifetime, periods } = d;
  const target = n(rep.monthly_target);
  const monthValue = n(periods['month']?.['delivered_value']);
  const pct = target > 0 ? Math.round((monthValue / target) * 100) : null;

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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ ...s.h1, margin: 0 }}>{rep.full_name}</h1>
        <span style={{ ...s.mono, color: T.faint, fontSize: 12 }}>{rep.emp_code}</span>
        {rep.status !== 'ACTIVE' && (
          <span style={s.pill('warn')}>{rep.status.toLowerCase().replace('_', ' ')}</span>
        )}
        <Link href="/team" style={{ ...s.sub, margin: 0, color: T.muted, marginLeft: 'auto' }}>
          ← Team
        </Link>
      </div>
      <p style={s.sub}>
        {rep.email}
        {rep.joined_on ? ` · joined ${new Date(rep.joined_on).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}` : ''}
        {` · cap ${rep.wip_cap} open leads`}
      </p>

      {/* what she is holding right now */}
      <Zone title="What she is holding" />
      <div style={grid}>
        <Kpi v={n(today['open_total'])} k="Open leads" note="her live pipeline" />
        <Kpi v={n(today['to_call'])} k="To call today" note="not parked for later" />
        <Kpi v={n(today['pending'])} k="Never called" note="not started yet" />
        <Kpi v={n(today['at_risk'])} k="Untouched 48h"
          note="back to the pool at 72" tone={n(today['at_risk']) > 0 ? T.clay : undefined} />
        <Kpi v={n(today['overdue'])} k="Overdue follow-ups"
          note="she promised a call back" tone={n(today['overdue']) > 0 ? T.brass : undefined} />
        <Kpi v={n(today['repeat_due'])} k="Ready to reorder" note="past buyers, due now" tone={T.vine} />
      </div>
      <p style={{ ...s.sub, margin: '8px 0 0', fontSize: 12.5 }}>
        Need to rebalance?{' '}
        <Link href="/assignment" style={{ color: T.indigo }}>Move her work</Link>.
      </p>

      {/* today, week, month, all time — the same table she sees */}
      <Zone title="Day, week and month" why="The same figures she sees on her own dashboard." />
      <div style={{ ...s.card, overflowX: 'auto' }}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th} />
              {['Today', 'This week', 'This month', 'All time'].map((h) => (
                <th key={h} style={{ ...s.th, textAlign: 'right' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {([
              ['Calls logged', (p?: Row) => String(n(p?.['calls']))],
              ['They answered', (p?: Row) => String(n(p?.['connected']))],
              ['Answer rate', connectRate],
              ['Leads worked', (p?: Row) => String(n(p?.['leads_worked']))],
              ['Orders booked', (p?: Row) => String(n(p?.['orders']))],
              ['Leads given to her', (p?: Row) => String(n(p?.['assigned']))],
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

      <div style={{ ...s.card, marginTop: 10 }}>
        <div style={s.cardHead}>
          <span>This month against target</span>
          <span style={s.pill(pct !== null && pct >= 100 ? 'ok' : 'flat')}>
            {pct === null ? 'no target set' : pct >= 100 ? `met · ${pct}%` : `${pct}%`}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <span style={{ ...s.mono, fontSize: 24, fontWeight: 600, color: pct !== null && pct >= 100 ? T.vine : T.text }}>
            ₹{money(monthValue)}
          </span>
          <span style={{ color: T.muted, fontSize: 13 }}>
            delivered{target > 0 ? `, of ₹${money(target)}` : ' this month'}
          </span>
        </div>
        {target > 0 && pct !== null && (
          <div style={{ height: 6, background: T.line2, borderRadius: 3, marginTop: 9, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: pct >= 100 ? T.vine : T.indigo }} />
          </div>
        )}
        <p style={{ ...s.sub, margin: '9px 0 0', fontSize: 12.5 }}>
          Delivered only. A return takes its credit back with it. Targets are set in{' '}
          <Link href="/master" style={{ color: T.indigo }}>Master Data</Link>.
        </p>
      </div>

      {/* where her work comes from and where it goes */}
      <Zone title="Where her work comes from, and where it goes" />
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(300px,1fr))' }}>
        <div style={s.card}>
          <div style={s.cardHead}><span>Her leads by source</span><span style={s.pill('flat')}>{d.sources.length}</span></div>
          {d.sources.length === 0 ? <p style={s.empty}>Nothing assigned yet.</p> : d.sources.map((r) => (
            <div key={r.source} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
              <span style={{ minWidth: 150, fontSize: 13.5 }}>{r.source}</span>
              <span style={{ ...s.mono, minWidth: 44, textAlign: 'right' }}>{r.n}</span>
              <span style={{ ...s.sub, margin: 0, fontSize: 12 }}>{r.open} open</span>
            </div>
          ))}
        </div>
        <div style={s.card}>
          <div style={s.cardHead}><span>Where her calls went</span><span style={s.pill('flat')}>all time</span></div>
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

      {/* lifetime */}
      <Zone title="Everything she has ever been given" />
      <div style={grid}>
        <Kpi v={n(lifetime['total_assigned'])} k="Leads assigned, ever" />
        <Kpi v={n(lifetime['total_worked'])} k="Leads worked" note={`${n(lifetime['total_calls'])} calls`} />
        <Kpi v={n(lifetime['total_orders'])} k="Orders booked"
          note={`${n(lifetime['delivered'])} delivered`} tone={T.vine} />
        <Kpi v={n(lifetime['rto'])} k="Came back" note="RTO or returned"
          tone={n(lifetime['rto']) > 0 ? T.clay : undefined} />
        <Kpi v={n(lifetime['closed'])} k="Closed leads" />
      </div>

      {/* movements — the transfer trail */}
      <Zone title="Work moved in or out"
        why="Every transfer, with the reason somebody typed at the time." />
      <div style={s.card}>
        {d.movements.length === 0 ? (
          <p style={s.empty}>Nothing has been moved to or from her.</p>
        ) : (
          d.movements.map((m, i) => (
            <div key={i} style={{
              padding: '7px 0',
              borderBottom: i < d.movements.length - 1 ? `1px solid ${T.line2}` : 0,
            }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
                <span style={{ ...s.mono, color: T.faint, fontSize: 11.5, minWidth: 96 }}>
                  {dt(m.assigned_at)}
                </span>
                <span>
                  {m.customer ?? 'a lead'}
                  {' — '}
                  <strong>{m.from_rep ?? 'the pool'}</strong>
                  {' → '}
                  <strong>{m.to_rep ?? 'the pool'}</strong>
                </span>
                <span style={s.pill(m.method === 'RECALL' ? 'warn' : 'flat')}>
                  {m.method.toLowerCase()}
                </span>
              </div>
              {m.reason && (
                <div style={{ color: T.muted, fontSize: 12.5, marginTop: 2, marginLeft: 106 }}>
                  “{m.reason}”
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* recent activity */}
      <Zone title="What she did most recently" />
      <div style={s.card}>
        {d.recent.length === 0 ? <p style={s.empty}>Nothing logged yet.</p> : d.recent.map((r, i) => (
          <div key={i} style={{
            display: 'flex', gap: 11, padding: '6px 0', flexWrap: 'wrap',
            borderBottom: i < d.recent.length - 1 ? `1px solid ${T.line2}` : 0,
          }}>
            <span style={{ ...s.mono, color: T.faint, fontSize: 11.5, minWidth: 96 }}>
              {dt(r.occurred_at)}
            </span>
            <span style={{ minWidth: 150 }}>{r.full_name ?? 'Customer'}</span>
            <span style={{ color: r.connected ? T.vine : T.muted, fontSize: 13, minWidth: 120 }}>
              {r.disposition ?? r.type.toLowerCase()}
            </span>
            {r.remark_raw && (
              <span style={{
                color: T.muted, fontSize: 13, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340,
              }}>
                “{r.remark_raw}”
              </span>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}

const grid: React.CSSProperties = {
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
  note?: string | undefined; tone?: string | undefined;
}) {
  return (
    <div style={s.card}>
      <div style={{ ...s.mono, fontSize: 24, fontWeight: 600, lineHeight: 1, color: tone ?? T.text }}>{v}</div>
      <div style={{
        font: '600 10.5px/1 "Barlow Condensed", sans-serif', textTransform: 'uppercase',
        letterSpacing: '1.2px', color: T.muted, marginTop: 5,
      }}>{k}</div>
      {note && <div style={{ color: T.faint, fontSize: 11.5, marginTop: 2 }}>{note}</div>}
    </div>
  );
}
