'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * ASSIGNED LEADS — everything an admin has given her, and nothing else.
 *
 * My Day decides what to call next. This is for finding something: "the lady from
 * Kolkata who asked about the price", "everyone from Meta this week", "who have I
 * not called at all".
 *
 * WHY THE FILTERS ARE NAMED THIS WAY. A rep does not think in
 * `current_disposition_id` or `is_converted`. She thinks "never called", "waiting
 * on me", "already ordered". The bands below are those sentences; the query
 * behind each is in me.controller.ts.
 *
 * ISOLATION IS THE DATABASE'S JOB. There is no "and assigned_to = me" written in
 * this page, and there is none in the API either — `lead_isolation` decides per
 * row, so a mistake here returns nothing rather than a colleague's list.
 */

interface Lead {
  lead_id: string;
  full_name: string | null;
  primary_phone: string | null;
  city: string | null;
  source: string;
  source_code: string;
  product_interest: string | null;
  temperature: string | null;
  contact_attempts: number;
  ever_connected: boolean;
  next_followup_at: string | null;
  disposition: string | null;
  disposition_category: string | null;
  last_remark: string | null;
  last_contact_at: string | null;
  lifetime_orders: number;
  is_converted: boolean;
  closed_at: string | null;
  predicted_value: string | null;
}

const BANDS = [
  { key: '', label: 'All' },
  { key: 'new', label: 'Never called' },
  { key: 'followup', label: 'Follow-up set' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'working', label: 'In progress' },
  { key: 'converted', label: 'Ordered' },
  { key: 'closed', label: 'Closed' },
] as const;

const SOURCES = [
  ['', 'Any source'], ['SHOPIFY', 'Shopify'], ['META_ADS', 'Meta Ads'],
  ['ADD_TO_CART', 'Add to Cart'], ['WA_CAMPAIGN', 'WhatsApp Campaign'],
  ['WEB_WHATSAPP', 'WhatsApp Marketing'], ['DELIVERED_REPEAT', 'Delivered / Repeat'],
  ['RTO_RECOVERY', 'RTO Recovery'], ['NC_REFUSED', 'NC / Refused'], ['WEB_CALL', 'Website Call'],
] as const;

const TEMP_TONE: Record<string, string> = { HOT: T.clay, WARM: T.brass, COLD: T.indigo };
const CAT_TONE: Record<string, string> = {
  POSITIVE: T.vine, NEGATIVE: T.clay, CONNECTED: T.indigo, NOT_CONNECTED: T.faint, CLOSED: T.brass,
};

const spaced = (p: string | null): string =>
  p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : (p ?? '—');

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
};

