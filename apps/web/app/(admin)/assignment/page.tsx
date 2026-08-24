'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clearSelection, emptySelection, isSelected, selectAllInFilter, selectFirstN,
  selectedCount, shiftClick, toAssignRequest, toggle, toggleVisible, type SelectionState,
} from '@razorveda/shared';
import { api, ApiError, type PoolLead, type Rep, type Warning } from '../../../lib/api';
import { s, T } from '../../../lib/ui';
import { MoveWork } from './MoveWork';

/**
 * Lead Assignment — "the most important admin screen" (docs/07 §3).
 *
 * The selection model lives in @razorveda/shared and is covered by 20 unit tests,
 * so shift-click behaviour is proven rather than eyeballed (D-73). This file is
 * the surface: rendering, keyboard access, and the warnings shown before an admin
 * commits.
 *
 * D-02 throughout — nothing here moves a lead without the button.
 */
export default function AssignmentConsole() {
  const [leads, setLeads] = useState<PoolLead[]>([]);
  const [reps, setReps] = useState<Rep[]>([]);
  const [total, setTotal] = useState(0);
  const [selection, setSelection] = useState<SelectionState>(emptySelection());
  const [repId, setRepId] = useState('');
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [split, setSplit] = useState<Array<{ fullName: string; leadCount: number; reason: string }>>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ageFilter, setAgeFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'pool' | 'move'>('pool');

  const load = useCallback(async () => {
    try {
      const query = ageFilter ? `?minAgeHours=${ageFilter}&limit=50` : '?limit=50';
      const r = await api.get<{ total: number; leads: PoolLead[]; reps: Rep[] }>(`/assignment/pool${query}`);
      setLeads(r.leads);
      setReps(r.reps);
      setTotal(r.total);
      if (!repId && r.reps[0]) setRepId(r.reps[0].employee_id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the pool.');
    }
  }, [ageFilter, repId]);

  useEffect(() => { void load(); }, [load]);

  const visibleIds = useMemo(() => leads.map((l) => l.lead_id), [leads]);
  const count = selectedCount(selection, total);
  const selectedIds = useMemo(
    () => visibleIds.filter((id) => isSelected(selection, id)),
    [visibleIds, selection],
  );

  // Warnings are fetched BEFORE assigning, and never block (docs/07 §3).
  useEffect(() => {
    if (!repId || selectedIds.length === 0) { setWarnings([]); return; }
    let cancelled = false;
    api
      .post<{ warnings: Warning[] }>('/assignment/preview', { toEmployeeId: repId, leadIds: selectedIds })
      .then((r) => { if (!cancelled) setWarnings(r.warnings ?? []); })
      .catch(() => { if (!cancelled) setWarnings([]); });
    return () => { cancelled = true; };
  }, [repId, selectedIds]);

  async function loadSplit() {
    try {
      const r = await api.get<{ proposal: Array<{ fullName: string; leadCount: number; reason: string }> }>(
        `/assignment/suggested-split?leadCount=${count || total}`,
      );
      setSplit(r.proposal);
    } catch { setSplit([]); }
  }

  async function assign() {
    setBusy(true);
    setError(null);
    try {
      const request = toAssignRequest(selection);
      const body =
        request.mode === 'IDS'
          ? { toEmployeeId: repId, mode: 'IDS', leadIds: request.leadIds }
          : {
              toEmployeeId: repId,
              mode: 'FILTER',
              excludeLeadIds: request.excludeLeadIds,
              filter: ageFilter ? { minAgeHours: Number(ageFilter) } : {},
            };

      const r = await api.post<{ assigned: number; assignmentRowsWritten: number }>(
        '/assignment/assign',
        // Warnings never block. If the admin proceeded past one, say so on the
        // append-only row rather than in a modal nobody reads.
        warnings.length > 0
          ? { ...body, overrideReason: `Assigned past ${warnings.length} warning(s)` }
          : body,
      );

      const rep = reps.find((x) => x.employee_id === repId)?.full_name ?? 'the rep';
      setNote(`Assigned ${r.assigned} lead${r.assigned === 1 ? '' : 's'} to ${rep}.`);
      setSelection(clearSelection());
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That assignment failed.');
    } finally {
      setBusy(false);
    }
  }

  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => isSelected(selection, id));

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Lead assignment</h1>
      <p style={s.sub}>
        {tab === 'pool'
          ? 'Filter the pool, tick what you want, pick a rep, assign.'
          : 'Take work off one rep and give it to another, or send it back to the pool.'}
      </p>

      {/* Two jobs, not one. Giving out new data and moving somebody's existing
          work look similar and are not: the second takes something away from a
          named person, so it has its own reason field and its own safeguards. */}
      <div style={{ display: 'flex', gap: 6, margin: '0 0 12px' }}>
        {([
          ['pool', 'Unassigned pool'],
          ['move', 'Move work'],
        ] as const).map(([key, label]) => {
          const on = tab === key;
          return (
            <button
              key={key} type="button" aria-pressed={on} onClick={() => setTab(key)}
              style={{
                font: '500 13.5px/1 inherit', padding: '9px 14px', borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${on ? T.text : T.line}`,
                background: on ? T.text : T.card, color: on ? '#fff' : T.text,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {tab === 'move' && <MoveWork onMoved={() => void load()} />}

      {tab === 'pool' && (
      <>
      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note && <div style={s.notice('ok')}>{note}</div>}

      <section style={s.card} aria-label="Filters">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={s.label} htmlFor="age">Older than</label>
            <select id="age" value={ageFilter} onChange={(e) => setAgeFilter(e.target.value)} style={{ ...s.input, width: 150 }}>
              <option value="">Any age</option>
              <option value="24">24 hours</option>
              <option value="48">48 hours</option>
              <option value="72">72 hours</option>
            </select>
          </div>
          <button type="button" style={s.btn} onClick={() => setSelection(selectAllInFilter())}>
            Select all in filter
          </button>
          <button type="button" style={s.btn} onClick={() => setSelection(selectFirstN(visibleIds, 25))}>
            Select first 25
          </button>
          <button type="button" style={s.btn} onClick={() => setSelection(clearSelection())}>Clear</button>
          <button type="button" style={s.btn} onClick={() => void loadSplit()}>Suggested split</button>
        </div>
      </section>

      {split.length > 0 && (
        <section style={s.card} aria-label="Suggested split">
          <div style={s.cardHead}><span>Suggested split · advisory only</span><span /></div>
          <p style={{ ...s.sub, margin: '0 0 8px', fontSize: 12 }}>
            A proposal from current workload and last month&apos;s yield. It never assigns on its own —
            edit it or ignore it.
          </p>
          {split.map((p) => (
            <div key={p.fullName} style={{ fontSize: 13, marginBottom: 3 }}>
              <span style={{ ...s.mono, display: 'inline-block', width: 34 }}>{p.leadCount}</span>
              {p.fullName}
              <span style={{ color: T.faint, fontSize: 11.5, marginLeft: 8 }}>{p.reason}</span>
            </div>
          ))}
        </section>
      )}

      <section style={s.card} aria-label="Unassigned pool">
        <div style={s.cardHead}>
          <span>Unassigned pool</span>
          <span style={s.mono}>
            {total} · {count} selected{selection.allInFilter ? ' (all in filter)' : ''}
          </span>
        </div>

        {leads.length === 0 ? (
          <p style={s.empty}>
            The pool is empty. Upload a file in the Upload Centre and commit it — the leads land here.
          </p>
        ) : (
          <table style={s.table}>
            <caption style={s.srOnly}>
              Unassigned leads. Click a checkbox to select. Shift-click to select a range.
            </caption>
            <thead>
              <tr>
                <th scope="col" style={s.th}>
                  <input
                    type="checkbox" checked={allVisibleSelected}
                    onChange={() => setSelection((st) => toggleVisible(st, visibleIds))}
                    aria-label="Select every row on this page"
                  />
                </th>
                {['Customer', 'Mobile', 'Source', 'Interest', 'State', 'Age'].map((h) => (
                  <th key={h} scope="col" style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => {
                const checked = isSelected(selection, l.lead_id);
                return (
                  <tr key={l.lead_id} style={checked ? { background: '#F6F2E7' } : undefined}>
                    <td style={s.td}>
                      <input
                        type="checkbox" checked={checked} onChange={() => undefined}
                        onClick={(e) =>
                          setSelection((st) =>
                            e.shiftKey ? shiftClick(st, l.lead_id, visibleIds) : toggle(st, l.lead_id),
                          )
                        }
                        aria-label={`Select ${l.full_name ?? 'lead'}`}
                      />
                    </td>
                    <td style={s.td}>{l.full_name ?? <span style={{ color: T.faint }}>Unknown</span>}</td>
                    <td style={{ ...s.td, ...s.mono }}>{l.primary_phone ?? '—'}</td>
                    <td style={s.td}>{l.source}</td>
                    <td style={s.td}>{l.product_interest ?? '—'}</td>
                    <td style={s.td}>{l.state ?? '—'}</td>
                    <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>
                      {l.age_hours}h
                      {l.past_validity && <span style={{ ...s.pill('bad'), marginLeft: 6 }}>expired</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {warnings.length > 0 && (
        <section style={s.notice('warn')} aria-label="Warnings">
          {warnings.map((w) => (
            <p key={w.code} style={{ margin: '0 0 6px' }}>Check: {w.message}</p>
          ))}
          <p style={{ margin: 0, fontSize: 12, color: T.muted }}>
            These do not stop you. If you assign anyway, the override is recorded.
          </p>
        </section>
      )}

      <section style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="rep" style={{ fontSize: 13 }}>Assign to</label>
        <select id="rep" value={repId} onChange={(e) => setRepId(e.target.value)} style={{ ...s.input, width: 220 }}>
          {reps.map((r) => (
            <option key={r.employee_id} value={r.employee_id}>
              {r.full_name}{r.status !== 'ACTIVE' ? ` — ${r.status.toLowerCase().replace('_', ' ')}` : ''}
              {` (${r.open_leads} open)`}
            </option>
          ))}
        </select>
        <button
          type="button" onClick={() => void assign()} disabled={busy || count === 0}
          style={busy || count === 0 ? s.btnDisabled : s.btnPrimary}
        >
          {busy ? 'Assigning…' : `Assign ${count || ''} selected`}
        </button>
        {count === 0 && (
          <span style={{ fontSize: 12, color: T.muted }}>
            Tick some leads first, or use “Select all in filter”.
          </span>
        )}
      </section>
      </>
      )}
    </main>
  );
}
