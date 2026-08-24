'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Rep } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * MOVING WORK THAT IS ALREADY SOMEBODY'S.
 *
 * The pool tab answers "who gets the new data". This one answers the question the
 * client asked for by name and the product could not do: a rep goes on leave, a
 * rep leaves, one is drowning while another has nothing, a lead landed with the
 * wrong person. Reassign, split, move.
 *
 * THREE THINGS THIS SCREEN DOES DIFFERENTLY FROM THE POOL, all for one reason —
 * a transfer takes work AWAY from a named person:
 *
 *   1. NO "select all in filter". The pool has it because assigning 400 unseen
 *      leads to a rep is a normal morning. Taking 400 unseen leads OFF one is
 *      not: selection here is limited to rows the admin can actually see, which
 *      caps a mistake at one screenful.
 *
 *   2. THE REASON IS A REQUIRED FIELD, not an override note. Whoever lost the
 *      leads will ask, and most likely because her incentive moved with them.
 *
 *   3. "Quiet for N days" is the default sort and the most useful band. Untouched
 *      work is what can move without interrupting a conversation already going.
 */

interface AssignedLead {
  lead_id: string;
  full_name: string | null;
  primary_phone: string | null;
  state: string | null;
  source: string;
  product_interest: string | null;
  temperature: string | null;
  contact_attempts: number;
  disposition: string | null;
  next_followup_at: string | null;
  assigned_at: string | null;
  last_contact_at: string | null;
  days_quiet: number | null;
}

const BANDS = [
  { key: '', label: 'All open', hint: 'everything she is holding' },
  { key: 'untouched', label: 'Never called', hint: 'safest to move' },
  { key: 'working', label: 'In progress', hint: 'she has spoken to these' },
  { key: 'overdue', label: 'Overdue follow-up', hint: 'promised and missed' },
  { key: 'stale', label: 'Quiet 7+ days', hint: 'nothing has happened' },
] as const;

const POOL = '__POOL__';

