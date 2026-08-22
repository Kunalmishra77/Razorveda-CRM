'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { s, T } from '../../../lib/ui';

/**
 * Reports & MIS (docs/04).
 *
 * "Nobody prepares a report, ever again." Until now that was true only of the
 * API — every report existed and none of them had a screen, so reading one meant
 * curl. A report an admin cannot open has not replaced a spreadsheet.
 *
 * Rendered generically from whatever columns the API returns, on purpose. The
 * certified views are the single definition of every number (rule 10), and a
 * hand-written column list here would be a second place for them to drift — a
 * report would silently stop showing a column the moment the view gained one.
 *
 * The one thing NOT generic is the self-reported marker. docs/04 requires dials,
 * connects and connectivity to be visibly labelled wherever they appear, because
 * reps dial from their own handsets and those numbers are claimed rather than
 * measured. The API names those columns `*_self_reported`, so the label travels
 * with the data instead of depending on this file remembering.
 */

const REPORTS = [
  { key: 'employee-performance', label: 'Employee Daily Performance', when: 'Daily 21:00' },
  { key: 'sales-register', label: 'Daily Sales Register', when: 'Daily 21:00' },
  { key: 'lead-pool', label: 'Daily Lead Pool', when: 'Daily 08:00' },
  { key: 'dispatch-status', label: 'Dispatch & Status', when: 'Daily 21:00' },
  { key: 'management-one-pager', label: 'Management One-Pager', when: 'Daily 21:00' },
  { key: 'weekly-team-pack', label: 'Weekly Team Pack', when: 'Monday 09:00' },
  { key: 'source-performance', label: 'Source Performance', when: 'Weekly' },
  { key: 'assignment-quality', label: 'Assignment Quality', when: 'Weekly' },
  { key: 'target-comparison', label: 'RTO-Adjusted Targets', when: 'Comparison only' },
] as const;

interface ReportResponse {
  ok: boolean;
  rows?: Record<string, unknown>[];
  caveats?: string[];
  workingDays?: { elapsed: number; remaining: number };
  poolNow?: Record<string, unknown>;
  topRep?: Record<string, unknown> | null;
  topProduct?: Record<string, unknown> | null;
  stuck?: Record<string, unknown>[];
}

