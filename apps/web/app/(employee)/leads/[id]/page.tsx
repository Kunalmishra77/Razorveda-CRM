'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '../../../../lib/api';
import { s, T } from '../../../../lib/ui';
import { OrderEntry } from './OrderEntry';

/**
 * Lead Detail (docs/07 §4).
 *
 * The full mobile is shown, because reps dial from their own handsets (D-03).
 * That removes prevention and leaves detection and attribution — so Copy writes
 * a pii_access_log row, and the page says so rather than implying a protection
 * the system does not provide (docs/05, "the honest starting position").
 */

interface Disposition {
  disposition_id: string;
  code: string;
  label: string;
  category: string;
  requires_followup_date: boolean;
  counts_as_connect: boolean;
}

interface Lead {
  lead_id: string;
  full_name: string | null;
  primary_phone: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  source: string;
  product_interest: string | null;
  contact_attempts: number;
  ever_connected: boolean;
  lifetime_orders: number;
  lifetime_value: string;
  stage: string;
  rto_count: number;
  do_not_call: boolean;
  current_disposition: string | null;
  closed_at: string | null;
  next_followup_at: string | null;
}

interface History {
  occurred_at: string;
  type: string;
  connected: boolean | null;
  remark_raw: string | null;
  disposition: string | null;
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [lead, setLead] = useState<Lead | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [dispositionId, setDispositionId] = useState('');
  const [remark, setRemark] = useState('');
  const [followupAt, setFollowupAt] = useState('');
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ lead: Lead; history: History[]; dispositions: Disposition[] }>(`/leads/${id}`);
      setLead(r.lead);
      setHistory(r.history);
      setDispositions(r.dispositions);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { router.replace('/login'); return; }
      setError(e instanceof ApiError ? e.message : 'Could not load that lead.');
    }
  }, [id, router]);

  useEffect(() => { void load(); }, [load]);

  const chosen = dispositions.find((d) => d.disposition_id === dispositionId);
  const needsFollowup = chosen?.requires_followup_date ?? false;

  async function copyNumber() {
    if (!lead?.primary_phone) return;
    // Log FIRST, then copy. If the write fails the number is not handed over —
    // an unlogged copy is exactly what the control exists to prevent.
    try {
      await api.post('/pii/copy', { leadId: id, action: 'COPY' });
      await navigator.clipboard.writeText(lead.primary_phone);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Could not record that copy, so the number was not copied. Try again.');
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.post<{ ok: boolean; field?: string; message?: string }>('/activity', {
        leadId: id,
        type: 'CALL',
        dispositionId: dispositionId || null,
        connected,
        ...(remark ? { remarkRaw: remark } : {}),
        ...(followupAt ? { followupAt: new Date(followupAt).toISOString() } : {}),
      });
      if (!r.ok) { setError(r.message ?? 'That could not be saved.'); return; }
      setNote('Saved.');
      setRemark('');
      setFollowupAt('');
      setDispositionId('');
      setConnected(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !lead) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!lead) return <main style={s.page}><p style={s.empty}>Loading…</p></main>;

  return (
    <main style={s.page}>
      <h1 style={s.h1}>{lead.full_name ?? 'Unknown customer'}</h1>
      <p style={s.sub}>
        <Link href="/worklist" style={{ color: T.muted }}>← Worklist</Link>
        {'   ·   '}{lead.source}{lead.product_interest ? `   ·   ${lead.product_interest}` : ''}
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}
      {lead.do_not_call && (
        <div role="alert" style={s.notice('bad')}>
          This customer is marked <strong>do not call</strong>. Do not dial this number.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 14 }}>
        <div>
          <section style={s.card} aria-label="Contact">
            <div style={s.cardHead}><span>Contact</span><span /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ ...s.mono, fontSize: 19 }}>{lead.primary_phone ?? 'No number'}</span>
              {lead.primary_phone && (
                <button type="button" onClick={() => void copyNumber()} style={s.btn}>
                  {copied ? 'Copied' : 'Copy number'}
                </button>
              )}
            </div>
            <p style={{ ...s.sub, margin: '10px 0 0', fontSize: 11.5 }}>
              Every copy is recorded with your name, the time and your IP.
            </p>
            <p style={{ ...s.sub, margin: '6px 0 0', fontSize: 12.5 }}>
              {[lead.city, lead.state, lead.pincode].filter(Boolean).join(' · ') || 'No address on file'}
            </p>
          </section>

          <section style={s.card} aria-label="Log an outcome">
            <div style={s.cardHead}><span>Log an outcome</span><span /></div>

            <label style={s.label} htmlFor="disp">Outcome (required)</label>
            <select
              id="disp" value={dispositionId} onChange={(e) => setDispositionId(e.target.value)}
              style={{ ...s.input, marginBottom: 12 }}
            >
              <option value="">Choose an outcome…</option>
              {dispositions.map((d) => (
                <option key={d.disposition_id} value={d.disposition_id}>{d.label}</option>
              ))}
            </select>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 12 }}>
              <input type="checkbox" checked={connected} onChange={(e) => setConnected(e.target.checked)} />
              The customer answered
            </label>

            {needsFollowup && (
              <>
                <label style={s.label} htmlFor="fu">
                  Follow-up date (required for “{chosen?.label}”)
                </label>
                <input
                  id="fu" type="datetime-local" value={followupAt}
                  onChange={(e) => setFollowupAt(e.target.value)}
                  style={{ ...s.input, marginBottom: 12 }}
                />
              </>
            )}

            <label style={s.label} htmlFor="remark">Remark</label>
            <textarea
              id="remark" rows={3} value={remark} onChange={(e) => setRemark(e.target.value)}
              placeholder="Write it exactly as she said it — Hinglish is fine."
              style={{ ...s.input, marginBottom: 6, resize: 'vertical' }}
            />
            {/* The remark is stored verbatim (D-66). Four months of these become
                the objection intelligence in Phase 6. */}
            <p style={{ ...s.sub, margin: '0 0 12px', fontSize: 11.5 }}>
              Saved exactly as you type it. Nothing is corrected.
            </p>

            <button
              type="button" onClick={() => void save()}
              disabled={busy || !dispositionId || (needsFollowup && !followupAt)}
              style={busy || !dispositionId || (needsFollowup && !followupAt) ? s.btnDisabled : s.btnPrimary}
            >
              {busy ? 'Saving…' : 'Save outcome'}
            </button>
            {!dispositionId && (
              <span style={{ marginLeft: 10, fontSize: 12, color: T.muted }}>
                Choose an outcome first.
              </span>
            )}
          </section>
        </div>

        <div>
          <OrderEntry leadId={id} onBooked={() => void load()} />

          <section style={s.card} aria-label="Customer 360">
            <div style={s.cardHead}><span>Customer</span><span /></div>
            <Row label="Stage" value={lead.stage} />
            <Row label="Delivered orders" value={String(lead.lifetime_orders)} />
            <Row label="Lifetime value" value={`₹${Number(lead.lifetime_value).toLocaleString('en-IN')}`} />
            <Row label="RTOs" value={String(lead.rto_count)} tone={lead.rto_count > 0 ? T.clay : undefined} />
            <Row label="Attempts on this lead" value={String(lead.contact_attempts)} />
            <Row label="Ever connected" value={lead.ever_connected ? 'Yes' : 'Not yet'} />
          </section>

          <section style={s.card} aria-label="History">
            <div style={s.cardHead}><span>Recent activity</span><span /></div>
            {history.length === 0 ? (
              <p style={s.empty}>Nothing logged yet. Your first call will show here.</p>
            ) : (
              history.map((h, i) => (
                <div key={i} style={{ borderBottom: `1px solid ${T.line2}`, padding: '7px 0' }}>
                  <div style={{ fontSize: 12.5 }}>
                    <span style={{ ...s.mono, color: T.muted, marginRight: 8 }}>
                      {new Date(h.occurred_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                    {h.disposition ?? h.type}
                    {h.connected && <span style={{ color: T.vine, marginLeft: 6 }}>answered</span>}
                  </div>
                  {h.remark_raw && (
                    <div style={{ fontSize: 12.5, color: T.muted, marginTop: 2 }}>{h.remark_raw}</div>
                  )}
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string | undefined }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13 }}>
      <span style={{ color: T.muted }}>{label}</span>
      <span style={{ ...s.mono, color: tone ?? T.text }}>{value}</span>
    </div>
  );
}
