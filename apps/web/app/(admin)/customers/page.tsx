'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T, statusTone } from '../../../lib/ui';

/**
 * Customer 360 (docs/07 §3).
 *
 * The screen that answers "who is this and what happened last time" before
 * anyone dials. It is the direct replacement for the thing that made the nine
 * spreadsheets unusable: the same customer appeared in up to eight tabs, and
 * nobody could see her whole history in one place (F1).
 *
 * The ORDER of the panels is the argument. What she has bought and what went
 * wrong comes before campaign history, because a rep who is about to call needs
 * last time's RTO more than she needs to know which ad brought the customer in.
 */

interface Summary {
  customer_id: string; full_name: string | null; primary_phone: string | null;
  city: string | null; state: string | null; stage: string;
  lifetime_orders: number; lifetime_value: string; next_due_date: string | null;
}

interface Profile {
  customer: Summary & {
    pincode: string | null; customer_type: string; rto_count: number;
    first_order_date: string | null; last_order_date: string | null;
    do_not_call: boolean; owner: string | null;
  };
  identifiers: { type: string; value: string; is_primary: boolean }[];
  orders: {
    order_number: string; order_date: string; current_status: string; final_value: string;
    payment_mode: string; delivered_date: string | null; rto_date: string | null;
    source: string; rep: string | null; products: string | null;
  }[];
  leads: {
    received_at: string; source: string; assigned_to: string | null;
    is_converted: boolean; closed_at: string | null; contact_attempts: number;
  }[];
  activity: {
    occurred_at: string; type: string; connected: boolean | null;
    remark_raw: string | null; disposition: string | null; by_whom: string | null;
  }[];
}

