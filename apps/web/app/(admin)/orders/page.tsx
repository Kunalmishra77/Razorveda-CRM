'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T, statusTone } from '../../../lib/ui';

/**
 * Orders & RTO (docs/07 §5).
 *
 * The screen that makes credit actually realise.
 *
 * Credit is earned on delivery, not on booking (rule 3) — so until an order is
 * marked delivered, every rep's realised value is zero and every incentive
 * statement is empty. That transition existed only as an API call, which meant
 * the money side of this system had no way to complete outside curl.
 *
 * WHAT A REP CANNOT DO HERE, AND WHY THE BUTTONS COME FROM THE SERVER.
 *
 * A rep could previously walk her own order to DELIVERED in six requests and
 * realise her own credit — no admin, no courier, no parcel. Fixed in the API, and
 * the fix is why `available` is computed server-side per caller: the screen shows
 * the transitions this person may actually make. It cannot offer a button the API
 * will refuse, or hide one it would allow.
 */

interface Order {
  order_id: string;
  order_number: string;
  order_date: string;
  current_status: string;
  customer: string | null;
  primary_phone: string | null;
  rep: string | null;
  source: string;
  final_value: string;
  company_base_value: string;
  payment_mode: string;
  prepaid_amount: string;
  cod_amount: string;
  ship_state: string | null;
  awb_number: string | null;
  courier_partner: string | null;
  last_moved: string | null;
  realised_credit: string;
  available: string[];
}

