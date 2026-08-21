'use client';

import { useMemo, useState } from 'react';
import {
  clearSelection,
  emptySelection,
  isSelected,
  selectAllInFilter,
  selectFirstN,
  selectedCount,
  shiftClick,
  toAssignRequest,
  toggle,
  toggleVisible,
  type SelectionState,
} from '@razorveda/shared';

/**
 * Lead Assignment — "the most important admin screen" (docs/07 §3).
 *
 * The selection model lives in @razorveda/shared and is unit tested there, so
 * shift-click behaviour is a test rather than a manual check. This component is
 * the surface: rendering, keyboard access, and the warnings shown before the
 * admin commits.
 *
 * D-02: nothing here assigns automatically. The Suggested Split is advisory and
 * needs a button press.
 */

interface PoolRow {
  leadId: string;
  customerName: string;
  mobile: string;
  source: string;
  interest: string;
  state: string;
  value: string;
  ageHours: number;
}

// Placeholder rows until the API route lands. Shapes match the pool query.
const DEMO_ROWS: PoolRow[] = [
  { leadId: '1', customerName: 'Priyanshi Sharma', mobile: '8076845536', source: 'Shopify', interest: 'Mamo Firm', state: 'UP', value: '3000.00', ageHours: 2 },
  { leadId: '2', customerName: 'Sarfaraj Ahamad', mobile: '6391172210', source: 'Shopify', interest: 'Mamo Plus', state: 'UP', value: '2500.00', ageHours: 5 },
  { leadId: '3', customerName: 'Kumkum Bora', mobile: '8099146825', source: 'Meta Ads', interest: 'Skinwise', state: 'AS', value: '1102.00', ageHours: 26 },
  { leadId: '4', customerName: 'Saloni Kumari', mobile: '7060411385', source: 'Shopify', interest: 'B Reduce', state: 'UP', value: '2500.00', ageHours: 30 },
  { leadId: '5', customerName: 'Mamatha', mobile: '9448812093', source: 'WA Campaign', interest: 'Mamo Firm', state: 'KA', value: '949.00', ageHours: 48 },
];

const REPS = ['Nikita', 'Divya', 'Riya Chauhan', 'Akruti', 'Priti', 'Priyanka', 'Kajal'];

const TOTAL_IN_FILTER = 486;