export function MoveWork({ onMoved }: { onMoved?: () => void }) {
  const [reps, setReps] = useState<Rep[]>([]);
  const [fromId, setFromId] = useState('');
  const [band, setBand] = useState('');
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState({ band: '', q: '' });

  const [leads, setLeads] = useState<AssignedLead[]>([]);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const [toId, setToId] = useState(POOL);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Ninety-two rows in one scroll is the wall this product exists to replace
  // (D-303). Thirty is enough to work a screenful and decide; the rest is one
  // click away, and the header always states the real total.
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    if (!fromId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ employeeId: fromId, limit: '100' });
      if (applied.band) params.set('band', applied.band);
      if (applied.q.trim()) params.set('q', applied.q.trim());
      const r = await api.get<{ total: number; leads: AssignedLead[]; reps: Rep[] }>(
        `/assignment/assigned?${params.toString()}`,
      );
      setLeads(r.leads);
      setTotal(r.total);
      setReps(r.reps);
      // A selection that survives a filter change would move rows the admin can
      // no longer see. Dropping it is the safe direction to be wrong in.
      setPicked(new Set());
      setShowAll(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load that rep’s leads.');
    } finally {
      setLoading(false);
    }
  }, [fromId, applied]);

  useEffect(() => { void load(); }, [load]);

  // The rep list arrives with the pool call too; seed the picker before a rep is
  // chosen so the screen is not blank on arrival.
  useEffect(() => {
    if (reps.length > 0) return;
    api
      .get<{ reps: Rep[] }>('/assignment/pool?limit=1')
      .then((r) => {
        setReps(r.reps);
        const first = r.reps.find((x) => Number(x.open_leads) > 0) ?? r.reps[0];
        if (first) setFromId(first.employee_id);
      })
      .catch(() => undefined);
  }, [reps.length]);

  const from = reps.find((r) => r.employee_id === fromId);
  const destinations = useMemo(() => reps.filter((r) => r.employee_id !== fromId), [reps, fromId]);
  const chosen = picked.size;
  const reasonShort = reason.trim().length < 12;
  const blocked = busy || chosen === 0 || reasonShort || !fromId;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const PAGE = 30;
  const visible = showAll ? leads : leads.slice(0, PAGE);
  // "Select all" ticks what is ON SCREEN, never what is merely loaded — a
  // checkbox that silently selects rows behind a collapsed section is how an
  // admin moves work she never saw.
  const allShown = visible.length > 0 && visible.every((l) => picked.has(l.lead_id));

  async function move() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.post<{
        ok: boolean; message?: string; moved: number; skipped: number;
      }>('/assignment/transfer', {
        leadIds: [...picked],
        fromEmployeeId: fromId,
        toEmployeeId: toId === POOL ? null : toId,
        reason: reason.trim(),
      });

      if (!r.ok) { setError(r.message ?? 'That move could not be made.'); return; }

      const where = toId === POOL
        ? 'back to the unassigned pool'
        : `to ${reps.find((x) => x.employee_id === toId)?.full_name ?? 'the other rep'}`;
      // `skipped` is reported, never hidden. A lead that did not move because
      // someone else took it first is exactly what the admin needs to know.
      setNote(
        `Moved ${r.moved} lead${r.moved === 1 ? '' : 's'} ${where}.` +
          (r.skipped > 0
            ? ` ${r.skipped} did not move — already elsewhere, closed or converted.`
            : ''),
      );
      setReason('');
      await load();
      onMoved?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That move could not be made.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}

      <section style={s.card} aria-label="Whose work">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={s.label} htmlFor="from">Take work off</label>
            <select
              id="from" value={fromId} onChange={(e) => setFromId(e.target.value)}
              style={{ ...s.input, width: 260 }}
            >
              <option value="">Choose a rep…</option>
              {reps.map((r) => (
                <option key={r.employee_id} value={r.employee_id}>
                  {r.full_name}
                  {r.status !== 'ACTIVE' ? ` — ${r.status.toLowerCase().replace('_', ' ')}` : ''}
                  {` (${r.open_leads} open)`}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={s.label} htmlFor="q">Name or last 4 digits</label>
            <input
              id="q" value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') setApplied({ band, q }); }}
              style={{ ...s.input, width: 220 }} placeholder="optional"
            />
          </div>
          <button type="button" style={s.btnPrimary} onClick={() => setApplied({ band, q })}>
            Apply
          </button>
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {BANDS.map((b) => {
            const on = b.key === band;
            return (
              <button
                key={b.key || 'all'} type="button" aria-pressed={on} title={b.hint}
                onClick={() => { setBand(b.key); setApplied({ band: b.key, q }); }}
                style={{
                  font: '500 13px/1 inherit', padding: '8px 12px', borderRadius: 4, cursor: 'pointer',
                  border: `1px solid ${on ? T.text : T.line}`,
                  background: on ? T.text : T.card, color: on ? '#fff' : T.text,
                }}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </section>

      <section style={s.card} aria-label="Her leads">
        <div style={s.cardHead}>
          <span>{from ? `${from.full_name} is holding` : 'Choose a rep above'}</span>
          <span style={s.mono}>
            {total} in this filter · showing {leads.length} · {chosen} picked
          </span>
        </div>

        {!fromId ? (
          <p style={s.empty}>Pick a rep to see what she is working on.</p>
        ) : loading ? (
          <p style={s.empty}>Loading her leads…</p>
        ) : leads.length === 0 ? (
          <p style={s.empty}>
            Nothing here. She holds no open leads matching this filter.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <caption style={s.srOnly}>
                Leads currently assigned to this rep. Tick the ones to move.
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={s.th}>
                    <input
                      type="checkbox" checked={allShown}
                      onChange={() =>
                        setPicked(allShown ? new Set() : new Set(visible.map((l) => l.lead_id)))
                      }
                      aria-label="Select every row shown"
                    />
                  </th>
                  {['Customer', 'Mobile', 'Source', 'Temp', 'Tries', 'Last outcome', 'Quiet'].map((h) => (
                    <th key={h} scope="col" style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => {
                  const on = picked.has(l.lead_id);
                  return (
                    <tr key={l.lead_id} style={on ? { background: '#F6F2E7' } : undefined}>
                      <td style={s.td}>
                        <input
                          type="checkbox" checked={on} onChange={() => toggle(l.lead_id)}
                          aria-label={`Select ${l.full_name ?? 'lead'}`}
                        />
                      </td>
                      <td style={s.td}>{l.full_name ?? <span style={{ color: T.faint }}>Unknown</span>}</td>
                      <td style={{ ...s.td, ...s.mono }}>{l.primary_phone ?? '—'}</td>
                      <td style={s.td}>{l.source}</td>
                      <td style={s.td}>
                        {l.temperature
                          ? <span style={{ fontSize: 11.5, color: T.muted }}>{l.temperature.toLowerCase()}</span>
                          : '—'}
                      </td>
                      <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{l.contact_attempts}</td>
                      <td style={s.td}>
                        {l.disposition ?? <span style={{ color: T.faint }}>never called</span>}
                      </td>
                      <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                        {l.days_quiet === null ? '—' : `${l.days_quiet}d`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!showAll && leads.length > PAGE && (
              <button
                type="button" onClick={() => setShowAll(true)}
                style={{ ...s.btn, marginTop: 10 }}
              >
                Show the other {leads.length - PAGE}
              </button>
            )}
            {total > leads.length && (
              <p style={{ ...s.sub, margin: '8px 0 0', fontSize: 12 }}>
                {total - leads.length} more match this filter than were loaded. Narrow it, or move
                these first — you can only move what you can see.
              </p>
            )}
          </div>
        )}
      </section>

      <section style={s.card} aria-label="Where it goes">
        <div style={s.cardHead}><span>Move {chosen > 0 ? `${chosen} selected` : 'the selected leads'}</span><span /></div>

        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 4 }}>
          <div>
            <label style={s.label} htmlFor="to">To</label>
            <select id="to" value={toId} onChange={(e) => setToId(e.target.value)} style={{ ...s.input, width: 260 }}>
              <option value={POOL}>Back to the unassigned pool</option>
              {destinations.map((r) => (
                <option key={r.employee_id} value={r.employee_id}>
                  {r.full_name}
                  {r.status !== 'ACTIVE' ? ` — ${r.status.toLowerCase().replace('_', ' ')}` : ''}
                  {` (${r.open_leads} open)`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label style={{ ...s.label, marginTop: 12 }} htmlFor="reason">
          Why <span style={{ color: T.clay }}>required</span>
        </label>
        <input
          id="reason" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Priya on leave this week · rebalancing, Akruti has 180 open · customer asked for Divya"
          style={{ ...s.input, maxWidth: 620 }}
        />
        <p style={{ ...s.sub, margin: '6px 0 12px', fontSize: 11.5 }}>
          Saved on the lead&apos;s permanent history. The rep losing these will ask, and this is the answer.
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button" onClick={() => void move()} disabled={blocked}
            style={blocked ? s.btnDisabled : s.btnPrimary}
          >
            {busy ? 'Moving…' : `Move ${chosen || ''} ${chosen === 1 ? 'lead' : 'leads'}`}
          </button>
          <span style={{ fontSize: 12, color: T.muted }}>
            {chosen === 0
              ? 'Tick the leads to move.'
              : reasonShort
                ? 'Say why in a few words.'
                : toId === POOL
                  ? 'They go back to the pool for anyone to take.'
                  : 'The receiving rep gets a fresh 48-hour clock.'}
          </span>
        </div>
      </section>
    </>
  );
}