const STATUSES = [
  'PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'IN_TRANSIT', 'OFD',
  'DELIVERED', 'FAILED_DELIVERY', 'NO_RESPONSE', 'REFUSED', 'RTO', 'RETURNED', 'CANCELLED',
] as const;

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const q = status ? `?status=${status}` : '';
      setOrders((await api.get<{ orders: Order[] }>(`/orders${q}`)).orders);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Orders could not be loaded.');
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  async function move(order: Order, to: string) {
    setBusy(order.order_id);
    setError(null);
    setNote(null);
    try {
      const r = await api.post<{ ledgerEffect: string; creditWritten: string; repeatDueOn: string | null }>(
        `/orders/${order.order_id}/status`, { to, source: 'MANUAL' },
      );
      setNote(describe(order, to, r));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That order could not be moved.');
    } finally {
      setBusy(null);
    }
  }

  const delivered = orders.filter((o) => o.current_status === 'DELIVERED').length;
  const returned = orders.filter((o) => o.current_status === 'RTO' || o.current_status === 'RETURNED').length;
  const shipped = delivered + returned;

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Orders &amp; RTO</h1>
      <p style={s.lede}>
        Credit is earned on delivery, not on booking. Marking an order delivered is what pays the
        rep; marking a delivered order returned takes it back.
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}

      <section style={s.card}>
        <div style={s.cardHead}>
          <span>
            {orders.length} order{orders.length === 1 ? '' : 's'}
            {shipped > 0 && (
              <span style={{ color: T.muted, fontWeight: 400, marginLeft: 10 }}>
                RTO {((returned / shipped) * 100).toFixed(1)}% of {shipped} shipped
              </span>
            )}
          </span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...s.input, width: 190 }}>
            <option value="">Every status</option>
            {STATUSES.map((st) => <option key={st} value={st}>{human(st)}</option>)}
          </select>
        </div>

        {orders.length === 0 ? (
          <p style={s.empty}>No orders match.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>{['Order', 'Customer', 'Rep', 'Value', 'Payment', 'Status', 'Realised', 'Move to'].map((h) => (
                  <th key={h} scope="col" style={s.th}>{h}</th>))}</tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.order_id}>
                    <td style={s.td}>
                      <span style={s.mono}>{o.order_number}</span>
                      <span style={{ display: 'block', color: T.muted, fontSize: 11 }}>
                        {String(o.order_date).slice(0, 10)} · {o.source}
                      </span>
                    </td>
                    <td style={s.td}>
                      {o.customer ?? '—'}
                      {o.ship_state && (
                        <span style={{ display: 'block', color: T.muted, fontSize: 11 }}>{o.ship_state}</span>
                      )}
                    </td>
                    <td style={s.td}>{o.rep ?? '—'}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                      ₹{money(o.final_value)}
                      {Number(o.company_base_value) > 0 && (
                        <span style={{ display: 'block', color: T.muted, fontSize: 11 }}>
                          base ₹{money(o.company_base_value)}
                        </span>
                      )}
                    </td>
                    <td style={s.td}>
                      <span style={s.pill('flat')}>{human(o.payment_mode)}</span>
                      {o.payment_mode === 'PARTIAL_PREPAID' && (
                        <span style={{ display: 'block', ...s.mono, color: T.muted, fontSize: 11 }}>
                          ₹{money(o.prepaid_amount)} + ₹{money(o.cod_amount)}
                        </span>
                      )}
                    </td>
                    <td style={s.td}>
                      <span style={s.pill(statusTone(o.current_status))}>{human(o.current_status)}</span>
                      {stale(o) && (
                        <span style={{ display: 'block', color: T.brass, fontSize: 11, marginTop: 3 }}>
                          no movement for {days(o.last_moved)} days
                        </span>
                      )}
                    </td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                      {Number(o.realised_credit) === 0
                        ? <span style={{ color: T.muted }}>—</span>
                        : <span style={{ color: Number(o.realised_credit) > 0 ? T.vine : T.clay }}>
                            ₹{money(o.realised_credit)}
                          </span>}
                    </td>
                    <td style={s.td}>
                      {o.available.length === 0 ? (
                        <span style={{ color: T.muted, fontSize: 12 }}>
                          {['RTO', 'RETURNED', 'CANCELLED'].includes(o.current_status) ? 'final' : 'nothing you can do'}
                        </span>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {o.available.map((to) => (
                            <button
                              key={to} type="button"
                              disabled={busy === o.order_id}
                              onClick={() => void move(o, to)}
                              // Delivery pays; a return takes it back. Both are
                              // marked so nobody clicks one thinking it is routine.
                              style={to === 'DELIVERED' ? s.btnPrimary
                                : ['RTO', 'RETURNED'].includes(to) ? { ...s.btn, borderColor: T.clay, color: T.clay }
                                : s.btn}
                              title={hint(o, to)}
                            >
                              {human(to)}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={s.hint}>
          Dispatch and delivery are courier facts. A rep can confirm an order with the customer or
          cancel it; she cannot mark her own order delivered, because that is the transition that
          pays her.
        </p>
      </section>
    </main>
  );
}

const money = (v: string): string =>
  Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const human = (v: string): string =>
  v.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const days = (iso: string | null): number =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : 0;

/** Stuck: not finished, and nothing has happened for a week. */
const stale = (o: Order): boolean =>
  !['DELIVERED', 'RTO', 'RETURNED', 'CANCELLED'].includes(o.current_status) && days(o.last_moved) > 7;

function hint(o: Order, to: string): string {
  if (to === 'DELIVERED') return `Pays ${o.rep ?? 'the rep'} — this is what realises her credit.`;
  if (to === 'RTO' || to === 'RETURNED') {
    return o.current_status === 'DELIVERED'
      ? 'Claws back the credit this order already paid.'
      : 'This order never delivered, so there is no credit to claw back.';
  }
  return `Move to ${human(to)}.`;
}

function describe(
  order: Order,
  to: string,
  result: { ledgerEffect: string; creditWritten: string; repeatDueOn: string | null },
): string {
  const who = order.rep ?? 'the rep';
  if (result.ledgerEffect === 'REALISED_CREDIT') {
    return (
      `${order.order_number} delivered. ₹${money(result.creditWritten)} realised for ${who}.` +
      (result.repeatDueOn ? ` She is due to reorder around ${result.repeatDueOn}.` : '')
    );
  }
  if (result.ledgerEffect === 'CLAWBACK') {
    return `${order.order_number} returned. ₹${money(result.creditWritten)} clawed back from ${who} — this order now nets to zero.`;
  }
  return `${order.order_number} moved to ${human(to)}. No change to anyone's credit.`;
}
