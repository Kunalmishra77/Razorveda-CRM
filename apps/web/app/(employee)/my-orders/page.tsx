'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * MY ORDERS — where everything she sold actually got to.
 *
 * A rep books an order and then, until now, never heard about it again. Whether
 * the parcel shipped, arrived, or came back was visible only to an admin — while
 * being the single thing that decides whether she gets paid for it, because
 * credit realises on DELIVERY and a return takes it back (rule 3).
 *
 * She also gets the phone calls. "Where is my order" is asked of the person who
 * sold it, not of the warehouse, and she had nothing to answer with.
 *
 * GROUPED BY WHAT SHE CAN DO ABOUT IT rather than by status code:
 *   came back — the ones that cost her, worth understanding
 *   still going — nothing to do but they are the pipeline
 *   arrived — done, and the only ones that pay
 *
 * She cannot change a status here. Everything from dispatch onward is what the
 * COURIER knows, not what she knows, and letting a rep mark her own order
 * delivered is how a rep pays herself (D-221).
 */

interface OrderRow {
  order_id: string;
  order_number: string;
  current_status: string;
  final_value: string;
  order_date: string | null;
  delivered_date?: string | null;
  customer_name?: string | null;
  primary_phone?: string | null;
  courier_partner?: string | null;
  awb?: string | null;
}

const fmt = (v: string | number): string =>
  Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const DELIVERED = ['DELIVERED'];
const LOST = ['RTO', 'RETURNED', 'CANCELLED'];

/** What each status means to the person who sold it. */
const PLAIN: Record<string, string> = {
  PENDING: 'Booked, not packed yet',
  CONFIRMED: 'Confirmed with the customer',
  PROCESSING: 'Being packed',
  DISPATCHED: 'On its way',
  OUT_FOR_DELIVERY: 'Out for delivery today',
  FAILED_DELIVERY: 'Delivery attempt failed',
  NO_RESPONSE: 'Customer did not answer the courier',
  REFUSED: 'Customer refused the parcel',
  DELIVERED: 'Delivered',
  RTO: 'Came back to the warehouse',
  RETURNED: 'Returned after delivery',
  CANCELLED: 'Cancelled',
};

/** Rows shown per group before the rep asks for the rest. */
const VISIBLE = 10;

const dateOf = (v: string | null | undefined): string =>
  v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';

