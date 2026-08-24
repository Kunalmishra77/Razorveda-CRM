'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * HOW AM I DOING — a rep's own numbers, and only the ones that are true.
 *
 * WHAT IS DELIBERATELY NOT HERE: the incentive figure.
 *
 * `IncentiveController` is admin-only and the reason is written on it: the slabs
 * in the system are the proposals from docs/03 §6, not the client's confirmed
 * scheme (O-09 is still open, and the client is checking with HR). A rep shown a
 * rupee figure would read it as a promise, and the first month it changed she
 * would be right to feel misled. Showing her an invented number is worse than
 * showing her none.
 *
 * So this page shows only facts the ledger and the activity log already hold:
 * what she delivered, what she booked, what came back, how many calls she made.
 * The moment the real scheme is entered, the earnings section here becomes
 * honest and can be turned on.
 *
 * Everything is scoped by RLS, not by a filter written here. She sees her own
 * rows because the database refuses to hand her anyone else's.
 */

/**
 * The COUNTS come from the API's own totals, never from the array.
 *
 * The first version added up the orders it received and labelled the result
 * "all time" — and the list is capped at 200, so a rep with thousands of orders
 * was shown a lifetime delivered figure SMALLER than her own current month. The
 * page contradicted itself on screen.
 */
interface OrderTotals {
  total: number;
  delivered: number;
  deliveredValue: string;
  lost: number;
  inFlight: number;
}

interface WorklistPayload {
  myDay: {
    monthlyTarget: string;
    realisedThisMonth: string;
    dialsToday: number;
    connectsToday: number;
    selfReported: boolean;
  };
  counts: Record<string, number>;
}

const fmt = (v: string | number): string =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function HowAmIDoing() {
  const [day, setDay] = useState<WorklistPayload | null>(null);
  const [totals, setTotals] = useState<OrderTotals | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, o] = await Promise.all([
        api.get<WorklistPayload>('/worklist'),
        api.get<{ totals: OrderTotals }>('/orders'),
      ]);
      setDay(d);
      setTotals(o.totals);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your numbers.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!day || !totals) return <main style={s.page}><p style={s.empty}>Working out your numbers…</p></main>;

  const target = Number(day.myDay.monthlyTarget);
  const realised = Number(day.myDay.realisedThisMonth);
  const pct = target > 0 ? Math.round((realised / target) * 100) : 0;

  // Of the orders that have finished one way or the other, how many arrived.
  const settled = totals.delivered + totals.lost;
  const deliveryRate = settled > 0 ? Math.round((totals.delivered / settled) * 100) : null;

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Performance</h1>
      <p style={s.sub}>Your own numbers. Nobody else can see this page as you, and you cannot see theirs.</p>

      {/* This month, against target — the number she is measured on. */}
      <section style={{ ...s.card, marginBottom: 14 }}>
        <div style={s.cardHead}>
          <span>This month</span>
          <span style={s.pill(pct >= 100 ? 'ok' : 'flat')}>
            {pct >= 100 ? `target met · ${pct}%` : `${pct}% of target`}
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 34, marginTop: 12 }}>
          <Figure
            label="Delivered this month"
            value={`₹${fmt(realised)}`}
            note="Only delivered orders count"
            tone={pct >= 100 ? T.vine : T.text}
          />
          <Figure label="Your target" value={`₹${fmt(target)}`} note="Set by the owner" />
          <Figure
            label="Calls logged today"
            value={String(day.myDay.dialsToday)}
            note={day.myDay.selfReported ? 'You log these yourself' : undefined}
          />
          <Figure
            label="Connected today"
            value={String(day.myDay.connectsToday)}
            note="Someone actually answered"
          />
        </div>
      </section>

      {/* Everything she has ever booked, by where it ended up. */}
      <section style={{ ...s.card, marginBottom: 14 }}>
        <div style={s.cardHead}>
          <span>Your orders, all time</span>
          <span style={{ ...s.sub, margin: 0, fontSize: 12 }}>{totals.total} in total</span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 34, marginTop: 12 }}>
          <Figure
            label="Delivered"
            value={String(totals.delivered)}
            note={`₹${fmt(totals.deliveredValue)} arrived`}
            tone={T.vine}
          />
          <Figure label="Still on the way" value={String(totals.inFlight)} note="Booked, not yet delivered" />
          <Figure
            label="Came back"
            value={String(totals.lost)}
            note="Returned, RTO or cancelled"
            tone={totals.lost > 0 ? T.clay : undefined}
          />
          {deliveryRate !== null && (
            <Figure
              label="Of those that finished"
              value={`${deliveryRate}%`}
              note="arrived at the customer"
              tone={deliveryRate >= 70 ? T.vine : T.brass}
            />
          )}
        </div>

        <p style={{ ...s.sub, margin: '12px 0 0', fontSize: 12.5 }}>
          A returned order takes its credit back with it, so a high delivery rate is worth more than
          a high booking count. Getting the address and the phone number right is most of it.
        </p>
      </section>

      {/* Day by day, week by week, month by month — the client's own words. */}
      <Breakdown />

      {/* The honest gap, stated rather than hidden behind an empty panel. */}
      <section style={s.card}>
        <div style={s.cardHead}><span>Your incentive</span></div>
        <p style={{ margin: '10px 0 0', fontSize: 14 }}>
          Not shown yet — and that is on purpose.
        </p>
        <p style={{ ...s.sub, margin: '6px 0 0' }}>
          The incentive scheme has not been confirmed with HR, so any figure this page could show
          you today would be one the system invented. You would read it as a promise, and it would
          change. Once the real slabs are entered, your statement appears here.
        </p>
        <p style={{ ...s.sub, margin: '6px 0 0' }}>
          What is already true is above: incentive is worked out from delivered value, so the
          number that matters is the one at the top of this page.
        </p>
      </section>
    </main>
  );
}

