'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '../../../../lib/api';
import { s, T } from '../../../../lib/ui';
import { OrderEntry } from './OrderEntry';

/**
 * THE LEAD WORKSPACE — where a rep actually spends her day (docs/07 §4).
 *
 * The full mobile is shown, because reps dial from their own handsets (D-03).
 * That removes prevention and leaves detection and attribution — so Copy writes
 * a pii_access_log row, and the page says so rather than implying a protection
 * the system does not provide (docs/05, "the honest starting position").
 *
 * The shape of this screen is set by one fact: she is holding a phone. Whatever
 * she has to do after the call has to be doable with one thumb and no reading.
 * So the outcomes are buttons, not a dropdown she has to open and scan; Hot /
 * Warm / Cold is three taps wide; and the follow-up date offers the four answers
 * that cover almost every call before it offers a calendar.
 *
 * Two things the form refuses to ask twice:
 *   - whether the customer answered. The disposition already says (counts_as_connect).
 *     Asking again invites the two answers to disagree, and then no report is safe.
 *   - a follow-up date on an outcome that does not need one. "Order done" is
 *     finished; demanding a next-call date on it is how a rep learns to type
 *     rubbish into a required field.
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
  temperature: string | null;
  assigned_at: string | null;
  last_contact_at: string | null;
}

interface History {
  occurred_at: string;
  type: string;
  connected: boolean | null;
  remark_raw: string | null;
  disposition: string | null;
  category: string | null;
  by_employee: string | null;
}

type Temp = 'HOT' | 'WARM' | 'COLD';

const TEMP_TONE: Record<Temp, string> = { HOT: T.clay, WARM: T.brass, COLD: T.indigo };
const TEMP_WHY: Record<Temp, string> = {
  HOT: 'wants it, call back soon',
  WARM: 'interested, needs another push',
  COLD: 'no interest right now',
};

/** The order a rep thinks in: did they pick up, did they not, is it finished. */
const GROUPS: { key: string; title: string; match: (c: string) => boolean }[] = [
  { key: 'connected', title: 'They picked up', match: (c) => c === 'CONNECTED' || c === 'POSITIVE' },
  { key: 'not', title: 'They did not pick up', match: (c) => c === 'NOT_CONNECTED' },
  { key: 'closed', title: 'Finished with this lead', match: (c) => c === 'NEGATIVE' || c === 'CLOSED' },
];

const localInput = (d: Date): string => {
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** Tomorrow at 11am beats "tomorrow at whatever time it is now". */
const inDays = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(11, 0, 0, 0);
  return localInput(d);
};