export default function MyOrders() {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [totals, setTotals] = useState<{ total: number; deliveredValue: string } | null>(null);
  // Which groups the rep has asked to see in full.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ orders: OrderRow[]; totals: { total: number; deliveredValue: string } }>('/orders');
      setOrders(r.orders ?? []);
      setTotals(r.totals);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your orders.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!orders) return <main style={s.page}><p style={s.empty}>Loading your orders…</p></main>;

  const groups = [
    {
      key: 'lost',
      title: 'Came back',
      why: 'These took their credit back with them. Worth reading why — usually the address or the phone number.',
      tone: T.clay,
      rows: orders.filter((o) => LOST.includes(o.current_status)),
    },
    {
      key: 'flight',
      title: 'Still going',
      why: 'Nothing for you to do. If a customer asks where her parcel is, the courier and AWB are here.',
      tone: T.brass,
      rows: orders.filter(
        (o) => !DELIVERED.includes(o.current_status) && !LOST.includes(o.current_status),
      ),
    },
    {
      key: 'done',
      title: 'Arrived',
      why: 'Delivered, and the only ones that count towards your target and incentive.',
      tone: T.vine,
      rows: orders.filter((o) => DELIVERED.includes(o.current_status)),
    },
  ].filter((g) => g.rows.length > 0);

  // The API's own total, not the sum of this page. The list is capped at 200 and
  // adding up what arrived would quietly under-report a busy rep's whole year.
  const deliveredValue = totals?.deliveredValue ?? '0';
  const totalCount = totals?.total ?? orders.length;
  const capped = totalCount > orders.length;

  return (
    <main style={s.page}>
      <h1 style={s.h1}>My orders</h1>
      <p style={s.sub}>
        Everything you have booked, and where it got to. You cannot change a delivery status here —
        that comes from the courier.
      </p>

      {orders.length === 0 ? (
        <section style={{ ...s.card, textAlign: 'center', padding: '34px 20px' }}>
          <p style={{ font: '600 16px/1.3 "IBM Plex Sans", sans-serif', margin: '0 0 6px' }}>
            You have not booked an order yet.
          </p>
          <p style={{ ...s.sub, margin: 0 }}>
            Open a lead from your day list and book one after the call.
          </p>
        </section>
      ) : (
        <>
          <section style={{ ...s.card, marginBottom: 14 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
              <span style={{ ...s.mono, fontSize: 24, fontWeight: 600, color: T.vine }}>
                ₹{fmt(deliveredValue)}
              </span>
              <span style={{ color: T.muted, fontSize: 14 }}>
                has actually arrived, across {totalCount} order{totalCount > 1 ? 's' : ''} you booked
              </span>
              {capped && (
                <span style={{ ...s.sub, margin: 0, fontSize: 12.5, flexBasis: '100%' }}>
                  Showing your {orders.length} most recent below. The figures above cover all of them.
                </span>
              )}
            </div>
          </section>

          {groups.map((g) => (
            <section key={g.key} style={{ marginBottom: 18 }}>
              <p
                style={{
                  font: '600 11px/1 "Barlow Condensed", sans-serif',
                  textTransform: 'uppercase',
                  letterSpacing: '1.6px',
                  color: g.tone,
                  margin: '0 0 4px',
                }}
              >
                {g.title} · {g.rows.length}
              </p>
              <p style={{ ...s.sub, margin: '0 0 8px', fontSize: 12.5 }}>{g.why}</p>

              <div style={{ display: 'grid', gap: 6 }}>
                {/*
                  TEN AT A TIME.
                  The first version rendered every row the API returned — 200 of
                  them, thirteen thousand pixels of identical cards. Exactly the
                  wall this screen was built to replace, rebuilt one page later.
                  Ten is enough to see the shape of a group; the rest are one
                  click away for the rare occasion somebody wants them.
                */}
                {(expanded[g.key] ? g.rows : g.rows.slice(0, VISIBLE)).map((o) => (
                  <div
                    key={o.order_id}
                    style={{
                      ...s.card,
                      padding: '11px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                      flexWrap: 'wrap',
                      borderLeft: `3px solid ${g.tone}`,
                    }}
                  >
                    <span style={{ fontWeight: 500, minWidth: 150 }}>
                      {o.customer_name ?? <span style={{ color: T.faint }}>Customer</span>}
                    </span>
                    <span style={{ ...s.mono, color: T.muted, fontSize: 12.5 }}>{o.order_number}</span>
                    <span style={{ ...s.mono, fontWeight: 500 }}>₹{fmt(o.final_value)}</span>
                    <span style={{ color: T.muted, fontSize: 13 }}>
                      {PLAIN[o.current_status] ?? o.current_status.toLowerCase().replace(/_/g, ' ')}
                    </span>
                    {o.courier_partner && (
                      <span style={{ ...s.mono, color: T.faint, fontSize: 12 }}>
                        {o.courier_partner}
                        {o.awb ? ` · ${o.awb}` : ''}
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto', ...s.mono, color: T.faint, fontSize: 12 }}>
                      booked {dateOf(o.order_date)}
                      {o.delivered_date ? ` · arrived ${dateOf(o.delivered_date)}` : ''}
                    </span>
                  </div>
                ))}

                {g.rows.length > VISIBLE && (
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [g.key]: !e[g.key] }))}
                    style={{ ...s.btn, justifySelf: 'start', marginTop: 2 }}
                  >
                    {expanded[g.key]
                      ? `Show fewer`
                      : `Show all ${g.rows.length} — ${g.rows.length - VISIBLE} more`}
                  </button>
                )}
              </div>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
