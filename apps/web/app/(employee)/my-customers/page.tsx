'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * MY CUSTOMERS — the people, not the leads.
 *
 * The worklist answers "who do I ring today". This answers the other question a
 * rep asks constantly and had no way to ask before: *"someone is calling me —
 * who is she, and what did she buy?"*
 *
 * Her phone rings with a number she half recognises. Until now the only way to
 * find that person was to scroll her worklist hoping the lead was still open, and
 * a customer who has already bought is not on a worklist at all.
 *
 * SEARCH IS THE PAGE, not a filter on it. That is what she actually does.
 * Searching by the last few digits works because that is what a missed-call
 * screen shows her.
 *
 * She sees her own customers because `customer_isolation` decides per row — the
 * ones she has a lead for, or owns after a delivery. There is no filter written
 * here to forget.
 */

interface CustomerRow {
  customer_id: string;
  full_name: string | null;
  primary_phone: string | null;
  city: string | null;
  state: string | null;
  lifetime_orders: number;
  lifetime_value: string | null;
  stage: string | null;
  next_due_date: string | null;
  do_not_call?: boolean;
}

const fmt = (v: string | null): string =>
  Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

const spaced = (phone: string | null): string =>
  phone && phone.length === 10 ? `${phone.slice(0, 5)} ${phone.slice(5)}` : (phone ?? '—');

