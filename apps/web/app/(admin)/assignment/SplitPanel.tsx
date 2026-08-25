'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Rep } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * SPLIT A BATCH ACROSS THE TEAM, IN ONE ACTION.
 *
 * "Suggested split" has been able to propose a distribution since Phase 1 and
 * could never apply one — the admin read the proposal, then assigned to one rep,
 * changed the dropdown, assigned to the next, five times over, each pass racing
 * the others for the same pool. That is the morning this product replaces.
 *
 * D-02 is what shapes the panel. The proposal fills the boxes; every number is
 * editable and nothing moves until the button is pressed. The algorithm's
 * suggestion and the admin's decision are visibly different things — the
 * suggested figure stays on screen next to the box, so changing one is a choice
 * rather than an overwrite.
 *
 * The running total is the whole interface. An admin distributing four hundred
 * leads needs to know, before pressing anything, whether the numbers add up to
 * what she has — so the header states both, and says which way it is out.
 */

interface Proposal {
  employeeId: string;
  fullName: string;
  leadCount: number;
  reason: string;
}

interface SplitResult {
  ok: boolean;
  message?: string;
  assigned: number;
  shortfall: number;
  perRep: { toEmployeeId: string; asked: number; got: number }[];
}

export function SplitPanel({
  reps, available, leadIds, ageFilter, onDone,
}: {
  reps: Rep[];
  /** How many leads the current filter holds — the real ceiling. */
  available: number;
  /** Ticked rows, if any. Empty means "the whole filter". */
  leadIds: string[];
  ageFilter: string;
  onDone: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState<Record<string, Proposal>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note_, setNote_] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The pool the split will actually draw on: what is ticked, or the whole filter.
  const target = leadIds.length > 0 ? leadIds.length : available;

  const active = useMemo(() => reps.filter((r) => r.status === 'ACTIVE'), [reps]);

  const total = Object.values(counts).reduce((a, v) => a + (Number(v) || 0), 0);
  const over = total > target;
  const spare = target - total;

  async function suggest() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<{ proposal: Proposal[] }>(
        `/assignment/suggested-split?leadCount=${target}`,
      );
      const next: Record<string, string> = {};
      const keep: Record<string, Proposal> = {};
      for (const p of r.proposal) {
        next[p.employeeId] = String(p.leadCount);
        keep[p.employeeId] = p;
      }
      setCounts(next);
      setSuggested(keep);
      if (r.proposal.length === 0) {
        setError('No rep has headroom under her cap right now. Raise a cap in Master Data, or assign fewer.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not work out a split.');
    } finally {
      setLoading(false);
    }
  }

  // Offer a proposal as soon as there is something to distribute — an empty grid
  // of boxes tells an admin nothing about who should get what.
  useEffect(() => {
    if (target > 0 && Object.keys(counts).length === 0) void suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const evenly = () => {
    if (active.length === 0) return;
    const each = Math.floor(target / active.length);
    let spareOnes = target - each * active.length;
    const next: Record<string, string> = {};
    for (const r of active) {
      // Largest remainder by hand: the leftover goes one each to the first few,
      // so the boxes always sum to exactly the target.
      const extra = spareOnes > 0 ? 1 : 0;
      spareOnes -= extra;
      next[r.employee_id] = String(each + extra);
    }
    setCounts(next);
  };

  async function apply() {
    setBusy(true);
    setError(null);
    setNote_(null);
    try {
      const shares = Object.entries(counts)
        .map(([toEmployeeId, v]) => ({ toEmployeeId, leadCount: Number(v) || 0 }))
        .filter((x) => x.leadCount > 0);

      const r = await api.post<SplitResult>('/assignment/split', {
        shares,
        ...(leadIds.length > 0 ? { leadIds } : {}),
        ...(ageFilter ? { filter: { minAgeHours: Number(ageFilter) } } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });

      if (!r.ok) { setError(r.message ?? 'That split could not be made.'); return; }

      const named = r.perRep
        .filter((p) => p.got > 0)
        .map((p) => `${reps.find((x) => x.employee_id === p.toEmployeeId)?.full_name ?? 'rep'} ${p.got}`)
        .join(', ');
      setNote_(
        `Split ${r.assigned} lead${r.assigned === 1 ? '' : 's'}: ${named || 'nobody'}.` +
          // Never hidden. If the pool ran out, that is the thing to know.
          (r.shortfall > 0 ? ` ${r.shortfall} could not be filled — the pool ran out.` : ''),
      );
      setCounts({});
      setSuggested({});
      setNote('');
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That split could not be made.');
    } finally {
      setBusy(false);
    }
  }

  const blocked = busy || total === 0 || over;

  return (
    <section style={s.card} aria-label="Split across the team">
      <div style={s.cardHead}>
        <span>Split across the team</span>
        <span style={s.mono}>
          {total} of {target}
          {over ? ' — too many' : spare > 0 ? ` · ${spare} left over` : ' · exact'}
        </span>
      </div>

      <p style={{ ...s.sub, margin: '0 0 10px', fontSize: 12.5 }}>
        {leadIds.length > 0
          ? `Distributing the ${leadIds.length} you ticked.`
          : `Distributing from the ${available} in this filter, oldest first.`}
      </p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" style={s.btn} onClick={() => void suggest()} disabled={loading}>
          {loading ? 'Working it out…' : 'Suggest a split'}
        </button>
        <button type="button" style={s.btn} onClick={evenly}>Split evenly</button>
        <button type="button" style={s.btn} onClick={() => setCounts({})}>Clear</button>
      </div>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}
      {note_ && <div style={s.notice('ok')}>{note_}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table style={s.table}>
          <caption style={s.srOnly}>How many leads each rep should receive.</caption>
          <thead>
            <tr>
              <th scope="col" style={s.th}>Rep</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Open now</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Cap</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Suggested</th>
              <th scope="col" style={{ ...s.th, textAlign: 'right' }}>Give her</th>
            </tr>
          </thead>
          <tbody>
            {active.map((r) => {
              const open = Number(r.open_leads);
              const headroom = r.wip_cap - open;
              const sug = suggested[r.employee_id];
              const value = counts[r.employee_id] ?? '';
              const asked = Number(value) || 0;
              // A warning, not a block. Caps are guidance and an admin may have a
              // reason; the override is what the pre-assign warnings already say.
              const overCap = asked > headroom;
              return (
                <tr key={r.employee_id}>
                  <td style={s.td}>
                    {r.full_name}
                    {sug && (
                      <span style={{ color: T.faint, fontSize: 11.5, marginLeft: 8 }}>{sug.reason}</span>
                    )}
                  </td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right' }}>{open}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right', color: T.faint }}>{r.wip_cap}</td>
                  <td style={{ ...s.td, ...s.mono, textAlign: 'right', color: T.faint }}>
                    {sug ? sug.leadCount : '—'}
                  </td>
                  <td style={{ ...s.td, textAlign: 'right' }}>
                    <input
                      type="number" min={0} inputMode="numeric"
                      aria-label={`Leads for ${r.full_name}`}
                      value={value}
                      onChange={(e) =>
                        setCounts((c) => ({ ...c, [r.employee_id]: e.target.value }))
                      }
                      style={{
                        ...s.input, width: 90, textAlign: 'right',
                        ...(overCap ? { border: `1px solid ${T.brass}` } : {}),
                      }}
                    />
                    {overCap && (
                      <div style={{ color: T.brass, fontSize: 11, marginTop: 2 }}>
                        {asked - headroom} over her cap
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <label style={{ ...s.label, marginTop: 12 }} htmlFor="split-note">Note (optional)</label>
      <input
        id="split-note" value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="Monday morning Meta batch"
        style={{ ...s.input, maxWidth: 420 }}
      />
      <p style={{ ...s.sub, margin: '6px 0 12px', fontSize: 11.5 }}>
        Saved on every lead&apos;s assignment history, so a month from now the batch is identifiable.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button" onClick={() => void apply()} disabled={blocked}
          style={blocked ? s.btnDisabled : s.btnPrimary}
        >
          {busy ? 'Splitting…' : `Split ${total || ''} ${total === 1 ? 'lead' : 'leads'}`}
        </button>
        <span style={{ fontSize: 12, color: over ? T.clay : T.muted }}>
          {total === 0
            ? 'Give at least one rep a number.'
            : over
              ? `That is ${total - target} more than you have. Lower a number.`
              : spare > 0
                ? `${spare} will stay in the pool.`
                : 'Every lead in this selection will be handed out.'}
        </span>
      </div>
    </section>
  );
}