export default function AssignedLeads() {
  const [band, setBand] = useState('');
  const [source, setSource] = useState('');
  const [temperature, setTemperature] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState({ band: '', source: '', temperature: '', q: '' });
  const [data, setData] = useState<{ leads: Lead[]; total: number; shown: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (f: typeof applied) => {
    setBusy(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (f.band) p.set('status', f.band);
      if (f.source) p.set('source', f.source);
      if (f.temperature) p.set('temperature', f.temperature);
      if (f.q.trim()) p.set('q', f.q.trim());
      setData(await api.get(`/me/leads?${p.toString()}`));
      setApplied(f);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your leads.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load({ band: '', source: '', temperature: '', q: '' }); }, [load]);

  const apply = () => void load({ band, source, temperature, q });
  const clear = () => {
    setBand(''); setSource(''); setTemperature(''); setQ('');
    void load({ band: '', source: '', temperature: '', q: '' });
  };

  const chips = [
    applied.band && BANDS.find((b) => b.key === applied.band)?.label,
    applied.source && SOURCES.find((x) => x[0] === applied.source)?.[1],
    applied.temperature && `${applied.temperature[0]}${applied.temperature.slice(1).toLowerCase()} leads`,
    applied.q && `“${applied.q}”`,
  ].filter(Boolean) as string[];

  return (
    <main style={s.page}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ ...s.h1, margin: 0 }}>Assigned leads</h1>
        <span style={{ ...s.sub, margin: 0 }}>
          Everything an admin has given you. Nobody else&rsquo;s.
        </span>
      </div>

      <section style={{ ...s.card, marginBottom: 12 }} aria-label="Filters">
        {/* The band is the first thing a rep reaches for, so it is buttons rather
            than a dropdown — one click, and the current one is visible. */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 9 }}>
          {BANDS.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => { setBand(b.key); void load({ band: b.key, source, temperature, q }); }}
              style={{
                ...s.btn,
                ...(band === b.key
                  ? { background: T.ink, color: '#fff', borderColor: T.ink }
                  : {}),
              }}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
            placeholder="Name, or the last 4 digits"
            aria-label="Search your leads"
            style={{ ...s.input, flex: '1 1 220px', maxWidth: 260 }}
          />
          <select value={source} onChange={(e) => setSource(e.target.value)} style={{ ...s.input, width: 'auto' }}>
            {SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={temperature} onChange={(e) => setTemperature(e.target.value)} style={{ ...s.input, width: 'auto' }}>
            <option value="">Any temperature</option>
            <option value="HOT">Hot</option><option value="WARM">Warm</option><option value="COLD">Cold</option>
          </select>
          <button type="button" onClick={apply} disabled={busy} style={busy ? s.btnDisabled : s.btnPrimary}>
            {busy ? 'Finding…' : 'Apply'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <span style={{ font: '600 10.5px/1 "Barlow Condensed", sans-serif', textTransform: 'uppercase', letterSpacing: '1.4px', color: T.muted }}>
            Showing
          </span>
          {chips.length === 0
            ? <span style={{ color: T.faint, fontSize: 12.5 }}>everything</span>
            : chips.map((c) => (
              <span key={c} style={{ ...s.pill('flat'), borderColor: T.indigo, color: T.indigo }}>{c}</span>
            ))}
          {data && (
            <span style={{ color: T.muted, fontSize: 12.5 }}>
              {data.shown} of {data.total} lead{data.total === 1 ? '' : 's'}
            </span>
          )}
          {chips.length > 0 && (
            <button type="button" onClick={clear} style={{ ...s.btn, marginLeft: 'auto' }}>Clear all</button>
          )}
        </div>
      </section>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {!data && !error && <p style={s.empty}>Loading…</p>}

      {data && data.leads.length === 0 && (
        <section style={{ ...s.card, textAlign: 'center', padding: '32px 20px' }}>
          <p style={{ font: '600 16px/1.3 "IBM Plex Sans", sans-serif', margin: '0 0 6px' }}>
            {chips.length ? 'Nothing matches those filters.' : 'You have no leads yet.'}
          </p>
          <p style={{ ...s.sub, margin: 0 }}>
            {chips.length
              ? 'Clear a filter and try again.'
              : 'When an admin assigns you data, it appears here straight away.'}
          </p>
        </section>
      )}

      {data && data.leads.length > 0 && (
        <div style={{ overflowX: 'auto', ...s.card, padding: 0 }}>
          <table style={s.table}>
            <thead>
              <tr>
                {['Customer', 'Mobile', 'Source', 'Interest', 'Last outcome', 'Temp',
                  'Tries', 'Follow-up', 'What they said', ''].map((h) => (
                  <th key={h} scope="col" style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.leads.map((l) => {
                const overdue = l.next_followup_at && new Date(l.next_followup_at) < new Date();
                return (
                  <tr key={l.lead_id}>
                    <td style={s.td}>
                      <Link href={`/leads/${l.lead_id}`} style={{ fontWeight: 500, color: T.text }}>
                        {l.full_name ?? <span style={{ color: T.faint }}>Name not recorded</span>}
                      </Link>
                      {l.lifetime_orders > 0 && (
                        <span style={{ ...s.pill('ok'), fontSize: 10, marginLeft: 6 }}>{l.lifetime_orders}×</span>
                      )}
                      {l.city && <div style={{ color: T.faint, fontSize: 11.5 }}>{l.city}</div>}
                    </td>
                    <td style={{ ...s.td, ...s.mono }}>{spaced(l.primary_phone)}</td>
                    <td style={{ ...s.td, fontSize: 12.5 }}>{l.source}</td>
                    <td style={{ ...s.td, fontSize: 12.5, color: T.muted, maxWidth: 170 }}>
                      {l.product_interest ?? '—'}
                    </td>
                    <td style={s.td}>
                      {l.disposition
                        ? <span style={{
                          ...s.pill('flat'),
                          borderColor: CAT_TONE[l.disposition_category ?? ''] ?? T.faint,
                          color: CAT_TONE[l.disposition_category ?? ''] ?? T.faint,
                        }}>{l.disposition}</span>
                        : <span style={{ color: T.faint, fontSize: 12 }}>never called</span>}
                    </td>
                    <td style={s.td}>
                      {l.temperature
                        ? <span style={{ ...s.pill('flat'), borderColor: TEMP_TONE[l.temperature], color: TEMP_TONE[l.temperature] }}>
                          {l.temperature.toLowerCase()}
                        </span>
                        : <span style={{ color: T.faint }}>—</span>}
                    </td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{l.contact_attempts}</td>
                    <td style={{ ...s.td, ...s.mono, fontSize: 12.5, color: overdue ? T.clay : T.muted }}>
                      {l.next_followup_at
                        ? new Date(l.next_followup_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                        : '—'}
                      {overdue && ' ⚠'}
                    </td>
                    <td style={{ ...s.td, color: T.muted, fontSize: 12.5, maxWidth: 240 }}>
                      {l.last_remark ? `“${l.last_remark}”` : <span style={{ color: T.faint }}>—</span>}
                      <div style={{ color: T.faint, fontSize: 11 }}>{ago(l.last_contact_at)}</div>
                    </td>
                    <td style={s.td}>
                      <Link href={`/leads/${l.lead_id}`} style={{ ...s.btn, textDecoration: 'none', whiteSpace: 'nowrap' }}>
                        Work on it →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > data.shown && (
        <p style={s.hint}>
          Showing the first {data.shown} of {data.total}. Narrow with the filters above rather than scrolling —
          pages are capped so a whole customer list is never sent at once.
        </p>
      )}
    </main>
  );
}