export default function CustomersPage() {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const search = useCallback(async () => {
    if (term.trim().length < 3) { setResults([]); return; }
    setSearching(true);
    setError(null);
    try {
      setResults((await api.get<{ customers: Summary[] }>(`/customers?q=${encodeURIComponent(term.trim())}`)).customers);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That search failed.');
    } finally {
      setSearching(false);
    }
  }, [term]);

  useEffect(() => {
    if (!selected) { setProfile(null); return; }
    let cancelled = false;
    api.get<Profile>(`/customers/${selected}`)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : 'That customer could not be opened.'); });
    return () => { cancelled = true; };
  }, [selected]);

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Customer 360</h1>
      <p style={s.lede}>
        One person, every order, every lead, every call. The same customer used to appear in up to
        eight tabs with no way to see her whole history at once.
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}

      <section style={s.card}>
        <label style={s.label} htmlFor="q">Search by name or phone number</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="q" value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void search(); }}
            placeholder="Aditi, or 98765"
            style={{ ...s.input, maxWidth: 340 }}
          />
          <button type="button" style={searching ? s.btnDisabled : s.btnPrimary}
                  disabled={searching} onClick={() => void search()}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        <p style={s.hint}>
          You see only customers you have a lead for. Opening a profile shows a full phone number
          and is recorded in the access log.
        </p>

        {results.length > 0 && (
          <table style={{ ...s.table, marginTop: 12 }}>
            <thead><tr>{['Customer', 'Phone', 'Where', 'Stage', 'Orders', 'Lifetime', ''].map((h) => (
              <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
            <tbody>
              {results.map((c) => (
                <tr key={c.customer_id}>
                  <td style={s.td}>{c.full_name ?? '—'}</td>
                  <td style={{ ...s.td, ...s.mono }}>{c.primary_phone ?? '—'}</td>
                  <td style={s.td}>{[c.city, c.state].filter(Boolean).join(', ') || '—'}</td>
                  <td style={s.td}><span style={s.pill('flat')}>{human(c.stage)}</span></td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{c.lifetime_orders}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>₹{money(c.lifetime_value)}</td>
                  <td style={s.td}>
                    <button type="button" style={s.btn} onClick={() => setSelected(c.customer_id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {profile && (
        <>
          <section style={s.card}>
            <div style={s.cardHead}>
              <span>{profile.customer.full_name ?? 'Unnamed customer'}</span>
              <span style={{ display: 'flex', gap: 6 }}>
                {profile.customer.do_not_call && <span style={s.pill('bad')}>do not call</span>}
                <span style={s.pill('flat')}>{human(profile.customer.stage)}</span>
              </span>
            </div>

            {profile.customer.do_not_call && (
              <div style={s.notice('bad')}>
                This customer has asked not to be contacted. She does not enter the repeat queue,
                and she should not be called.
              </div>
            )}

            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
              <Fact label="Phone numbers" value={
                profile.identifiers.length > 0
                  ? profile.identifiers.map((i) => `${i.value}${i.is_primary ? ' (primary)' : ` (${human(i.type)})`}`).join('  ·  ')
                  : (profile.customer.primary_phone ?? 'none on record')} mono />
              <Fact label="Where" value={[profile.customer.city, profile.customer.state, profile.customer.pincode].filter(Boolean).join(', ') || '—'} />
              <Fact label="Owned by" value={profile.customer.owner ?? 'nobody'} />
              <Fact label="Delivered orders" value={String(profile.customer.lifetime_orders)} mono />
              <Fact label="Lifetime value" value={`₹${money(profile.customer.lifetime_value)}`} mono />
              {/* Returns are highlighted only when there ARE returns. A rep
                  about to call needs last time's RTO in front of her. */}
              <Fact label="Returns" value={String(profile.customer.rto_count)} mono
                    {...(profile.customer.rto_count > 0 ? { tone: T.brass } : {})} />
              <Fact label="Due to reorder" value={profile.customer.next_due_date ?? 'not scheduled'} mono />
            </div>
          </section>

          <section style={s.card}>
            <div style={s.cardHead}><span>Orders</span>
              <span style={{ color: T.muted, fontSize: 12 }}>{profile.orders.length}</span></div>
            {profile.orders.length === 0 ? (
              <p style={s.empty}>She has never ordered.</p>
            ) : (
              <table style={s.table}>
                <thead><tr>{['Order', 'Date', 'Products', 'Value', 'Payment', 'Outcome', 'Rep'].map((h) => (
                  <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
                <tbody>
                  {profile.orders.map((o) => (
                    <tr key={o.order_number}>
                      <td style={{ ...s.td, ...s.mono }}>{o.order_number}</td>
                      <td style={{ ...s.td, ...s.mono }}>{date(o.order_date)}</td>
                      <td style={s.td}>{o.products ?? '—'}</td>
                      <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>₹{money(o.final_value)}</td>
                      <td style={s.td}>{human(o.payment_mode)}</td>
                      <td style={s.td}>
                        <span style={s.pill(statusTone(o.current_status))}>{human(o.current_status)}</span>
                        {o.rto_date && (
                          <span style={{ display: 'block', color: T.clay, fontSize: 11, marginTop: 3 }}>
                            returned {date(o.rto_date)}
                          </span>
                        )}
                      </td>
                      <td style={s.td}>{o.rep ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section style={s.card}>
            <div style={s.cardHead}><span>How she has reached us</span>
              <span style={{ color: T.muted, fontSize: 12 }}>{profile.leads.length} lead(s)</span></div>
            {/* The dedupe made visible. One in eight customers appeared in more
                than one tab of the old sheets, and nobody could see it. */}
            <table style={s.table}>
              <thead><tr>{['Arrived', 'Source', 'Assigned to', 'Attempts', 'Outcome'].map((h) => (
                <th key={h} scope="col" style={s.th}>{h}</th>))}</tr></thead>
              <tbody>
                {profile.leads.map((l, i) => (
                  <tr key={i}>
                    <td style={{ ...s.td, ...s.mono }}>{date(l.received_at)}</td>
                    <td style={s.td}>{l.source}</td>
                    <td style={s.td}>{l.assigned_to ?? <span style={{ color: T.muted }}>the pool</span>}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{l.contact_attempts}</td>
                    <td style={s.td}>
                      <span style={s.pill(l.is_converted ? 'ok' : l.closed_at ? 'flat' : 'warn')}>
                        {l.is_converted ? 'converted' : l.closed_at ? 'closed' : 'open'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section style={s.card}>
            <div style={s.cardHead}><span>Every conversation</span>
              <span style={{ color: T.muted, fontSize: 12 }}>{profile.activity.length}</span></div>
            {profile.activity.length === 0 ? (
              <p style={s.empty}>Nobody has spoken to her yet.</p>
            ) : (
              profile.activity.map((a, i) => (
                <div key={i} style={{ borderTop: `1px solid ${T.line2}`, padding: '10px 0' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ ...s.mono, fontSize: 12, color: T.muted }}>{when(a.occurred_at)}</span>
                    <span style={s.pill(a.connected === true ? 'ok' : a.connected === false ? 'flat' : 'flat')}>
                      {human(a.type)}{a.connected === true ? ' · connected' : a.connected === false ? ' · no answer' : ''}
                    </span>
                    {a.disposition && <span style={{ fontSize: 12.5 }}>{a.disposition}</span>}
                    <span style={{ fontSize: 12, color: T.muted }}>{a.by_whom ?? ''}</span>
                  </div>
                  {a.remark_raw && (
                    // Verbatim, in whatever the rep typed. Hinglish remarks are
                    // never rewritten — the raw text is the record (D-66).
                    <p style={{ margin: '4px 0 0', fontSize: 13 }}>{a.remark_raw}</p>
                  )}
                </div>
              ))
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Fact({ label, value, mono, tone }: {
  label: string; value: string; mono?: boolean; tone?: string;
}) {
  return (
    <div>
      <div style={{ color: T.muted, fontSize: 11, letterSpacing: '0.4px' }}>{label.toUpperCase()}</div>
      <div style={{ ...(mono ? s.mono : {}), fontSize: 14, marginTop: 2, color: tone ?? T.text }}>{value}</div>
    </div>
  );
}

const money = (v: string): string =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const human = (v: string): string =>
  v.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const date = (iso: string | null): string => (iso ? String(iso).slice(0, 10) : '—');

const when = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