export default function AssignmentConsole() {
  const [selection, setSelection] = useState<SelectionState>(emptySelection());
  const [rep, setRep] = useState<string>(REPS[0] as string);

  const visibleIds = useMemo(() => DEMO_ROWS.map((r) => r.leadId), []);
  const count = selectedCount(selection, TOTAL_IN_FILTER);

  function onRowClick(e: React.MouseEvent | React.KeyboardEvent, leadId: string) {
    // Shift-click is the spreadsheet gesture reps already know (docs/07 §3).
    setSelection((s) => (e.shiftKey ? shiftClick(s, leadId, visibleIds) : toggle(s, leadId)));
  }

  // Warnings are computed from the selection and shown BEFORE assigning. They
  // never block — an admin who knows something the system does not must be able
  // to proceed, and the override is logged (docs/07 §3).
  const warnings = useMemo(() => {
    const out: string[] = [];
    const ageing = DEMO_ROWS.filter((r) => r.ageHours > 24).length;
    if (rep === 'Kajal') out.push('Kajal already has 120 open leads, over her cap of 100.');
    if (ageing > 0) out.push(`${ageing} leads in the pool are older than 24 hours. Assign these first.`);
    if (count > 60) out.push(`${count} leads is a large batch. Check the split before assigning.`);
    return out;
  }, [rep, count]);

  const allVisibleSelected = visibleIds.every((id) => isSelected(selection, id));

  return (
    <main style={S.page}>
      <h1 style={S.h1}>Lead assignment</h1>

      <section style={S.panel} aria-label="Filters">
        <div style={S.filterRow}>
          {['Source', 'State', 'Product line', 'Received'].map((f) => (
            <label key={f} style={S.filterLabel}>
              {f}
              <select style={S.select} aria-label={f}>
                <option>All</option>
              </select>
            </label>
          ))}
        </div>
        <div style={S.actions}>
          <button type="button" style={S.btn} onClick={() => setSelection(selectAllInFilter())}>
            Select all in filter
          </button>
          <button type="button" style={S.btn} onClick={() => setSelection(selectFirstN(visibleIds, 25))}>
            Select first 25
          </button>
          <button type="button" style={S.btn} onClick={() => setSelection(clearSelection())}>
            Clear
          </button>
        </div>
      </section>

      <section style={S.panel} aria-label="Unassigned pool">
        <header style={S.tableHead}>
          <span>Unassigned pool</span>
          <span style={S.mono}>
            {TOTAL_IN_FILTER} · {count} selected
            {selection.allInFilter ? ' (all in filter)' : ''}
          </span>
        </header>

        <table style={S.table}>
          <caption style={S.srOnly}>
            Unassigned leads. Click a checkbox to select. Shift-click to select a range.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={S.th}>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={() => setSelection((s) => toggleVisible(s, visibleIds))}
                  aria-label="Select all rows on this page"
                />
              </th>
              {['Customer', 'Mobile', 'Source', 'Interest', 'State', 'Value'].map((h) => (
                <th key={h} scope="col" style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DEMO_ROWS.map((row) => {
              const checked = isSelected(selection, row.leadId);
              return (
                <tr key={row.leadId} style={checked ? S.trSelected : undefined}>
                  <td style={S.td}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onClick={(e) => onRowClick(e, row.leadId)}
                      onChange={() => undefined}
                      onKeyDown={(e) => {
                        if (e.key === ' ' || e.key === 'Enter') onRowClick(e, row.leadId);
                      }}
                      aria-label={`Select ${row.customerName}`}
                    />
                  </td>
                  <td style={S.td}>{row.customerName}</td>
                  <td style={{ ...S.td, ...S.mono }}>{row.mobile}</td>
                  <td style={S.td}>{row.source}</td>
                  <td style={S.td}>{row.interest}</td>
                  <td style={S.td}>{row.state}</td>
                  <td style={{ ...S.td, ...S.mono, textAlign: 'right' }}>₹{row.value}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {warnings.length > 0 && (
        <section style={S.warnings} aria-label="Warnings">
          {/* Never colour alone — each line carries the word "Check" (docs/07 §6). */}
          {warnings.map((w) => (
            <p key={w} style={S.warning}>Check: {w}</p>
          ))}
          <p style={S.warningNote}>
            These do not stop you. If you assign anyway, the override is recorded.
          </p>
        </section>
      )}

      <section style={S.assignBar}>
        <label htmlFor="rep">Assign to</label>
        <select id="rep" value={rep} style={S.select} onChange={(e) => setRep(e.target.value)}>
          {REPS.map((r) => <option key={r}>{r}</option>)}
        </select>
        <button
          type="button"
          style={count === 0 ? S.btnPrimaryDisabled : S.btnPrimary}
          disabled={count === 0}
          onClick={() => {
            // The request carries the FILTER plus exclusions when "all in filter"
            // is active, never a list of 486 ids the browser does not hold.
            // eslint-disable-next-line no-console
            console.log('assign', { rep, request: toAssignRequest(selection) });
          }}
        >
          Assign selected
        </button>
        {count === 0 && (
          // Empty states are invitations, not dead ends (docs/07 §5).
          <span style={S.muted}>Tick some leads first, or use “Select all in filter”.</span>
        )}
      </section>
    </main>
  );
}

/** Tokens from design/design-tokens.md. Radius 3px — an operations tool, not an app. */
const S: Record<string, React.CSSProperties> = {
  page: { padding: '24px', color: '#181B24', maxWidth: 1100 },
  h1: { font: '600 20px/1.2 "Barlow Condensed", system-ui', letterSpacing: '1.2px', textTransform: 'uppercase' },
  panel: { background: '#FFFFFF', border: '1px solid #D4D9E0', borderRadius: 3, padding: 12, marginBottom: 12 },
  filterRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  filterLabel: { display: 'flex', flexDirection: 'column', fontSize: 12, color: '#606A7B', gap: 4 },
  select: { border: '1px solid #D4D9E0', borderRadius: 3, padding: '4px 6px', fontSize: 13 },
  actions: { display: 'flex', gap: 8, marginTop: 12 },
  btn: { border: '1px solid #D4D9E0', background: '#FFF', borderRadius: 3, padding: '5px 10px', fontSize: 13, cursor: 'pointer' },
  btnPrimary: { border: '1px solid #14161F', background: '#14161F', color: '#FFF', borderRadius: 3, padding: '6px 14px', fontSize: 13, cursor: 'pointer' },
  btnPrimaryDisabled: { border: '1px solid #D4D9E0', background: '#E7EAEE', color: '#8C95A4', borderRadius: 3, padding: '6px 14px', fontSize: 13, cursor: 'not-allowed' },
  tableHead: { display: 'flex', justifyContent: 'space-between', fontSize: 12, textTransform: 'uppercase', letterSpacing: '1.2px', color: '#606A7B', paddingBottom: 8 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.8 },
  th: { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #D4D9E0', font: '600 11px/1 "Barlow Condensed", system-ui', letterSpacing: '1.2px', textTransform: 'uppercase', color: '#606A7B' },
  td: { padding: '8px 6px', borderBottom: '1px solid #E8EBEF' },
  trSelected: { background: '#F4F1E8' },
  mono: { font: '400 12.8px/1.4 "IBM Plex Mono", ui-monospace, monospace', fontVariantNumeric: 'tabular-nums' },
  warnings: { background: '#FFF', border: '1px solid #C08A1E', borderRadius: 3, padding: 12, marginBottom: 12 },
  warning: { margin: '0 0 6px', fontSize: 13, color: '#181B24' },
  warningNote: { margin: 0, fontSize: 12, color: '#606A7B' },
  assignBar: { display: 'flex', gap: 10, alignItems: 'center', fontSize: 13 },
  muted: { color: '#606A7B', fontSize: 12 },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' },
};