export default function MyCustomers() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const search = useCallback(async (term: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<{ customers?: CustomerRow[]; message?: string | null }>(
        `/customers?q=${encodeURIComponent(term)}`,
      );
      setRows(r.customers ?? []);
      // The API explains itself — "type at least three characters" — and the first
      // version threw that away and rendered "No customers yet" instead, which is
      // a different claim and an untrue one.
      setHint(r.message ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That search did not work.');
      setRows(null);
    } finally {
      setBusy(false);
    }
  }, []);

  // Load once with an empty term so the page is not blank on arrival.
  useEffect(() => { void search(''); }, [search]);

  const due = (rows ?? []).filter((c) => c.next_due_date !== null);

  return (
    <main style={s.page}>
      <h1 style={s.h1}>My customers</h1>
      <p style={s.sub}>
        Everyone you have spoken to or sold to. Search by name or by the last few digits of a number.
      </p>

      <section style={{ ...s.card, marginBottom: 14 }}>
        <form
          onSubmit={(e) => { e.preventDefault(); void search(q); }}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          <label htmlFor="q" style={s.srOnly}>Search your customers</label>
          <input
            id="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, or the last 4 digits — e.g. 2480"
            style={{ ...s.input, flex: '1 1 300px' }}
          />
          <button type="submit" disabled={busy} style={busy ? s.btnDisabled : s.btnPrimary}>
            {busy ? 'Looking…' : 'Search'}
          </button>
        </form>

        {due.length > 0 && (
          <p style={{ ...s.sub, margin: '10px 0 0', fontSize: 13, color: T.vine }}>
            {due.length} of these should be running out soon — they are on your day list too.
          </p>
        )}
      </section>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}

      {rows === null && !error && <p style={s.empty}>Loading…</p>}

      {rows !== null && rows.length === 0 && (
        <section style={{ ...s.card, textAlign: 'center', padding: '32px 20px' }}>
          <p style={{ font: '600 16px/1.3 var(--font-sans), "IBM Plex Sans", sans-serif', margin: '0 0 6px' }}>
            {hint ?? (q ? `Nobody of yours matches “${q}”.` : 'No customers yet.')}
          </p>
          <p style={{ ...s.sub, margin: 0 }}>
            {q
              ? 'If she is a new caller she may not be assigned to you yet. Ask an admin to check.'
              : 'Once you speak to someone from your day list, she appears here.'}
          </p>
        </section>
      )}

      {rows !== null && rows.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((c) => (
            /*
              EXPANDS IN PLACE rather than navigating.
              There is no customer-detail route for a rep — Customer 360 lives
              under the admin shell — and inventing a navigation would be the
              wrong answer anyway. She is on the phone. Losing her search results
              to look up one order history, then having to search again for the
              next call, is worse than an accordion.
            */
            <div
              key={c.customer_id}
              style={{
                ...s.card,
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                flexWrap: 'wrap',
                color: T.text,
                borderLeft: `3px solid ${c.lifetime_orders > 0 ? T.vine : T.line}`,
              }}
            >
              <span style={{ fontWeight: 500, minWidth: 170 }}>
                {c.full_name ?? <span style={{ color: T.faint }}>Name not recorded</span>}
              </span>
              <span style={{ ...s.mono, color: T.muted }}>{spaced(c.primary_phone)}</span>
              {(c.city || c.state) && (
                <span style={{ color: T.faint, fontSize: 13 }}>
                  {[c.city, c.state].filter(Boolean).join(', ')}
                </span>
              )}

              {c.lifetime_orders > 0 ? (
                <span style={{ ...s.pill('ok'), fontSize: 10 }}>
                  {c.lifetime_orders}× · ₹{fmt(c.lifetime_value)}
                </span>
              ) : (
                <span style={{ ...s.pill('flat'), fontSize: 10 }}>not bought yet</span>
              )}

              {c.next_due_date && (
                <span style={{ ...s.pill('ok'), fontSize: 10 }}>due to reorder</span>
              )}
              {c.do_not_call && (
                // Not a soft warning. She has asked not to be contacted.
                <span style={{ ...s.pill('bad'), fontSize: 10 }}>do not call</span>
              )}

              <button
                type="button"
                onClick={() => setOpen(open === c.customer_id ? null : c.customer_id)}
                aria-expanded={open === c.customer_id}
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: 0,
                  color: T.indigo,
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                {open === c.customer_id ? 'Hide history' : 'Her history'}
              </button>

              {open === c.customer_id && (
                <div style={{ flexBasis: '100%', borderTop: `1px solid ${T.line2}`, paddingTop: 10, marginTop: 4 }}>
                  <History customerId={c.customer_id} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

interface Profile {
  customer: { rto_count: number; first_order_date: string | null; last_order_date: string | null; stage: string | null };
  orders: Array<{
    order_number: string;
    order_date: string | null;
    current_status: string;
    final_value: string;
    products: string | null;
  }>;
}

/**
 * Her order history, fetched only when asked for.
 *
 * Loading every customer's orders up front would mean one query per row for a
 * panel most of them never open — and at the volume a rep can hold, that is the
 * fan-out this project has already paid for once.
 */
function History({ customerId }: { customerId: string }) {
  const [data, setData] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<Profile>(`/customers/${customerId}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [customerId]);

  if (failed) return <p style={{ ...s.sub, margin: 0, fontSize: 13 }}>Could not load her history just now.</p>;
  if (!data) return <p style={{ ...s.sub, margin: 0, fontSize: 13 }}>Loading her history…</p>;

  if (data.orders.length === 0) {
    return (
      <p style={{ ...s.sub, margin: 0, fontSize: 13 }}>
        No orders yet — so anything she buys would be her first.
      </p>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 5 }}>
      {data.customer.rto_count > 0 && (
        <p style={{ margin: '0 0 4px', fontSize: 13, color: T.clay }}>
          {data.customer.rto_count} parcel(s) came back before. Confirm the address and a working
          number before booking again.
        </p>
      )}
      {data.orders.slice(0, 6).map((o) => (
        <div key={o.order_number} style={{ display: 'flex', gap: 12, fontSize: 13, flexWrap: 'wrap' }}>
          <span style={{ ...s.mono, color: T.faint, minWidth: 92 }}>
            {o.order_date ? new Date(o.order_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'}
          </span>
          <span style={{ ...s.mono, minWidth: 76 }}>₹{fmt(o.final_value)}</span>
          <span style={{ color: o.current_status === 'DELIVERED' ? T.vine : T.muted, minWidth: 110 }}>
            {o.current_status.toLowerCase().replace(/_/g, ' ')}
          </span>
          {o.products && <span style={{ color: T.muted }}>{o.products}</span>}
        </div>
      ))}
      {data.orders.length > 6 && (
        <p style={{ ...s.sub, margin: '4px 0 0', fontSize: 12 }}>
          and {data.orders.length - 6} older order(s)
        </p>
      )}
    </div>
  );
}