const dt = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [lead, setLead] = useState<Lead | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [dispositions, setDispositions] = useState<Disposition[]>([]);
  const [dispositionId, setDispositionId] = useState('');
  const [remark, setRemark] = useState('');
  const [followupAt, setFollowupAt] = useState('');
  const [temperature, setTemperature] = useState<Temp | null>(null);
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
        // Derived from the outcome, never asked separately — see the header note.
        connected: chosen?.counts_as_connect ?? false,
        ...(remark ? { remarkRaw: remark } : {}),
        ...(followupAt ? { followupAt: new Date(followupAt).toISOString() } : {}),
        ...(temperature ? { temperature } : {}),
      });
      if (!r.ok) { setError(r.message ?? 'That could not be saved.'); return; }
      setNote(`Saved. That was attempt ${(lead?.contact_attempts ?? 0) + 1} on this lead.`);
      setRemark('');
      setFollowupAt('');
      setDispositionId('');
      setTemperature(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !lead) return <main style={s.page}><div role="alert" style={s.notice('bad')}>{error}</div></main>;
  if (!lead) return <main style={s.page}><p style={s.empty}>Loading…</p></main>;

  const temp = (lead.temperature ?? null) as Temp | null;
  const overdue = lead.next_followup_at ? new Date(lead.next_followup_at) < new Date() : false;
  const attemptNo = lead.contact_attempts + 1;
  const blocked = busy || !dispositionId || (needsFollowup && !followupAt);

  return (
    <main style={s.page}>
      {/* ── who she is about to call, in one line ───────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ ...s.h1, margin: 0 }}>{lead.full_name ?? 'Unknown customer'}</h1>
        {temp && (
          <span style={{
            font: '600 10.5px/1 "Barlow Condensed", sans-serif', textTransform: 'uppercase',
            letterSpacing: '1.2px', color: TEMP_TONE[temp], border: `1px solid ${TEMP_TONE[temp]}`,
            borderRadius: 3, padding: '4px 7px',
          }}>{temp}</span>
        )}
        <Link href="/assigned-leads" style={{ ...s.sub, margin: 0, color: T.muted, marginLeft: 'auto' }}>
          ← Assigned leads
        </Link>
      </div>
      <p style={s.sub}>
        {lead.source}
        {lead.product_interest ? `   ·   ${lead.product_interest}` : ''}
        {'   ·   '}
        {lead.contact_attempts === 0
          ? 'never called'
          : `${lead.contact_attempts} ${lead.contact_attempts === 1 ? 'attempt' : 'attempts'}` +
            (lead.last_contact_at ? `, last on ${dt(lead.last_contact_at)}` : '')}
      </p>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}
      {lead.do_not_call && (
        <div role="alert" style={s.notice('bad')}>
          This customer is marked <strong>do not call</strong>. Do not dial this number.
        </div>
      )}
      {lead.next_followup_at && (
        <div style={s.notice(overdue ? 'bad' : 'flat')}>
          {overdue ? 'You promised to call back on ' : 'You are due to call back on '}
          <strong>{dt(lead.next_followup_at)}</strong>
          {overdue ? ' — that has passed.' : '.'}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 14 }}>
        <div>
          <section style={s.card} aria-label="Contact">
            <div style={s.cardHead}><span>Call her on</span><span /></div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <a
                href={lead.primary_phone ? `tel:${lead.primary_phone}` : undefined}
                style={{ ...s.mono, fontSize: 23, color: T.text, textDecoration: 'none' }}
              >
                {lead.primary_phone ?? 'No number on file'}
              </a>
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

          {/* ── the form, in the order the call happens ─────────────────────── */}
          <section style={s.card} aria-label="Log this call">
            <div style={s.cardHead}>
              <span>Log this call</span>
              <span style={s.pill('flat')}>attempt {attemptNo}</span>
            </div>

            <p style={{ ...s.label, marginTop: 2 }}>1 · What happened?</p>
            {GROUPS.map((g) => {
              const items = dispositions.filter((d) => g.match(d.category));
              if (items.length === 0) return null;
              return (
                <div key={g.key} style={{ marginBottom: 9 }}>
                  <div style={{ color: T.faint, fontSize: 11.5, marginBottom: 4 }}>{g.title}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {items.map((d) => {
                      const on = d.disposition_id === dispositionId;
                      return (
                        <button
                          key={d.disposition_id} type="button"
                          onClick={() => setDispositionId(on ? '' : d.disposition_id)}
                          aria-pressed={on}
                          style={{
                            font: '500 13px/1 inherit', padding: '8px 11px', borderRadius: 4,
                            cursor: 'pointer',
                            border: `1px solid ${on ? T.text : T.line}`,
                            background: on ? T.text : T.card,
                            color: on ? '#fff' : T.text,
                          }}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <p style={{ ...s.label, marginTop: 14 }}>2 · How warm is she?</p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {(['HOT', 'WARM', 'COLD'] as const).map((t) => {
                const on = temperature === t;
                return (
                  <button
                    key={t} type="button" onClick={() => setTemperature(on ? null : t)}
                    aria-pressed={on} title={TEMP_WHY[t]}
                    style={{
                      font: '600 12.5px/1 inherit', padding: '9px 14px', borderRadius: 4, cursor: 'pointer',
                      border: `1px solid ${on ? TEMP_TONE[t] : T.line}`,
                      background: on ? TEMP_TONE[t] : T.card,
                      color: on ? '#fff' : T.muted,
                    }}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            <p style={{ ...s.sub, margin: '6px 0 0', fontSize: 11.5 }}>
              {temperature
                ? TEMP_WHY[temperature]
                : temp
                  ? `Leave it alone to keep this lead ${temp}.`
                  : 'Optional. Set it once you have spoken to her.'}
            </p>

            {needsFollowup && (
              <>
                <p style={{ ...s.label, marginTop: 14 }}>
                  3 · When will you call back? <span style={{ color: T.clay }}>required for “{chosen?.label}”</span>
                </p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 7 }}>
                  {([['Tomorrow', 1], ['In 2 days', 2], ['In 4 days', 4], ['Next week', 7]] as const).map(
                    ([label, days]) => {
                      const v = inDays(days);
                      const on = followupAt === v;
                      return (
                        <button
                          key={label} type="button" onClick={() => setFollowupAt(v)} aria-pressed={on}
                          style={{
                            font: '500 12.5px/1 inherit', padding: '8px 11px', borderRadius: 4, cursor: 'pointer',
                            border: `1px solid ${on ? T.text : T.line}`,
                            background: on ? T.text : T.card, color: on ? '#fff' : T.text,
                          }}
                        >
                          {label}
                        </button>
                      );
                    },
                  )}
                </div>
                <input
                  id="fu" type="datetime-local" value={followupAt}
                  onChange={(e) => setFollowupAt(e.target.value)}
                  style={{ ...s.input, marginBottom: 4 }}
                />
                <p style={{ ...s.sub, margin: '0 0 6px', fontSize: 11.5 }}>
                  Or pick the exact time she asked for.
                </p>
              </>
            )}

            <p style={{ ...s.label, marginTop: 14 }}>
              {needsFollowup ? '4' : '3'} · What did she say?
            </p>
            <textarea
              id="remark" rows={3} value={remark} onChange={(e) => setRemark(e.target.value)}
              placeholder="Write it exactly as she said it — Hinglish is fine. “price zyada lag raha, husband se puchhegi”"
              style={{ ...s.input, marginBottom: 6, resize: 'vertical' }}
            />
            {/* The remark is stored verbatim (D-66). Four months of these become
                the objection intelligence in Phase 6. */}
            <p style={{ ...s.sub, margin: '0 0 12px', fontSize: 11.5 }}>
              Saved exactly as you type it. Nothing is corrected.
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button" onClick={() => void save()} disabled={blocked}
                style={blocked ? s.btnDisabled : s.btnPrimary}
              >
                {busy ? 'Saving…' : `Save attempt ${attemptNo}`}
              </button>
              <span style={{ fontSize: 12, color: T.muted }}>
                {!dispositionId
                  ? 'Pick what happened first.'
                  : needsFollowup && !followupAt
                    ? 'Say when you will call back.'
                    : chosen?.counts_as_connect
                      ? 'Logged as a connected call.'
                      : 'Logged as not connected.'}
              </span>
            </div>
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
            <Row label="Calls on this lead" value={String(lead.contact_attempts)} />
            <Row label="Ever connected" value={lead.ever_connected ? 'Yes' : 'Not yet'} />
            <Row label="Given to you" value={lead.assigned_at ? dt(lead.assigned_at) : '—'} />
            <Row label="Last outcome" value={lead.current_disposition ?? '—'} />
          </section>

          <section style={s.card} aria-label="History">
            <div style={s.cardHead}>
              <span>Every call on this lead</span>
              <span style={s.pill('flat')}>{history.length}</span>
            </div>
            {history.length === 0 ? (
              <p style={s.empty}>Nothing logged yet. Your first call will show here.</p>
            ) : (
              history.map((h, i) => (
                <div key={i} style={{
                  borderBottom: i < history.length - 1 ? `1px solid ${T.line2}` : 0, padding: '7px 0',
                  display: 'flex', gap: 9,
                }}>
                  <span style={{
                    ...s.mono, color: T.faint, fontSize: 11, minWidth: 20, textAlign: 'right', paddingTop: 2,
                  }}>
                    {history.length - i}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5 }}>
                      <span style={{ ...s.mono, color: T.muted, marginRight: 8 }}>{dt(h.occurred_at)}</span>
                      {h.disposition ?? h.type}
                      {h.connected && <span style={{ color: T.vine, marginLeft: 6 }}>answered</span>}
                    </div>
                    {h.remark_raw && (
                      <div style={{ fontSize: 12.5, color: T.muted, marginTop: 2 }}>“{h.remark_raw}”</div>
                    )}
                  </div>
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
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', fontSize: 13 }}>
      <span style={{ color: T.muted }}>{label}</span>
      <span style={{ ...s.mono, color: tone ?? T.text, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