/* ── the work history, at three zoom levels ─────────────────────────────────
 *
 * One endpoint, one grain parameter. A rep asking "how was last week" and an
 * admin asking "how was July" are the same question at different resolutions,
 * and giving them separate code paths is how two screens end up disagreeing
 * about what a call was.
 *
 * Empty periods are rendered as zeros rather than dropped. A missing Tuesday in
 * a list of days reads as "we lost your Tuesday"; a Tuesday showing 0 reads as
 * "you made no calls", which is the true and much less alarming claim.
 */

interface Bucket {
  bucket: string; calls: string; connected: string; leads_worked: string;
  assigned: string; orders: string; delivered: string; delivered_value: string;
}

const GRAINS = [
  { key: 'day', label: 'Day by day', note: 'last 30 days' },
  { key: 'week', label: 'Week by week', note: 'last 12 weeks' },
  { key: 'month', label: 'Month by month', note: 'last 12 months' },
] as const;

function Breakdown() {
  const [grain, setGrain] = useState<'day' | 'week' | 'month'>('day');
  const [rows, setRows] = useState<Bucket[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setErr(null);
    api.get<{ rows: Bucket[] }>(`/me/performance?grain=${grain}`)
      .then((r) => { if (live) setRows(r.rows); })
      .catch((e) => { if (live) setErr(e instanceof ApiError ? e.message : 'Could not load your history.'); });
    return () => { live = false; };
  }, [grain]);

  const meta = GRAINS.find((g) => g.key === grain)!;
  const label = (b: string): string => {
    const d = new Date(`${b}T00:00:00`);
    if (grain === 'month') return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    if (grain === 'week') return `Week of ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  return (
    <section style={{ ...s.card, marginBottom: 14 }}>
      <div style={s.cardHead}>
        <span>Your work history</span>
        <span style={{ ...s.sub, margin: 0, fontSize: 12 }}>{meta.note}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 4px' }}>
        {GRAINS.map((g) => {
          const on = g.key === grain;
          return (
            <button
              key={g.key} type="button" onClick={() => setGrain(g.key)} aria-pressed={on}
              style={{
                font: '500 13px/1 inherit', padding: '8px 12px', borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${on ? T.text : T.line}`,
                background: on ? T.text : T.card, color: on ? '#fff' : T.text,
              }}
            >
              {g.label}
            </button>
          );
        })}
      </div>

      {err && <div role="alert" style={s.notice('bad')}>{err}</div>}
      {!rows && !err && <p style={s.empty}>Loading your history…</p>}

      {rows && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>{grain === 'day' ? 'Day' : grain === 'week' ? 'Week' : 'Month'}</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Given to you</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Calls</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Answered</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Leads worked</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Orders</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Delivered</th>
                <th style={{ ...s.th, textAlign: 'right' }}>Delivered value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const quiet = Number(r.calls) === 0 && Number(r.orders) === 0 && Number(r.assigned) === 0;
                return (
                  <tr key={r.bucket} style={quiet ? { color: T.faint } : undefined}>
                    <td style={s.td}>{label(r.bucket)}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.assigned}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.calls}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.connected}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.leads_worked}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{r.orders}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right', color: Number(r.delivered) > 0 ? T.vine : undefined }}>
                      {r.delivered}
                    </td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                      {Number(r.delivered_value) > 0 ? `₹${fmt(r.delivered_value)}` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ ...s.sub, margin: '10px 0 0', fontSize: 12.5 }}>
        Delivered counts orders that actually arrived. A row can show more delivered than booked:
        an order booked last month and delivered this one lands in this month.
      </p>
    </section>
  );
}

function Figure({
  label, value, note, tone,
}: { label: string; value: string; note?: string | undefined; tone?: string | undefined }) {
  return (
    <div>
      <div style={{ ...s.mono, fontSize: 24, fontWeight: 600, color: tone ?? T.text }}>{value}</div>
      <div
        style={{
          font: '600 11px/1 "Barlow Condensed", sans-serif',
          textTransform: 'uppercase',
          letterSpacing: '1.3px',
          color: T.muted,
          marginTop: 4,
        }}
      >
        {label}
      </div>
      {note && <div style={{ color: T.faint, fontSize: 12, marginTop: 3 }}>{note}</div>}
    </div>
  );
}