export default function ReportsPage() {
  const [reportKey, setReportKey] = useState<string>(REPORTS[0].key);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [data, setData] = useState<ReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await api.get<ReportResponse>(`/reports/${reportKey}?from=${from}&to=${to}`));
    } catch (e) {
      setData(null);
      setError(e instanceof ApiError ? e.message : 'That report could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, [reportKey, from, to]);

  useEffect(() => { void load(); }, [load]);

  /**
   * The export is a real file download, so it cannot go through `api.get` —
   * the response is XLSX bytes, not JSON. Cookies still travel because the
   * request is same-origin with credentials.
   */
  async function exportXlsx() {
    setExporting(true);
    setError(null);
    try {
      const base = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
      const res = await fetch(`${base}/reports/${reportKey}/export?from=${from}&to=${to}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new ApiError(body.message ?? 'The export failed.', res.status);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `razorveda-${reportKey}-${from}-to-${to}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The export failed.');
    } finally {
      setExporting(false);
    }
  }

  const rows = data?.rows ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

  return (
    <main style={s.page}>
      <h1 style={s.h1}>Reports &amp; MIS</h1>
      <p style={s.lede}>
        Every figure comes from the certified views, so a report run for August in
        December returns August. Nothing here is prepared by hand.
      </p>

      <section style={s.card}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 240 }}>
            <label style={s.label} htmlFor="report">Report</label>
            <select id="report" value={reportKey} onChange={(e) => setReportKey(e.target.value)} style={s.input}>
              {REPORTS.map((r) => (
                <option key={r.key} value={r.key}>{r.label} — {r.when}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={s.label} htmlFor="from">From</label>
            <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={s.input} />
          </div>
          <div>
            <label style={s.label} htmlFor="to">To</label>
            <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={s.input} />
          </div>
          <button type="button" onClick={() => void load()} disabled={busy} style={busy ? s.btnDisabled : s.btnPrimary}>
            {busy ? 'Running…' : 'Run'}
          </button>
          <button
            type="button" onClick={() => void exportXlsx()}
            disabled={exporting || rows.length === 0}
            style={exporting || rows.length === 0 ? s.btnDisabled : s.btn}
          >
            {exporting ? 'Building…' : 'Export XLSX'}
          </button>
        </div>
        <p style={{ ...s.hint, marginTop: 10 }}>
          Exports are watermarked with your name and logged. They are not available to the employee role.
        </p>
      </section>

      {error && <div role="alert" style={s.notice('bad')}>{error}</div>}

      {data?.caveats?.map((c) => (
        <div key={c} style={s.notice(/PROVISIONAL|Do not pay|COMPARISON ONLY/i.test(c) ? 'warn' : 'flat')}>
          {c}
        </div>
      ))}

      {data?.workingDays && (
        <p style={s.hint}>
          Working days this month: {data.workingDays.elapsed} elapsed, {data.workingDays.remaining} remaining
          — from the calendar, never hand-typed.
        </p>
      )}

      <section style={s.card}>
        <div style={s.cardHead}>
          <span>{REPORTS.find((r) => r.key === reportKey)?.label}</span>
          <span style={{ color: T.muted, fontSize: 12 }}>{rows.length} row{rows.length === 1 ? '' : 's'}</span>
        </div>

        {busy ? (
          <p style={s.empty}>Running…</p>
        ) : rows.length === 0 ? (
          <p style={s.empty}>
            Nothing in this period. That is a real answer, not a failure — widen the dates if you expected rows.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} scope="col" style={s.th}>
                      {humanise(c)}
                      {isSelfReported(c) && (
                        // docs/04: these are claimed, not measured. The marker is
                        // rendered from the column NAME, so a new self-reported
                        // column is labelled without anyone remembering to add it.
                        <span title="Self-reported by the rep — reps dial from their own handsets"
                              style={{ color: T.brass, marginLeft: 4 }}>*</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c} style={{ ...s.td, ...(isNumeric(row[c]) ? { ...s.mono, textAlign: 'right' } : {}) }}>
                        {render(c, row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {columns.some(isSelfReported) && (
          <p style={{ ...s.hint, marginTop: 10 }}>
            <span style={{ color: T.brass }}>*</span> Self-reported by the rep. Reps dial from their own
            handsets, so these are claimed rather than measured.
          </p>
        )}
      </section>

      {data?.stuck && data.stuck.length > 0 && (
        <section style={s.card}>
          <div style={s.cardHead}><span>Stuck more than 7 days</span><span /></div>
          <table style={s.table}>
            <thead><tr>{Object.keys(data.stuck[0]!).map((c) => <th key={c} scope="col" style={s.th}>{humanise(c)}</th>)}</tr></thead>
            <tbody>
              {data.stuck.map((r, i) => (
                <tr key={i}>{Object.keys(data.stuck![0]!).map((c) => <td key={c} style={s.td}>{String(r[c] ?? '')}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

const SELF_REPORTED = /_self_reported$/;
const isSelfReported = (column: string): boolean => SELF_REPORTED.test(column);

function humanise(key: string): string {
  return key
    .replace(SELF_REPORTED, '')
    .replace(/_/g, ' ')
    .replace(/\bpct\b/i, '%')
    .replace(/\baov\b/i, 'AOV')
    .replace(/\brto\b/i, 'RTO')
    .replace(/\bcd\b/i, 'CD')
    .replace(/\bnd\b/i, 'ND')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const isNumeric = (v: unknown): boolean =>
  typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));

function render(column: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  const text = String(value);
  if (!isNumeric(text)) return text;

  // A ratio column is a fraction in the data and a percentage on screen. Rounded
  // once, here, at the point of display — never in the arithmetic behind it.
  if (/_pct$|^rolling_rto$|^movement_pct$/.test(column)) {
    const n = Number(text);
    return column === 'movement_pct' ? `${n > 0 ? '+' : ''}${n.toFixed(1)}%` : `${(n * 100).toFixed(1)}%`;
  }
  if (/value|amount|target|balance|credit|aov|yield|booking/i.test(column)) {
    return `₹${Number(text).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return Number(text).toLocaleString('en-IN');
}

const today = (): string => new Date().toISOString().slice(0, 10);
const monthStart = (): string => `${new Date().toISOString().slice(0, 7)}-01`;
